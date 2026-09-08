#!/usr/bin/env python3
"""Retain current Robinhood REST references; never turn them into historical oracle proof."""
import argparse
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import json
from pathlib import Path
import re
import urllib.request

BASE = 'https://api.robinhood.com/rhj/'
SCHEMA = 'undertow.stock-reference.v1'
LIMIT = 4_000_000


def strict_json(raw):
    def pairs(rows):
        out = {}
        for k, v in rows:
            if k in out:
                raise ValueError('duplicate JSON key')
            out[k] = v
        return out
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda x: (_ for _ in ()).throw(ValueError('nonfinite JSON')))


def stamp(value):
    if not isinstance(value, str):
        raise ValueError('timestamp must be timezone-aware string')
    d = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if d.tzinfo is None:
        raise ValueError('timestamp needs timezone')
    return d.astimezone(timezone.utc)


def addr(value):
    if not isinstance(value, str) or not re.fullmatch(r'0x[0-9a-fA-F]{40}', value):
        raise ValueError('invalid token address')
    if int(value, 16) == 0:
        raise ValueError('zero token address')
    return value.lower()


def decimal(value):
    if not isinstance(value, str) or len(value) > 120:
        raise ValueError('amount must be bounded decimal string')
    try:
        d = Decimal(value)
    except InvalidOperation:
        raise ValueError('invalid decimal') from None
    if not d.is_finite() or d <= 0 or abs(d.adjusted()) > 100:
        raise ValueError('amount must be positive finite decimal')
    return d


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def deployed(row, token):
    matches = [d for d in row.get('deployments', [])
               if type(d.get('chainId')) is int and d['chainId'] == 4663]
    if len(matches) != 1:
        return False
    return addr(matches[0]['contractAddress']) == token


def unique(rows, predicate, label):
    found = [r for r in rows if predicate(r)]
    if len(found) != 1:
        raise ValueError('need exactly one matching ' + label)
    return found[0]


def normalize(bundle):
    if bundle.get('schema') != SCHEMA or type(bundle.get('chain_id')) is not int or bundle['chain_id'] != 4663:
        raise ValueError('unsupported reference schema or chain')
    token = addr(bundle['token'])
    symbol = bundle['symbol']
    if not isinstance(symbol, str) or not re.fullmatch(r'[A-Z0-9.-]{1,20}', symbol):
        raise ValueError('invalid symbol')
    age = bundle['max_server_age_seconds']
    if type(age) is not int or not 1 <= age <= 3600:
        raise ValueError('invalid freshness policy')
    records = bundle['responses']
    if len(records) != 3:
        raise ValueError('need assets-before, prices, assets-after')
    expected = [BASE+'assets', BASE+'prices/'+symbol, BASE+'assets']
    parsed, stamps = [], []
    for record, url in zip(records, expected):
        if record['url'] != url or type(record['http_status']) is not int or record['http_status'] != 200:
            raise ValueError('invalid retained response endpoint/status')
        raw = record['body_utf8']
        if not isinstance(raw, str) or len(raw.encode()) > LIMIT:
            raise ValueError('invalid response body')
        if hashlib.sha256(raw.encode()).hexdigest() != record['body_sha256']:
            raise ValueError('response hash mismatch')
        start, end = stamp(record['requested_at']), stamp(record['received_at'])
        if start > end or (stamps and start < stamps[-1][1]):
            raise ValueError('response ordering invalid')
        parsed.append(strict_json(raw))
        stamps.append((start, end))
    before = unique(parsed[0]['assets'], lambda x: x.get('tokenSymbol') == symbol and deployed(x, token), 'asset')
    after = unique(parsed[2]['assets'], lambda x: x.get('tokenSymbol') == symbol and deployed(x, token), 'asset')
    quote = unique(parsed[1]['quotes'], lambda x: x.get('tokenSymbol') == symbol and deployed(x, token), 'quote')
    for asset in (before, after):
        if asset.get('status') != 'ASSET_STATUS_ACTIVE' or not isinstance(asset.get('id'), str) or not asset['id']:
            raise ValueError('inactive or unidentified asset')
    fields = ('id', 'currentMultiplier', 'pendingMultiplier', 'pendingMultiplierEffectiveTime', 'status')
    if any(canonical(before.get(k)) != canonical(after.get(k)) for k in fields):
        raise ValueError('asset metadata changed during capture')
    if quote.get('currency') != 'USD' or type(quote.get('isTradingHalt')) is not bool:
        raise ValueError('quote must identify USD and explicit halt state')
    bid, ask, mult = decimal(quote['bid']), decimal(quote['ask']), decimal(after['currentMultiplier'])
    if bid > ask:
        raise ValueError('crossed bid/ask')
    generated = stamp(quote['generatedAt'])
    server_age = (stamps[-1][1] - generated).total_seconds()
    if generated > stamps[1][1] or server_age > age:
        raise ValueError('future or stale server-generated reference')
    pending = after.get('pendingMultiplier')
    if not isinstance(pending, str):
        raise ValueError('pending multiplier must explicitly be a decimal string or empty string')
    if pending == '' and after.get('pendingMultiplierEffectiveTime') not in (None, ''):
        raise ValueError('empty pending multiplier has contradictory effective time')
    if pending:
        decimal(pending)
        if stamp(after['pendingMultiplierEffectiveTime']) <= stamps[-1][1]:
            raise ValueError('pending multiplier effective during/before capture')
    with localcontext() as ctx:
        ctx.prec = 100
        normalized_bid, normalized_ask = format(bid*mult, 'f'), format(ask*mult, 'f')
    warnings = [
        'REST currentMultiplier is not block-pinned historical multiplier evidence.',
        'generatedAt is server generation time; it does not prove the underlying market observation is fresh.',
        'Read-only reference bid/ask is not an executable onchain quote or guaranteed redemption value.',
        'No open market session, oracle pause state, or primary-market access is established.',
        'Hashes establish retained-content consistency, not independent source authenticity.'
    ]
    if quote['isTradingHalt']:
        warnings.append('Underlying trading halt is reported; reject current actionable reference use.')
    if pending:
        warnings.append('A pending multiplier change requires block-specific reconciliation.')
    return {'status': 'HALTED_REFERENCE' if quote['isTradingHalt'] else 'REFERENCE_CANDIDATE',
            'chain_id': 4663, 'token': token, 'symbol': symbol, 'underlying_id': after['id'],
            'raw_equity_bid_usd': quote['bid'], 'raw_equity_ask_usd': quote['ask'],
            'observed_current_multiplier': after['currentMultiplier'],
            'indicative_token_bid_usd': normalized_bid, 'indicative_token_ask_usd': normalized_ask,
            'generated_at': quote['generatedAt'], 'observed_at': records[-1]['received_at'],
            'historical_attribution_qualified': False, 'is_trading_halt': quote['isTradingHalt'],
            'trading_capabilities': after.get('tradingCapabilities'), 'warnings': warnings}


