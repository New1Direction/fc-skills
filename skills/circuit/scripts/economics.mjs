/** Exact-call accounting. A local fork result is evidence about one simulated state. */
import { validateBuilt, ZERO } from './routes.mjs';
import { validateForkEvidence } from './fork.mjs';
import { validateCostEvidence } from './costs.mjs';
import { digestValue } from './simulation.mjs';

const check = (condition, code) => { if (!condition) throw new TypeError(code); };
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const strict = (value, keys, code) => {
  check(value && typeof value === 'object' && !Array.isArray(value), code);
  check(Object.keys(value).every(key => keys.includes(key)), code);
};
const time = value => { check(Number.isSafeInteger(value) && value >= 0, 'INVALID_AS_OF'); return value; };
const ceilDiv = (n, d) => (n + d - 1n) / d;
const lower = value => value.toLowerCase();

function blankAssessment(built, report, asOf) {
  const route = built.route;
  const currencyOut = route.hops.at(-1).currency_out;
  return {
    schema_version: 'circuit.assessment.v1',
    route_digest: built.route_digest,
    build_digest: built.build_digest,
    fork_evidence_digest: report.evidence_digest,
    transaction_digest: digestValue(built.transaction),
    chain_id: route.chain_id,
    block: structuredClone(route.block),
    adapter: route.adapter,
    wallet: route.wallet,
    recipient: route.recipient,
    wallet_context: route.wallet_context,
    source_mapping: built.call_request.context.source_mapping,
    route_qualification: 'UNVERIFIED_DEPLOYMENT',
    assessed_at: asOf,
    execution_status: report.status,
    status: report.status === 'INCOMPLETE' ? 'INCOMPLETE' : 'SIMULATION_REVERTED',
    route_kind: same(route.currency_in, currencyOut) ? 'same-asset-cycle' : 'open-route',
    currency_in: route.currency_in,
    currency_out: currencyOut,
    amount_in_raw: route.amount_in,
    input_debited_raw: null,
    input_refund_raw: null,
    minimum_out_raw: route.minimum_out,
    amount_out_raw: null,
    amount_out_basis: same(route.currency_in, currencyOut)
      ? 'settled_return_including_any_unspent_input' : 'wallet_output_currency_credit',
    spread_input_raw: null,
    estimated_net_input_raw: null,
    economics: 'UNAVAILABLE',
    wallet_changes: [],
    router_changes: [],
    residuals: [],
    local_execution_gas_wei: null,
    cost: { status: 'MISSING', basis: null, total_native_cost_wei: null, cost_in_input_raw: null },
    issues: ['UNVERIFIED_DEPLOYMENT', ...(route.wallet_context === 'synthetic' ? ['SYNTHETIC_CONTEXT'] : [])],
    blocking_issues: [],
    limitations: [
      'Retained JSON consistency is checked; it does not authenticate the RPC provider or source-to-runtime mapping.',
      'The call executes in a local Anvil next block from the pinned parent state, not on Robinhood Chain.',
      'Only route currencies and native balances at the wallet and router are covered; unrelated assets are not enumerated.',
      'Hook and pool charges already affect wallet balances and are not subtracted a second time.',
      'An estimated positive result is conditional simulation arithmetic, not future executable or realized profit.'
    ]
  };
}

function seal(report) {
  report.issues = [...new Set(report.issues)];
  report.blocking_issues = [...new Set(report.blocking_issues)];
  return { ...report, assessment_digest: digestValue(report) };
}

function applyCost(assessment, built, evidence, asOf) {
  if (evidence === undefined) {
    assessment.issues.push('ROBINHOOD_COST_UNKNOWN');
    return;
  }
  const cost = validateCostEvidence(built, evidence);
  assessment.cost = {
    status: 'PINNED_STATE_ESTIMATE',
    basis: cost.basis,
    method: cost.method,
    observed_at: cost.observed_at,
    expires_at: cost.expires_at,
    total_native_cost_wei: cost.total_native_cost_wei,
    gas_units: cost.gas_units,
    l1_gas_units: cost.l1_gas_units,
    gas_price_wei: cost.gas_price_wei,
    cost_in_input_raw: null,
    conversion: cost.conversion ? structuredClone(cost.conversion) : null,
    evidence_digest: cost.evidence_digest ?? digestValue(cost),
    includes_l1_data_fee: true
  };
  if (asOf < cost.observed_at) {
    assessment.cost.status = 'NOT_YET_OBSERVED';
    assessment.issues.push('COST_ESTIMATE_NOT_YET_OBSERVED');
    return;
  }
  if (asOf > cost.expires_at) {
    assessment.cost.status = 'EXPIRED';
    assessment.issues.push('COST_ESTIMATE_EXPIRED');
    return;
  }
  if (Math.abs(built.route.block.timestamp - cost.observed_at) > 300)
    assessment.issues.push('HISTORICAL_COST_ESTIMATE');
  if (same(built.route.currency_in, ZERO)) {
    assessment.cost.cost_in_input_raw = cost.total_native_cost_wei;
  } else if (cost.conversion) {
    // Round a positive cost up. Conversion is an explicit external valuation assumption.
    assessment.cost.cost_in_input_raw = ceilDiv(BigInt(cost.total_native_cost_wei) *
      BigInt(cost.conversion.numerator_input_raw), BigInt(cost.conversion.denominator_native_wei)).toString();
    assessment.issues.push('EXTERNAL_COST_CONVERSION_ASSUMPTION');
  } else {
    assessment.issues.push('INPUT_COST_CONVERSION_MISSING');
  }
}

