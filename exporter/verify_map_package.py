"""Verify cross-file references and source hashes, then optionally create a portable ZIP."""
import argparse
import hashlib
import json
import shutil
import zipfile
from pathlib import Path
from PIL import Image
from build_map_data import load, save, walk


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify(package, archive=False):
    package = package.resolve()
    issues = []
    def local(name):
        path = (package / name).resolve()
        if not path.is_relative_to(package) or not path.is_file():
            raise ValueError('Missing or unsafe package path: ' + name)
        return path
    items = load(package / 'items.json')
    recipes = load(package / 'recipes.json')
    quests = load(package / 'quests.json')
    pages = load(package / 'pages.json')
    sections = load(package / 'page-sections.json')
    nodes = set()
    for name, records in [('items', items), ('recipes', recipes), ('quests', quests), ('pages', pages), ('sections', sections)]:
        ids = [x['id'] for x in records]
        if len(ids) != len(set(ids)):
            issues.append({'kind': 'duplicate-id', 'collection': name})
        nodes.update(ids)
    item_ids = {x['id'] for x in items}
    for item in items:
        path = local(item['icon'])
        with Image.open(path) as img:
            img.load()
            if img.size != (64, 64):
                issues.append({'kind': 'invalid-icon-size', 'itemId': item['id']})
            transparent = img.convert('RGBA').getchannel('A').getbbox() is None
            if transparent != (item['iconKind'] == 'runtime-transparent'):
                issues.append({'kind': 'incorrect-transparency-classification', 'itemId': item['id']})
    graph = load(package / 'graph.json')
    for edge in graph['edges']:
        if edge['from'] not in nodes or edge['to'] not in nodes:
            issues.append({'kind': 'broken-graph-edge', 'edge': edge})
    for source in load(package / 'registry-sources.json'):
        for value in walk(load(local(source['file'])).get('data')):
            if isinstance(value, dict) and value.get('$type') == 'stack' and value['itemId'] not in item_ids:
                issues.append({'kind': 'missing-native-item', 'itemId': value['itemId'], 'source': source['source']})
    for recipe in recipes:
        for source in recipe['sources']:
            local(source['file'])
    checked = set()
    for directory, manifest_file, field in [('source-assets', 'manifest.json', 'file'), ('source-knowledge', 'manifest.json', 'localPath'), ('raw/knowledge-runtime', 'manifest.json', 'file'), ('raw', 'script-classes.json', 'file')]:
        manifest = load(local(directory + '/' + manifest_file))
        entries = manifest['entries'] if isinstance(manifest, dict) else manifest
        for entry in entries:
            path = local(directory + '/' + entry[field])
            if path in checked:
                continue
            if digest(path) != entry['sha256']:
                issues.append({'kind': 'source-hash-mismatch', 'path': path.relative_to(package).as_posix()})
            checked.add(path)
    fluids = load(package / 'fluids.json')
    for fluid in fluids:
        if fluid.get('icon'):
            with Image.open(local(fluid['icon'])) as img:
                img.load()
                if not img.convert('RGBA').getchannel('A').getbbox():
                    issues.append({'kind': 'empty-fluid-icon', 'fluid': fluid['id']})
    result = {'issues': issues, 'graphEdgesChecked': len(graph['edges']), 'sourceFilesHashVerified': len(checked),
              'itemIconsChecked': len(items), 'fluidIconsChecked': sum(bool(x.get('icon')) for x in fluids),
              'knownSourceLimitations': {'invisibleTechnicalItems': 29, 'fluidWithoutRegisteredIcon': ['honey'],
                                         'brokenSuppliedGuideLinks': load(package / 'navigation.json')['unresolvedLinks']}}
    save(package / 'package-validation.json', result)
    if issues:
        raise ValueError(json.dumps(issues[:10], ensure_ascii=False))
    for script in ('verify_map_package.py',):
        shutil.copy2(Path(__file__).parent / script, package / 'exporter' / script)
    files = sorted(x for x in package.rglob('*') if x.is_file() and x.name != 'checksums.sha256')
    (package / 'checksums.sha256').write_text(''.join(digest(path) + '  ' + path.relative_to(package).as_posix() + '\n' for path in files), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False), flush=True)
    if archive:
        target = package.with_suffix('.zip')
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
            for path in sorted(x for x in package.rglob('*') if x.is_file()):
                z.write(path, package.name + '/' + path.relative_to(package).as_posix(),
                        compress_type=zipfile.ZIP_STORED if path.suffix.lower() in ('.png', '.jpg') else zipfile.ZIP_DEFLATED)
        with zipfile.ZipFile(target) as z:
            assert z.testzip() is None
            archive_files = {x.filename for x in z.infolist() if not x.is_dir()}
            assert len(archive_files) == len(files) + 1
        target.with_suffix('.zip.sha256').write_text(digest(target) + '  ' + target.name + '\n', encoding='ascii')
        print(json.dumps({'archive': str(target), 'bytes': target.stat().st_size, 'files': len(files) + 1}), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('package', type=Path)
    p.add_argument('--zip', action='store_true')
    a = p.parse_args()
    verify(a.package, a.zip)