def verify(bundle):
    normalized = normalize(bundle)
    if 'normalized' in bundle and canonical(bundle['normalized']) != canonical(normalized):
        raise ValueError('normalized reference differs from retained source')
    return normalized


def fetch(url):
    before = datetime.now(timezone.utc).isoformat()
    req = urllib.request.Request(url, headers={'User-Agent': 'Undertow/0.1 read-only research', 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=15) as response:
        if response.geturl() != url:
            raise ValueError('unexpected endpoint redirect')
        body = response.read(LIMIT+1)
        if len(body) > LIMIT:
            raise ValueError('response too large')
        return {'url': url, 'http_status': response.status, 'requested_at': before,
                'received_at': datetime.now(timezone.utc).isoformat(),
                'body_utf8': body.decode('utf-8'), 'body_sha256': hashlib.sha256(body).hexdigest()}


def collect(symbol, token, max_age=60, fetcher=fetch):
    token = addr(token)
    if not re.fullmatch(r'[A-Z0-9.-]{1,20}', symbol):
        raise ValueError('invalid symbol')
    bundle = {'schema': SCHEMA, 'chain_id': 4663, 'symbol': symbol, 'token': token,
              'max_server_age_seconds': max_age,
              'responses': [fetcher(BASE+'assets'), fetcher(BASE+'prices/'+symbol), fetcher(BASE+'assets')]}
    bundle['normalized'] = normalize(bundle)
    return bundle


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest='mode', required=True)
    c = sub.add_parser('collect')
    c.add_argument('--symbol', required=True)
    c.add_argument('--token', required=True)
    c.add_argument('--max-server-age-seconds', type=int, default=60)
    c.add_argument('--out', required=True)
    v = sub.add_parser('verify')
    v.add_argument('--input', required=True)
    v.add_argument('--out', required=True)
    args = p.parse_args()
    try:
        if args.mode == 'collect':
            result = collect(args.symbol, args.token, args.max_server_age_seconds)
        else:
            path = Path(args.input)
            if path.stat().st_size > 4*LIMIT:
                raise ValueError('input too large')
            result = verify(strict_json(path.read_text()))
        Path(args.out).write_text(json.dumps(result, indent=2, allow_nan=False)+'\n')
    except (ValueError, KeyError, TypeError, OSError) as exc:
        p.exit(2, f'Reference unavailable: {type(exc).__name__}: {exc}\n')


if __name__ == '__main__':
    main()
