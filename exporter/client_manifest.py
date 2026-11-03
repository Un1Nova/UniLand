"""Fingerprint code and recipe inputs, never account data, logs, or saves."""
import argparse
import hashlib
import json
from pathlib import Path


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def build(client):
    files = [client / 'client.jar']
    for folder in ('mods', 'coremods', 'libraries', 'resourcepacks'):
        files += list((client / folder).rglob('*.jar'))
        files += list((client / folder).rglob('*.zip'))
    # Explicit recipe-sync settings. Other config files need individual review.
    files += [client / 'config/MineTweaker3.cfg', client / 'config/scripts_cache.dat']
    files += list((client / 'scripts').rglob('*.zs'))
    entries = [{'path': p.relative_to(client).as_posix(), 'sizeBytes': p.stat().st_size,
                'sha256': digest(p)} for p in sorted(set(files))
               if p.is_file() and p.name != 'uniland-exporter-bootstrap.jar']
    return {'schemaVersion': 1, 'kind': 'local-client-fingerprint',
            'serverSynchronized': False, 'runtimeExport': False,
            'note': 'File hashes identify local inputs; they do not prove server freshness or recipe coverage.',
            'files': entries}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('client', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    manifest = build(args.client.resolve())
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'files': len(manifest['files']), 'sha256': digest(args.output)}))