/** Validate exact route and fork binding, then assess only observed balances. */
export function assessExecution(input, forkInput, options = {}) {
  strict(options, ['cost_evidence', 'as_of'], 'INVALID_ASSESSMENT_OPTIONS');
  const asOf = time(options.as_of ?? Math.floor(Date.now() / 1000));
  const built = validateBuilt(input);
  const report = validateForkEvidence(forkInput);
  check(digestValue(report.request) === digestValue(built.call_request), 'FORK_ROUTE_BINDING_MISMATCH');
  const assessment = blankAssessment(built, report, asOf);
  applyCost(assessment, built, options.cost_evidence, asOf);
  if (report.status === 'INCOMPLETE') {
    assessment.issues.push('INCOMPLETE_FORK_EVIDENCE');
    assessment.issues.push(...(Array.isArray(report.issues) ? report.issues : []));
    return seal(assessment);
  }

  const route = built.route;
  const localGas = BigInt(report.costs.local_execution_gas_wei);
  assessment.local_execution_gas_wei = localGas.toString();
  const currencies = [...new Set([route.currency_in, ...route.hops.map(hop => hop.currency_out), ZERO].map(lower))];
  const balance = (currency, owner) => {
    const row = same(currency, ZERO)
      ? report.native_balances.find(item => same(item.owner, owner))
      : report.token_balances.find(item => same(item.token, currency) && same(item.owner, owner));
    check(row, 'REQUIRED_BALANCE_MISSING');
    const adjustment = same(currency, ZERO) && same(owner, route.wallet) ? localGas : 0n;
    return {
      currency,
      owner,
      before_raw: row.before_raw,
      after_raw: row.after_raw,
      observed_delta_raw: row.delta_raw,
      local_gas_adjustment_raw: adjustment.toString(),
      economic_delta_raw: (BigInt(row.delta_raw) + adjustment).toString()
    };
  };
  assessment.wallet_changes = currencies.map(currency => balance(currency, route.wallet));
  assessment.router_changes = currencies.map(currency => balance(currency, route.router));
  const walletDelta = currency => BigInt(assessment.wallet_changes.find(row => same(row.currency, currency)).economic_delta_raw);

  // A reverted call still has measurable local gas. It has no successful route output.
  if (report.status === 'FORK_REVERTED_AT_BLOCK') {
    assessment.issues.push('SIMULATION_REVERTED');
    for (const row of [...assessment.wallet_changes, ...assessment.router_changes]) {
      if (BigInt(row.economic_delta_raw) !== 0n) assessment.blocking_issues.push('REVERTED_CALL_BALANCE_ANOMALY');
    }
    return seal(assessment);
  }

  assessment.status = 'SIMULATED';
  if (report.local_block.timestamp < route.block.timestamp || BigInt(report.local_block.timestamp) > BigInt(route.deadline))
    assessment.blocking_issues.push('EXECUTION_TIME_OUTSIDE_ROUTE_WINDOW');
  if (report.expectations.some(item => !item.pass)) assessment.blocking_issues.push('EXPECTATION_FAILED');

  for (const row of assessment.router_changes) {
    if (BigInt(row.economic_delta_raw) !== 0n) {
      assessment.residuals.push({ ...row, location: 'router' });
      assessment.blocking_issues.push(BigInt(row.economic_delta_raw) < 0n ? 'UNEXPECTED_ROUTER_LOSS' : 'ROUTER_RESIDUAL');
    }
  }
  for (const row of assessment.wallet_changes) {
    if (!same(row.currency, route.currency_in) && !same(row.currency, assessment.currency_out) && BigInt(row.economic_delta_raw) !== 0n) {
      assessment.residuals.push({ ...row, location: 'wallet' });
      assessment.blocking_issues.push(BigInt(row.economic_delta_raw) < 0n ? 'UNEXPECTED_WALLET_LOSS' : 'WALLET_RESIDUAL');
    }
  }

  const amountIn = BigInt(route.amount_in);
  const inputDelta = walletDelta(route.currency_in);
  const amountOut = assessment.route_kind === 'same-asset-cycle'
    ? inputDelta + amountIn : walletDelta(assessment.currency_out);
  assessment.amount_out_raw = amountOut.toString();
  if (amountOut < BigInt(route.minimum_out)) assessment.blocking_issues.push('MINIMUM_OUTPUT_NOT_OBSERVED');
  if (assessment.route_kind === 'open-route') {
    assessment.input_debited_raw = (-inputDelta).toString();
    assessment.input_refund_raw = (amountIn + inputDelta).toString();
    if (inputDelta < -amountIn || inputDelta > 0n)
      assessment.blocking_issues.push('INPUT_BALANCE_OUTSIDE_PREPAID_LIMIT');
    else if (inputDelta > -amountIn) assessment.issues.push('PARTIAL_INPUT_REFUND_OBSERVED');
  }

  if (assessment.route_kind === 'same-asset-cycle') assessment.spread_input_raw = inputDelta.toString();
  if (assessment.blocking_issues.length) {
    assessment.status = 'SIMULATED_WITH_BALANCE_ANOMALY';
    assessment.economics = 'UNAVAILABLE_BALANCE_ANOMALY';
  } else if (assessment.route_kind === 'open-route') {
    assessment.economics = 'UNAVAILABLE_UNLIKE_ASSET_UNITS';
    assessment.issues.push('OPEN_ROUTE_HAS_NO_NATIVE_PROFIT_VALUATION');
  } else if (assessment.cost.cost_in_input_raw === null) {
    assessment.economics = 'COST_UNKNOWN';
  } else {
    const net = inputDelta - BigInt(assessment.cost.cost_in_input_raw);
    assessment.estimated_net_input_raw = net.toString();
    assessment.economics = net > 0n ? 'ESTIMATED_POSITIVE_NET' : 'ESTIMATED_NONPOSITIVE_NET';
  }
  return seal(assessment);
}

