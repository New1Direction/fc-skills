#!/usr/bin/env python3
"""Verify the exported skill files; optionally run each independent offline suite."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def verify():
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    if manifest.get('schema') != 'msk.package.v1':
        raise ValueError('unsupported manifest')
    expected = set()
    names = set()
    for skill in manifest['skills']:
        name = skill['name']
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', name) or name in names:
            raise ValueError('invalid or duplicate skill name')
        names.add(name)
        if skill['path'] != 'skills/' + name or skill['tests'] not in ('scripts', 'tests'):
            raise ValueError('invalid skill path or suite')
        for entry in skill['files']:
            rel = Path(entry['path'])
            if rel.is_absolute() or '..' in rel.parts or rel.parts[:2] != ('skills', name):
                raise ValueError('invalid manifest file path')
            if entry['path'] in expected:
                raise ValueError('duplicate manifest file path')
            expected.add(entry['path'])
            path = ROOT / rel
            if path.is_symlink() or not path.is_file():
                raise ValueError('missing or symlinked skill file: ' + str(rel))
            data = path.read_bytes()
            if len(data) != entry['bytes'] or hashlib.sha256(data).hexdigest() != entry['sha256']:
                raise ValueError('skill file differs from export: ' + str(rel))
        if not (ROOT / skill['path'] / 'SKILL.md').is_file():
            raise ValueError('missing skill entrypoint')
    actual = {p.relative_to(ROOT).as_posix() for p in (ROOT / 'skills').rglob('*')
              if p.is_file() and '__pycache__' not in p.parts and p.suffix not in ('.pyc', '.pyo')}
    if actual != expected:
        raise ValueError('manifest and exported skill file set disagree')
    print(f'Verified {len(names)} skills and {len(expected)} exported files.', flush=True)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--tests', action='store_true')
    args = parser.parse_args()
    try:
        manifest = verify()
        if args.tests:
            total = 0
            env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1')
            for skill in manifest['skills']:
                result = subprocess.run([sys.executable, '-m', 'unittest', 'discover',
                    '-s', skill['tests'], '-p', 'test_*.py'], cwd=ROOT / skill['path'],
                    env=env, capture_output=True, text=True, timeout=180)
                output = result.stdout + result.stderr
                count = re.search(r'Ran (\d+) tests?\b', output)
                if result.returncode or count is None or int(count[1]) == 0:
                    print(output, file=sys.stderr)
                    raise ValueError('suite failed or had no tests: ' + skill['name'])
                total += int(count[1])
                print(f"{skill['name']}: {count[1]} tests passed", flush=True)
            print(f'Total: {total} offline tests passed; live performance is unverified.')
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
        parser.exit(1, f'Package verification failed: {exc}\n')


if __name__ == '__main__':
    main()
