#!/usr/bin/env python3
"""Combine Undertow price and flow research without upgrading evidence or inventing a score."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
from attribution import analyze_attribution
from flows import analyze_flows
from stock_reference import strict_json, stamp


def fingerprint(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def join_scope(payload, result, flows_payload, flows_report):
    if not flows_payload:
        return ['NO_FLOW_INPUT']
    if not result.get('local_attribution'):
        return ['ATTRIBUTION_UNAVAILABLE']
    reasons=[]
    if stamp(result['as_of']).timestamp() != flows_report['knowledge_cutoff']:
        reasons.append('DIFFERENT_KNOWLEDGE_CUTOFF')
    times=[stamp(x['timestamp']).timestamp() for x in result['local_attribution']['snapshots']]
    if min(times)<flows_report['window']['start'] or max(times)>flows_report['window']['end']:
        reasons.append('ATTRIBUTION_OUTSIDE_FLOW_WINDOW')
    headers={x['block_number']:(x['block_hash'].lower(),stamp(x['timestamp']).timestamp())
             for x in result['local_attribution']['snapshots']}
    for event in flows_payload['swaps']:
        if event.get('canonical') is not True or event['known_at']>flows_report['knowledge_cutoff']:
            continue
        height=event['block_number']; header=(event['block_hash'].lower(),event['timestamp'])
        if height in headers and headers[height]!=header:
            reasons.append('BLOCK_IDENTITY_OR_TIME_DISAGREEMENT')
        else:
            headers[height]=header
    ordered=sorted(headers.items())
    if any(b[1][1]<a[1][1] for a,b in zip(ordered,ordered[1:])):
        reasons.append('BLOCK_TIME_ORDER_DISAGREEMENT')
    identity=result['identity'];p=identity['pool']
    matches=[x for x in flows_payload['pools'] if x['manager'].lower()==p['manager'] and x['pool_id'].lower()==p['pool_id']]
    if len(matches)!=1:
        reasons.append('POOL_MISSING_FROM_FLOW_REGISTRY')
    else:
        f=matches[0]
        pairs=(('token0','currency0'),('token1','currency1'),('fee','fee'),('tick_spacing','tick_spacing'),('hook','hooks'))
        if any(str(p[a]).lower()!=str(f[b]).lower() for a,b in pairs):
            reasons.append('POOL_KEY_DISAGREEMENT')
        if f['known_at']>flows_report['knowledge_cutoff']:
            reasons.append('POOL_NOT_KNOWN_BY_CUTOFF')
    flow_assets={k.lower():v for k,v in flows_payload['assets'].items()}
    for role,kind in (('meme','meme'),('quote','stock')):
        asset=identity[role];f=flow_assets.get(asset['address'])
        if f is None or f['decimals']!=asset['decimals'] or f['kind']!=kind:
            reasons.append('ASSET_UNIT_OR_IDENTITY_DISAGREEMENT')
        elif f['known_at']>flows_report['knowledge_cutoff']:
            reasons.append('ASSET_NOT_KNOWN_BY_CUTOFF')
    return sorted(set(reasons))


def analyze_research(attribution_payloads, flows_payload=None):
    if not isinstance(attribution_payloads,list) or len(attribution_payloads)>100:
        raise ValueError('attributions must be a list of at most100 inputs')
    if not attribution_payloads and flows_payload is None:
        raise ValueError('at least one analysis input is required')
    attribution_reports=[analyze_attribution(p) for p in attribution_payloads]
    flow_report=analyze_flows(flows_payload) if flows_payload is not None else None
    rows=[]
    for i,(payload,result) in enumerate(zip(attribution_payloads,attribution_reports)):
        identity=result.get('identity',{})
        meme=identity.get('meme',{}).get('address')
        local=result.get('local_attribution') or {}
        reasons=join_scope(payload,result,flows_payload,flow_report)
        flow=None
        if not reasons:
            flow=next((r for r in flow_report['assets'] if r['asset']==meme),None)
            if flow is None: reasons.append('ASSET_MISSING_FROM_FLOW_REPORT')
        rows.append({'attribution_input_index':i,'meme':meme,
                     'pool':identity.get('pool'), 'attribution_status':result['status'],
                     'mark_quality':result.get('mark_quality'),
                     'meme_quote_return_pct':local.get('meme_quote_return_pct'),
                     'quote_usd_return_pct':local.get('quote_usd_return_pct'),
                     'meme_usd_return_pct':local.get('meme_usd_return_pct'),
                     'join_status':'SCOPES_ALIGNED' if not reasons else 'NOT_JOINED',
                     'join_issues':reasons, 'asset_wide_participation':flow if not reasons else None,
                     'participation_scope':'All retained registered pools for this asset, not only the attribution pool.' if not reasons else None,
                     'qualifies_as_signal':False})
    evidence_modes=[p.get('evidence_mode','unspecified') if isinstance(p,dict) else 'unspecified'
                    for p in attribution_payloads]
    flow_label=flows_payload.get('dataset_label') if flows_payload is not None else None
    synthetic='synthetic' in evidence_modes or (isinstance(flow_label,str) and 'synthetic' in flow_label.lower())
    return {'schema':'undertow.research-report.v1','chain_id':4663,
            'status':'RESEARCH_ONLY','comparison_rows':rows,
            'contains_declared_synthetic_data':synthetic,
            'evidence_declarations':{'attributions':evidence_modes,'flows_dataset_label':flow_label},
            'input_manifest':{'attribution_sha256':[fingerprint(p) for p in attribution_payloads],
                              'flows_sha256':fingerprint(flows_payload) if flows_payload is not None else None},
            'attribution_reports':attribution_reports,'flow_report':flow_report,
            'profitability_established':False,
            'limitations':['Input hashes identify the supplied artifacts; they do not authenticate a provider or prove prior knowledge.',
                           'Scope alignment is an identity/time join, not a verification of wallet attribution, completeness, or causal demand.',
                           'Price marks are not executable proceeds. Wallet-swap deltas are not full wallet balances, fresh chain capital, or profit.',
                           'Comparison rows preserve input order; no investment ranking or predictive score is computed.']}


def markdown(report):
    lines=['# Undertow — Robinhood Chain research','',
           '**Synthetic demonstration; not an observed market opportunity.**' if report['contains_declared_synthetic_data'] else 'Supplied evidence; consult component provenance and coverage.', '',
           'Price attribution and supplied flow evidence. No profitable signal is established.','',
           '| Meme | Relative to quote | Quote in USD | Meme in USD | Attribution | Flow join |',
           '| --- | ---: | ---: | ---: | --- | --- |']
    def percent(x): return 'Unknown' if x is None else format(__import__('decimal').Decimal(x),'.4f')+'%'
    for r in report['comparison_rows']:
        token=r['meme']
        label=(token[:8]+'…'+token[-4:]) if token else 'Unresolved'
        if token and not report['contains_declared_synthetic_data']:
            label=f'[{label}](https://robinhoodchain.blockscout.com/address/{token})'
        lines.append('| '+' | '.join([label,percent(r['meme_quote_return_pct']),percent(r['quote_usd_return_pct']),
                                      percent(r['meme_usd_return_pct']),r['attribution_status'],r['join_status']])+' |')
    for i,r in enumerate(report['comparison_rows']):
        lines.extend(['',f'## Observation {i+1}',''])
        if r['join_issues']: lines.append('Flow join withheld: '+', '.join(r['join_issues'])+'.')
        if r.get('asset_wide_participation'):
            f=r['asset_wide_participation']
            lines.append(f"Across the registered asset scope: {f['net_buy_wallets']} wallets had net-buy transactions and {f['net_sell_wallets']} had net-sell transactions. A wallet can appear in both counts.")
            lines.append(f"Window coverage: {f['window_coverage']}; newly observed buyers versus baseline: {f['newly_observed_buyers_vs_baseline'] if f['newly_observed_buyers_vs_baseline'] is not None else 'unknown'}.")
        a=report['attribution_reports'][i]
        lines.append('Mark qualification: '+str(a.get('mark_quality','unavailable'))+'.')
        for issue in a.get('issues',[])+a.get('qualification_issues',[]):
            lines.append('- '+str(issue.get('code','UNKNOWN'))+' at '+str(issue.get('path','input'))+'.')
    flow=report['flow_report']
    if flow:
        lines.extend(['','## Observed rotation and shared quotes','',
                      f"{len(flow['rotation_links'])} rotation hypotheses; {len(flow['shared_quote_topology'])} quote-token groups. These do not establish proceeds funding, covariance, or exit capacity.",
                      f"Included swaps: {flow['input_counts']['included_swap_records']}; quarantined transactions: {flow['input_counts']['quarantined_transactions']}."])
        for group in flow['shared_quote_topology']:
            lines.append(f"- {group['quote_asset']}: {group['meme_count']} meme assets in {group['pool_count']} registered pools.")
    lines.extend(['','## Evidence limits',''])
    lines.extend('- '+x for x in report['limitations'])
    lines.append('')
    return '\n'.join(lines)


def read_input(path):
    p=Path(path)
    if p.stat().st_size>16_000_000: raise ValueError('input exceeds16MB')
    return strict_json(p.read_text())


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--attribution', action='append', default=[])
    p.add_argument('--flows')
    p.add_argument('--out',required=True)
    p.add_argument('--markdown')
    a=p.parse_args()
    try:
        report=analyze_research([read_input(x) for x in a.attribution],read_input(a.flows) if a.flows else None)
        report['report_created_at']=datetime.now(timezone.utc).isoformat()
        report['creation_time_meaning']='Actual report creation, not proof of an earlier alert.'
        Path(a.out).parent.mkdir(parents=True,exist_ok=True)
        Path(a.out).write_text(json.dumps(report,indent=2,sort_keys=True,allow_nan=False)+'\n')
        if a.markdown:
            Path(a.markdown).parent.mkdir(parents=True,exist_ok=True)
            Path(a.markdown).write_text(markdown(report))
    except (ValueError,TypeError,KeyError,OSError) as exc:
        p.exit(2,f'Research unavailable: {exc}\n')


if __name__=='__main__': main()