/** Compare independently validated observations at the same wallet and pinned state. */
export function compareExecutions(entries) {
  check(Array.isArray(entries) && entries.length > 0 && entries.length <= 64, 'INVALID_COMPARISON_ENTRIES');
  check(Buffer.byteLength(JSON.stringify(entries)) <= 32 * 1024 * 1024, 'COMPARISON_TOO_LARGE');
  const defaultAsOf = Math.floor(Date.now() / 1000);
  const assessments = entries.map(entry => {
    strict(entry, ['built', 'fork_report', 'cost_evidence', 'as_of'], 'INVALID_COMPARISON_ENTRY');
    return assessExecution(entry.built, entry.fork_report, {
      ...(entry.cost_evidence !== undefined ? { cost_evidence: entry.cost_evidence } : {}),
      as_of: entry.as_of ?? defaultAsOf
    });
  });
  const first = assessments[0];
  const scope = assessment => ({
    chain_id: assessment.chain_id,
    block: assessment.block,
    wallet: assessment.wallet,
    recipient: assessment.recipient,
    wallet_context: assessment.wallet_context,
    currency_in: assessment.currency_in,
    currency_out: assessment.currency_out,
    route_kind: assessment.route_kind,
    assessed_at: assessment.assessed_at
  });
  check(assessments.every(item => digestValue(scope(item)) === digestValue(scope(first))), 'INCOMPARABLE_EXECUTION_SCOPE');
  check(new Set(assessments.map(item => item.route_digest)).size === assessments.length, 'DUPLICATE_COMPARISON_ROUTE');
  const included = assessments.filter(item => item.estimated_net_input_raw !== null);
  const conversion = item => item.cost.conversion ?? null;
  const conversionMatches = included.every(item => digestValue(conversion(item)) === digestValue(conversion(included[0])));
  const ranked = conversionMatches ? [...included].sort((a, b) => {
    const difference = BigInt(b.estimated_net_input_raw) - BigInt(a.estimated_net_input_raw);
    return difference > 0n ? 1 : difference < 0n ? -1 : a.route_digest.localeCompare(b.route_digest);
  }) : [];
  const rankedIds = new Set(ranked.map(item => item.route_digest));
  const body = {
    schema_version: 'circuit.comparison.v1',
    scope: scope(first),
    status: !ranked.length ? 'NO_COMPARABLE_NET_ESTIMATES'
      : ranked.length < assessments.length ? 'PARTIAL_ESTIMATED_COMPARISON' : 'ESTIMATED_COMPARISON',
    ranking_metric: 'estimated_absolute_net_in_input_raw_units',
    ranked: ranked.map((item, index) => ({ rank: index + 1, route_digest: item.route_digest,
      amount_in_raw: item.amount_in_raw, estimated_net_input_raw: item.estimated_net_input_raw })),
    excluded: assessments.filter(item => !rankedIds.has(item.route_digest)).map(item => ({
      route_digest: item.route_digest,
      reason: !conversionMatches && item.estimated_net_input_raw !== null ? 'INCOMPARABLE_COST_CONVERSION' : item.economics
    })),
    assessments,
    limitations: [
      'Ranking covers only supplied routes and sizes; it does not establish an optimal size, return on capital, or future execution.',
      'Missing or expired cost evidence is excluded, never treated as zero.',
      'Different output assets, wallets, contexts, blocks, or assessment times cannot be combined.'
    ]
  };
  return { ...body, comparison_digest: digestValue(body) };
}
