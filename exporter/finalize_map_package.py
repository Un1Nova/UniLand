"""Assemble sprites, source resources and coverage without asserting server-global completeness."""
import argparse
import collections
import hashlib
import json
import shutil
import zipfile
from pathlib import Path
from PIL import Image, ImageDraw
from build_map_data import load, save, walk


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def finalize(package, snapshot, client):
    assert (snapshot / 'script-classes.json').exists()
    assert not load(snapshot / 'finish-errors.json')
    assert not load(snapshot / 'repair-errors.json')
    assert not load(package / 'validation.json')['issues']
    assert not load(package / 'audit.json')['issues']
    items = load(package / 'items.json')
    modes = load(snapshot / 'icon-render-modes.json')
    sprites = {'rendered': 0, 'visibleExactVariantImages': 0, 'representatives': [], 'transparent': [], 'missing': []}
    valid, blank, absent = {}, set(), set()
    for item in items:
        file = snapshot / item['icon']
        if not file.exists():
            absent.add(item['id'])
            continue
        with Image.open(file) as img:
            img.load()
            assert img.size == (64, 64)
            if img.convert('RGBA').getchannel('A').getbbox() is None:
                blank.add(item['id'])
            else:
                valid[item['id']] = item
        sprites['rendered'] += 1
    by_registry = collections.defaultdict(list)
    for item in valid.values():
        if item['damage'] != 32767:
            by_registry[item['registryId']].append(item)
    for item in items:
        item['iconKind'] = modes.get(item['id'], 'forge-inventory-render')
        if item['id'] in absent | blank and item['damage'] == 32767 and by_registry[item['registryId']]:
            representative = min(by_registry[item['registryId']], key=lambda x: (bool(x.get('nbt')), x['damage'], x['id']))
            item['icon'] = representative['icon']
            item['iconKind'] = 'wildcard-representative'
            item['representativeItemId'] = representative['id']
            sprites['representatives'].append({'itemId': item['id'], 'representativeItemId': representative['id']})
        elif item['id'] in blank:
            item['iconKind'] = 'runtime-transparent'
            sprites['transparent'].append(item['id'])
        elif item['id'] in absent:
            sprites['missing'].append(item['id'])
        else:
            sprites['visibleExactVariantImages'] += 1
    assert not sprites['missing']
    shutil.copytree(snapshot / 'sprites', package / 'sprites', dirs_exist_ok=True)
    shutil.copytree(snapshot / 'fluid-sprites', package / 'fluid-sprites', dirs_exist_ok=True)
    save(package / 'items.json', items)
    save(package / 'sprite-coverage.json', sprites)
    fluid_images = {x['id']: x for x in load(snapshot / 'fluid-sprites.json')}
    fluids = load(snapshot / 'fluids.json')
    for fluid in fluids:
        fluid.update(fluid_images.get(fluid['id'], {'icon': None, 'iconKind': 'runtime-has-no-still-icon'}))
    save(package / 'fluids.json', fluids)
    raw = package / 'raw'
    for name in ('script-classes.json', 'icon-render-modes.json', 'sprites-errors.json', 'fluid-sprites-errors.json'):
        shutil.copy2(snapshot / name, raw / name)
    shutil.copytree(snapshot / 'script-classes', raw / 'script-classes', dirs_exist_ok=True)

    # Keep implementations of named dynamic rules and native crafting records.
    classes = set()
    for source in load(package / 'registry-sources.json'):
        for value in walk(load(package / source['file']).get('data')):
            if isinstance(value, dict) and value.get('dynamicRule'):
                classes.add(value['$type'].split('$$Lambda')[0])
    classes.update(x['ruleClass'] for x in load(package / 'recipes.json') if x.get('ruleClass'))
    classes = {x.replace('.', '/') for x in classes}
    implementations = []
    for archive in [client / 'client.jar', *sorted((client / 'mods').glob('*.jar'))]:
        with zipfile.ZipFile(archive) as jar:
            for name in jar.namelist():
                if name.endswith('.class') and (name[:-6] in classes or name.split('$')[0] in classes):
                    content = jar.read(name)
                    sha = hashlib.sha256(content).hexdigest()
                    target = raw / 'rule-classes' / (sha + '.class')
                    target.parent.mkdir(exist_ok=True)
                    target.write_bytes(content)
                    implementations.append({'class': name[:-6].replace('/', '.'), 'archive': archive.relative_to(client).as_posix(),
                                            'file': 'raw/rule-classes/' + target.name, 'sha256': sha})
    save(package / 'rule-implementations.json', implementations)
    exporter = Path(__file__).parent
    shutil.copytree(exporter / 'src', package / 'exporter' / 'src', dirs_exist_ok=True)
    for name in ('build.ps1', 'build_map_data.py', 'audit_map_data.py', 'enrich_map_links.py', 'finalize_map_package.py', 'export_knowledge.py', 'extract_knowledge.py', 'extract_assets.py', 'client_manifest.py', 'prepare_runtime.py'):
        shutil.copy2(exporter / name, package / 'exporter' / name)

    latest = {}
    for name in ('coverage.json', 'supplement-coverage.json', 'repair-coverage.json', 'finish-coverage.json'):
        for row in load(snapshot / name):
            latest[row['source']] = row
    source_list = load(package / 'registry-sources.json')
    sources = {x['source']: x for x in source_list}
    handler_rows = []
    for handler in load(snapshot / 'handlers.json'):
        names = ['luminous:' + handler['id']] + ['omni:' + x['id'] for x in handler['omni']]
        matching = [sources[n] for n in names if n in sources]
        handler_rows.append({'id': handler['id'], 'name': handler['name'], 'getAllRecipesAvailable': handler['allRecipesAvailable'],
                             'sources': matching, 'displayEnumerationViaNei': not handler['allRecipesAvailable']})
    nei = load(snapshot / 'nei-coverage.json')
    for row in nei:
        if row['sourceCount'] != row['exportedCount']:
            native = sources['nei-native:' + row['class']]
            assert native['sourceCount'] == row['sourceCount']
            row['nativeFallback'] = native
    coverage = {'scope': 'client-visible synchronized registries and shipped/active knowledge resources',
                'luminousHandlers': handler_rows, 'neiHandlers': nei,
                'registrySnapshots': [{**r, 'serializationErrors': latest.get(r['source'], {}).get('serializationErrors')} for r in source_list],
                'runtimeSerializationIssues': load(package / 'audit.json')['issues'],
                'scriptHashes': [load(snapshot / n)['scriptHash'] for n in ('state.json', 'repair-state.json', 'finish-state.json')],
                'notes': ['NEI sourceCount counts viewer entries, not unique mechanics. Duplicate views are retained with provenance.',
                          'Laser drill native lists and map are empty in this synchronized session.',
                          'Null BloodMagic guide RecipeHolder is an uninitialized optional registry, preserved as null.',
                          '37 NEI fluid/energy viewer records omitted by its display bridge are preserved in nei-native and machine registries.',
                          'Some sources are manager objects (sourceCount=-1), not lists; do not sum registry sourceCounts.',
                          'All observed raw references resolve. Executable rules remain typed records plus class definitions.']}
    assert len(set(coverage['scriptHashes'])) == 1
    save(package / 'coverage-report.json', coverage)
    manifest = load(package / 'manifest.json')
    manifest['extractionStatus'] = 'finished-for-observed-client-sources'
    manifest['normalizationStatus'] = 'special-native-mechanics-retained-in-raw'
    manifest['counts'].update(renderedItemImages=sprites['rendered'], visibleItemImages=sprites['visibleExactVariantImages'],
                              wildcardRepresentativeIcons=len(sprites['representatives']), transparentTechnicalItems=len(sprites['transparent']),
                              fluidDefinitions=len(fluids), fluidImages=len(fluid_images), scriptClasses=load(snapshot / 'script-classes.json')['sourceCount'],
                              ruleImplementationClasses=len(implementations))
    manifest['limitations'] = ['Special machine conditions and dynamic rules remain authoritative in typed raw records; normalized graph is an index, not a complete simulator.',
                               'Client-visible data cannot establish completeness of information retained exclusively by the server.',
                               'Transparent technical items, wildcard representative icons and one fluid without a runtime icon are explicitly identified.',
                               'One supplied guide link points to a nonexistent section; the original is preserved in navigation.json.']
    save(package / 'manifest.json', manifest)

    # A small genuine image sample for visual verification, no fabricated assets.
    sample = []
    for mod in sorted({x['modId'] for x in items}):
        choices = [x for x in items if x['modId'] == mod and x['id'] in valid]
        sample.extend(choices[:3])
    canvas = Image.new('RGB', (960, ((len(sample) + 11) // 12) * 88), '#222222')
    draw = ImageDraw.Draw(canvas)
    for i, item in enumerate(sample):
        x, y = (i % 12) * 80, (i // 12) * 88
        with Image.open(package / item['icon']) as img:
            canvas.paste(img.convert('RGBA'), (x+8, y), img.convert('RGBA'))
        draw.text((x+2, y+65), item['modId'][:12], fill='white')
    canvas.save(package / 'sprite-preview.jpg', quality=92)
    print(json.dumps(manifest, ensure_ascii=False))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('package', type=Path)
    p.add_argument('snapshot', type=Path)
    p.add_argument('client', type=Path)
    a = p.parse_args()
    finalize(a.package, a.snapshot, a.client)
