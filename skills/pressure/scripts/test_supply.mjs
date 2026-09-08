import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateDataset, analyzeSupply, ZERO, V4_MANAGER } from './supply.mjs';

const fixture = JSON.parse(readFileSync(new URL('../assets/supply.synthetic.json', import.meta.url), 'utf8'));
const data = () => structuredClone(fixture);
const unit = x => (BigInt(x) * 10n ** 18n).toString();
const hash = x => `0x${BigInt(x).toString(16).padStart(64, '0')}`;
const issuer = fixture.snapshots.start.balances[0].address;
const rawSum = rows => rows.reduce((sum, row) => sum + BigInt(row.balance_raw), 0n);
function exactEqual(a, b) { assert.equal(BigInt(a.numerator) * BigInt(b.denominator), BigInt(b.numerator) * BigInt(a.denominator)); }

test('synthetic mint, burn, self-transfer, and multiplier reconcile in exact base units', () => {
  const input = data(), before = JSON.stringify(input), r = analyzeSupply(input);
  assert.equal(r.status, 'RECONCILED_WINDOW'); assert.equal(r.evidence_mode, 'synthetic');
  assert.equal(r.supply.observed_minted_raw, unit(1000)); assert.equal(r.supply.observed_burned_raw, unit(100));
  assert.equal(r.supply.net_issuance_raw, unit(900)); assert.equal(r.supply.end_raw, unit(10900));
  assert.ok(r.tracked_balances.every(x => x.reconciled)); assert.equal(r.supply.zero_amount_events, 1);
  assert.equal(JSON.stringify(input), before);
});
test('symmetric multiplier decomposition is exact and does not add minted tokens', () => {
  const r = analyzeSupply(data()).display_adjusted_supply;
  exactEqual(r.start, { numerator: '10000', denominator: '1' }); exactEqual(r.end, { numerator: '21800', denominator: '1' });
  exactEqual(r.raw_supply_change_component, { numerator: '1350', denominator: '1' });
  exactEqual(r.multiplier_change_component, { numerator: '10450', denominator: '1' });
  const a = r.raw_supply_change_component, b = r.multiplier_change_component;
  exactEqual(r.change, { numerator: (BigInt(a.numerator)*BigInt(b.denominator)+BigInt(b.numerator)*BigInt(a.denominator)).toString(), denominator:(BigInt(a.denominator)*BigInt(b.denominator)).toString() });
});
test('decomposition retains sub-unit fractions and negative multiplier changes', () => {
  const d = data(); d.snapshots.start.multiplier_raw = '3'; d.snapshots.end.multiplier_raw = '1';
  const r = analyzeSupply(d).display_adjusted_supply;
  assert.ok(BigInt(r.change.numerator) < 0n); assert.ok(BigInt(r.change.denominator) > 1n);
  const a = r.raw_supply_change_component, b = r.multiplier_change_component;
  exactEqual(r.change, { numerator:(BigInt(a.numerator)*BigInt(b.denominator)+BigInt(b.numerator)*BigInt(a.denominator)).toString(), denominator:(BigInt(a.denominator)*BigInt(b.denominator)).toString() });
});
test('tracked self transfers leave net balances unchanged', () => {
  const r = analyzeSupply(data()).tracked_balances.find(x => x.address === issuer);
  assert.equal(r.self_transfer_raw, unit(50)); assert.equal(r.net_flow_raw, unit(200));
  assert.equal(r.incoming_raw, unit(1200)); assert.equal(r.outgoing_raw, unit(1000));
});
test('mint-recipient followup reports wallet flows rather than fungible minted provenance', () => {
  const r = analyzeSupply(data()).mint_recipient_followup[0];
  assert.equal(r.start_balance_raw, unit(2000)); assert.equal(r.observed_outgoing_after_first_mint_raw, unit(1000));
  assert.equal(r.subsequent_observed_destinations.find(x => x.address === V4_MANAGER).observed_outgoing_raw, unit(600));
  assert.equal(r.subsequent_observed_destinations.find(x => x.address === ZERO).scope, 'observed_burn');
  assert.match(r.interpretation, /prevent identifying those transfers as the minted units/);
  assert.equal(r.minted_units_reaching_venue, undefined);
});
test('direct mint receipt is separate from subsequent wallet destinations', () => {
  const r = analyzeSupply(data());
  assert.equal(r.direct_mint_destinations.length, 1); assert.equal(r.direct_mint_destinations[0].address, issuer);
  assert.equal(r.direct_mint_destinations[0].minted_directly_raw, unit(1000));
});
test('disjoint measured distribution exposes unmeasured balances without estimating free float', () => {
  const r = analyzeSupply(data()).distribution.end;
  assert.equal(r.measured_address_balances_raw, unit(6900)); assert.equal(r.unmeasured_address_balances_raw, unit(4000));
  assert.equal(rawSum(r.buckets), BigInt(r.measured_address_balances_raw));
  assert.equal(r.buckets.find(x => x.category === 'unknown').balance_raw, unit(450));
  assert.equal(r.free_float, undefined);
});
test('canonical V4 manager is always labeled aggregate rather than a pool reserve', () => {
  const r = analyzeSupply(data());
  assert.equal(r.tracked_balances.find(x => x.address === V4_MANAGER).scope, 'v4_manager_aggregate_not_pool_inventory');
  assert.equal(r.distribution.end.buckets.find(x => x.category === 'venue').addresses[0].scope, 'v4_manager_aggregate_not_pool_inventory');
});
test('stale and future labels are unknown at actual observation time', () => {
  const d = data(); d.attributions[1].valid_from_block = 102;
  const r = analyzeSupply(d);
  assert.equal(r.mint_recipient_followup[0].subsequent_observed_destinations.find(x => x.address === V4_MANAGER).attribution.category, 'unknown');
  assert.equal(r.tracked_balances.find(x => x.address === V4_MANAGER).attribution_start.category, 'unknown');
  assert.equal(r.tracked_balances.find(x => x.address === V4_MANAGER).attribution_end.category, 'venue');
});
test('nonoverlapping address labels can change without double counting balances', () => {
  const d = data(); d.attributions[1].valid_to_block = 102;
  d.attributions.push({...d.attributions[1], category:'custody', label:'Changed label', valid_from_block:103, valid_to_block:104});
  const r = analyzeSupply(d).distribution;
  assert.equal(r.start.buckets.find(x => x.category === 'venue').balance_raw, unit(500));
  assert.equal(r.end.buckets.find(x => x.category === 'venue').balance_raw, '0');
  assert.equal(rawSum(r.end.buckets), BigInt(unit(6900)));
});
test('untracked mint recipients do not acquire invented opening balances', () => {
  const d = data(); for (const side of ['start','end']) d.snapshots[side].balances.shift();
  assert.equal(analyzeSupply(d).mint_recipient_followup[0].start_balance_raw, null);
});
test('partial or unrechecked evidence cannot qualify issuance or no-mint absence', () => {
  for (const change of [d => d.coverage.complete = false, d => d.coverage.canonical_rechecked = false]) {
    const d = data(); change(d); const r = analyzeSupply(d);
    assert.equal(r.status, 'PARTIAL_WINDOW'); assert.equal(r.supply.net_issuance_raw, null);
    assert.equal(r.coverage.absence_claim_supported_within_supplied_evidence, false);
    assert.equal(r.supply.observed_minted_raw, unit(1000));
  }
});
test('event-query completeness claims remain distinguished from receipt enumeration', () => {
  const d = data(); d.coverage.method = 'log_query';
  assert.ok(analyzeSupply(d).issues.includes('COMPLETENESS_DEPENDS_ON_SUPPLIED_OR_LOG_QUERY_CLAIM'));
});
test('snapshot supply discrepancy is retained and prevents net issuance qualification', () => {
  const d = data(); d.snapshots.end.total_supply_raw = unit(10901); const r = analyzeSupply(d);
  assert.equal(r.status, 'RECONCILIATION_FAILED'); assert.equal(r.supply.reconciliation_difference_raw, unit(1));
  assert.equal(r.supply.net_issuance_raw, null);
});
test('tracked balance discrepancy independently blocks qualification', () => {
  const d = data(); d.snapshots.end.balances[0].balance_raw = unit(2201); const r = analyzeSupply(d);
  assert.equal(r.supply.reconciled, true); assert.equal(r.status, 'RECONCILIATION_FAILED');
  assert.ok(r.issues.includes('TRACKED_BALANCE_RECONCILIATION_MISMATCH'));
});
test('measured disjoint balances cannot exceed observed supply', () => {
  const d = data(); d.snapshots.start.balances[0].balance_raw = unit(20000); d.snapshots.end.balances[0].balance_raw = unit(20200);
  const r = analyzeSupply(d); assert.equal(r.status, 'RECONCILIATION_FAILED'); assert.equal(r.distribution.end.unmeasured_address_balances_raw, null);
});
test('changed or unrecognized code prevents interpreting events as verified token semantics', () => {
  for (const side of ['start','end']) { const d = data(); d.snapshots[side].code_hash = hash(998); const r = analyzeSupply(d); assert.equal(r.status, 'SEMANTICS_UNVERIFIED'); assert.equal(r.supply.net_issuance_raw, null); }
});
test('case-insensitive identities reconcile', () => {
  const d = data(); d.snapshots.end.balances[1].address = '0x'+V4_MANAGER.slice(2).toUpperCase();
  assert.equal(analyzeSupply(d).status, 'RECONCILED_WINDOW');
});
test('start block events are excluded from an end-of-block baseline', () => {
  const d = data(); d.transfers[0].block_number = 100; d.transfers[0].block_hash = hash(100);
  assert.throws(() => analyzeSupply(d), /\(start,end\]/);
});
test('removed or fabricated block hashes cannot attach events to the window', () => {
  const d = data(); d.transfers[0].block_hash = hash(123);
  assert.throws(() => validateDataset(d), /canonical matching header/);
});
test('zero-to-zero events reject ambiguous issuance', () => {
  const d = data(); d.transfers[0].to = ZERO; assert.throws(() => validateDataset(d), /zero-to-zero/);
});
test('duplicate and misordered event identities are rejected', () => {
  const duplicate = data(); duplicate.transfers.splice(1,0,structuredClone(duplicate.transfers[0]));
  assert.throws(() => validateDataset(duplicate), /duplicate|canonical log order/);
  const reversed = data(); reversed.transfers.reverse(); assert.throws(() => validateDataset(reversed), /canonical log order/);
});
test('block log indices cannot run backward even when transaction indices increase', () => {
  const d = data(); d.transfers[1].log_index = 0; assert.throws(() => validateDataset(d), /canonical log order/);
});
test('one transaction cannot claim inconsistent block positions', () => {
  const d = data(); d.transfers[2].transaction_hash = d.transfers[0].transaction_hash;
  assert.throws(() => validateDataset(d), /inconsistent positions/);
});
test('different transactions cannot occupy the same transaction index', () => {
  const d = data(); d.transfers[1].transaction_index = 0;
  assert.throws(() => validateDataset(d), /same block position/);
});
test('multiple transfer logs within the same transaction remain valid', () => {
  const d = data(); d.transfers[1].transaction_index = 0; d.transfers[1].transaction_hash = d.transfers[0].transaction_hash;
  assert.equal(analyzeSupply(d).status, 'RECONCILED_WINDOW');
});
test('broken header ancestry is rejected', () => {
  const d = data(); d.headers[2].parent_hash = hash(9999); assert.throws(() => validateDataset(d), /parent chain/);
});
test('repeated block hashes across heights are rejected', () => {
  const d = data(); d.headers[2].hash = d.headers[1].hash; assert.throws(() => validateDataset(d), /duplicate/);
});
test('complete coverage cannot have missing receipts or headers', () => {
  const d = data(); d.coverage.missing_blocks = [102]; assert.throws(() => validateDataset(d), /complete coverage/);
  const e = data(); e.headers.splice(2,1); assert.throws(() => validateDataset(e), /complete coverage/);
});
test('a legitimate empty observation window retains measured supply and multiplier change', () => {
  const d = data(); d.transfers = []; d.snapshots.end = structuredClone(d.snapshots.start); d.snapshots.end.multiplier_raw = unit(2);
  const r = analyzeSupply(d); assert.equal(r.status, 'RECONCILED_WINDOW'); assert.equal(r.supply.observed_minted_raw, '0');
  exactEqual(r.display_adjusted_supply.multiplier_change_component, {numerator:'10000',denominator:'1'});
});
test('same-block snapshots represent no elapsed observation and cannot support time-window absence', () => {
  const d = data(); d.window.end = structuredClone(d.window.start); d.headers = [d.headers[0]]; d.transfers = []; d.snapshots.end = structuredClone(d.snapshots.start);
  const r = analyzeSupply(d); assert.equal(r.status, 'EMPTY_WINDOW'); assert.equal(r.supply.observed_minted_raw, '0'); assert.equal(r.coverage.absence_claim_supported_within_supplied_evidence, false);
});
test('partial missing header windows retain only available events and no absence claim', () => {
  const d = data(); d.headers.splice(2,1); d.transfers = d.transfers.filter(t=>t.block_number!==102); d.coverage.complete = false; d.coverage.missing_blocks=[102];
  const r = analyzeSupply(d); assert.equal(r.coverage.accounting_complete_for_supplied_evidence, false); assert.equal(r.supply.net_issuance_raw,null);
});
test('overlapping attribution intervals reject double interpretation', () => {
  const d = data(); d.attributions.push({...d.attributions[0], category:'custody'});
  assert.throws(() => validateDataset(d), /overlapping attribution/);
});
test('attribution without supporting references rejects labels', () => {
  const d = data(); d.attributions[0].evidence_refs = []; assert.throws(() => validateDataset(d), /evidence reference/);
});
test('different tracked address sets reject fake balance reconciliation', () => {
  const d = data(); d.snapshots.end.balances.pop(); assert.throws(() => validateDataset(d), /address sets differ/);
});
test('duplicate tracked address casing cannot double count balance distribution', () => {
  const d = data(); d.snapshots.start.balances.push({...d.snapshots.start.balances[0]});
  assert.throws(() => validateDataset(d), /duplicate address/);
});
test('canonical uint256 parsing rejects floating, exponent, signed, leading-zero and oversized inputs', () => {
  for (const value of [1, '1e18', '-1', '01', '1.0', String(1n<<256n), 'Infinity', null]) {
    const d = data(); d.transfers[0].amount_raw = value; assert.throws(() => validateDataset(d), /uint256 decimal/);
  }
});
test('invalid chain, window, multiplier, and block representation are rejected', () => {
  for (const modify of [d=>d.chain_id=1,d=>d.window.end.number=99,d=>d.snapshots.start.multiplier_raw='0',d=>d.headers[0].number=1.1,d=>d.window.start.hash='0x12',d=>d.token.decimals=37]) {
    const d=data(); modify(d); assert.throws(() => validateDataset(d), /Invalid PRESSURE dataset/);
  }
});
test('bounded deterministic mint/burn conservation handles values above floating precision', () => {
  for (let i=1n;i<=24n;i++) {
    const d=data(), initial=10n**30n+i, mint=10n**25n+17n*i, burn=10n**23n+3n*i;
    d.snapshots.start.total_supply_raw=initial.toString();d.snapshots.end.total_supply_raw=(initial+mint-burn).toString();
    d.snapshots.start.balances=[{address:issuer,balance_raw:initial.toString()}];d.snapshots.end.balances=[{address:issuer,balance_raw:(initial+mint-burn).toString()}];
    d.transfers=[{...d.transfers[0],amount_raw:mint.toString()},{...d.transfers[4],amount_raw:burn.toString()}];
    const r=analyzeSupply(d);assert.equal(r.status,'RECONCILED_WINDOW');assert.equal(r.supply.net_issuance_raw,(mint-burn).toString());assert.equal(r.distribution.end.unmeasured_address_balances_raw,'0');
  }
});
