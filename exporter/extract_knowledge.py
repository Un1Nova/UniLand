"""Extract shipped guide/wiki sources without claiming runtime applicability."""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path, PurePosixPath


def extract(client, destination):
    client, destination = client.resolve(), destination.resolve()
    if destination.is_relative_to(Path(__file__).resolve().parents[1]):
        raise ValueError('Raw knowledge sources must be outside the public repository')
    entries = []
    archives = sorted((client / 'mods').glob('*.jar'))
    archives += sorted((client / 'resourcepacks').glob('*.zip'))
    for archive in archives:
        with zipfile.ZipFile(archive) as source:
            names = [n for n in source.namelist() if not n.endswith('/') and
                     n.startswith(('assets/luminous/guides/', 'assets/luminous/wiki/'))]
            if not names:
                continue
            with archive.open('rb') as stream:
                archive_hash = hashlib.file_digest(stream, 'sha256').hexdigest()
            for name in names:
                relative = PurePosixPath(name)
                if '..' in relative.parts or relative.is_absolute() or '\\' in name:
                    raise ValueError('Unsafe archive entry')
                data = source.read(name)
                target = destination / archive.stem / Path(*relative.parts)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                entries.append({'archive': archive.name, 'archiveSha256': archive_hash,
                                'resource': name, 'sizeBytes': len(data),
                                'sha256': hashlib.sha256(data).hexdigest(),
                                'localPath': target.relative_to(destination).as_posix()})
    manifest = {'schemaVersion': 1, 'runtimeExport': False, 'serverSynchronized': False,
                'applicability': 'requires runtime mod IDs and active resource-pack precedence',
                'entries': entries}
    destination.mkdir(parents=True, exist_ok=True)
    (destination / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    return {'resources': len(entries),
            'guides': sum('/guides/' in e['resource'] and e['resource'].endswith('.md') for e in entries),
            'wikiPages': sum('/wiki/' in e['resource'] and e['resource'].endswith('.md') for e in entries)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('client', type=Path)
    parser.add_argument('destination', type=Path)
    args = parser.parse_args()
    print(json.dumps(extract(args.client, args.destination)))
