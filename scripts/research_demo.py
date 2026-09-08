#!/usr/bin/env python3
"""Run all three offline skill examples and an exact-asset research handoff."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
from compose_research import compose, read_json

ROOT = Path(__file__).resolve().parents[1]


def run(command):
    result = subprocess.run([sys.executable, *map(str, command)], check=True,
                            capture_output=True, text=True, timeout=60)
    return result.stdout


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', required=True, help='new directory for synthetic reports and journals')
    args = parser.parse_args()
    out = Path(args.out).resolve()
    try:
        out.mkdir(parents=True, exist_ok=False)
        run([ROOT / 'skills/catalyst/scripts/catalyst.py', 'demo', '--out', out / 'catalyst'])
        run([ROOT / 'skills/night-desk/scripts/night_desk.py', 'demo', '--out', out / 'night-desk.json'])
        arena = ROOT / 'skills/agent-arena/scripts/arena.py'
        run([arena, 'journal-init', '--db', out / 'arena.sqlite', '--input',
             ROOT / 'skills/agent-arena/assets/example.json', '--out', out / 'arena-init.json'])
        run([arena, 'journal-report', '--db', out / 'arena.sqlite', '--out', out / 'agent-arena.json'])
        run([arena, 'journal-verify', '--db', out / 'arena.sqlite', '--out', out / 'arena-integrity.json'])
        report = read_json(out / 'night-desk.json')
        bundle = compose(read_json(out / 'catalyst/events.json'), [report], report['as_of'])
        links = sum(len(event['links']) for event in bundle['events'])
        if not links:
            raise ValueError('native skill demos produced no exact-asset handoff')
        (out / 'research-bundle.json').write_text(json.dumps(bundle, indent=2, allow_nan=False) + '\n')
        print(json.dumps({'status': 'SYNTHETIC_DEMO_COMPLETE', 'out': str(out),
                          'event_valuation_links': links, 'network_requests': 0,
                          'live_trades': 0, 'production_application_wired': False}))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        parser.exit(1, 'Research demo failed: ' + str(error) + '\n')


if __name__ == '__main__':
    main()
