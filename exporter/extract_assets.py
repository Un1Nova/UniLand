"""Preserve shipped textures, translations and book sources with exact archive provenance."""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path, PurePosixPath


def extract(client, destination):
    client, destination = client.resolve(), destination.resolve()
    if destination.is_relative_to(Path(__file__).resolve().parents[1]):
        raise ValueError('Raw assets belong outside the public repository')
    archives = [client / 'client.jar']
    for folder in ('mods', 'resourcepacks'):
        archives.extend(sorted((client / folder).glob('*.jar')))
        archives.extend(sorted((client / folder).glob('*.zip')))
    rows, blobs = [], set()
    for archive in archives:
        with zipfile.ZipFile(archive) as source:
            for info in source.infolist():
                name = info.filename
                if info.is_dir() or not name.startswith('assets/'):
                    continue
                path = PurePosixPath(name)
                if path.is_absolute() or '..' in path.parts or '\\' in name:
                    raise ValueError('Unsafe resource path')
                if not (path.suffix.lower() in ('.png', '.mcmeta', '.lang') or
                        any(word in name.lower() for word in ('/guides/', '/wiki/', '/lexicon/', '/books/', '/manual/', '/research/'))):
                    continue
                data = source.read(info)
                digest = hashlib.sha256(data).hexdigest()
                relative = f'blobs/{digest[:2]}/{digest}{path.suffix.lower()}'
                target = destination / relative
                if relative not in blobs:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_bytes(data)
                    blobs.add(relative)
                rows.append({'archive': archive.relative_to(client).as_posix(), 'resource': name,
                             'sha256': digest, 'sizeBytes': len(data), 'file': relative})
    destination.mkdir(parents=True, exist_ok=True)
    manifest = {'schemaVersion': 1, 'kind': 'source-resources', 'precedence': 'variants preserved; runtime resource manager determines active override', 'entries': rows}
    (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'resources': len(rows), 'uniqueFiles': len(blobs), 'png': sum(x['resource'].endswith('.png') for x in rows)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('client', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(extract(args.client, args.destination)))
