"""Validate the reviewed snapshot without claiming complete server coverage."""
import hashlib
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('builder', ROOT / 'build-catalog.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


def load(path):
    return json.loads(path.read_text(encoding='utf8'))


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def validate_release(root=ROOT):
    catalog = load(root / 'catalog.json')
    release = load(root / 'release.json')
    meta = catalog['meta']
    builder.validate(catalog, require_complete=meta['status'] == 'complete')
    require = builder.require
    require(fingerprint(catalog) == release['catalogSha256'], 'Catalog differs from reviewed release')
    require(catalog == load(root / 'current/catalog.json'), 'Published and source catalogs differ')
    require(meta['status'] == release['status'], 'Release status differs')
    require(meta['serverSynchronized'] is True, 'Missing server synchronization')
    require(hashlib.sha256((root / 'data/client-manifest.json').read_bytes()).hexdigest() == meta['clientManifestSha256'], 'Client manifest differs')
    snapshot = load(root / 'data/snapshot.json')
    require(snapshot['state']['exportedAt'] == meta['exportedAt'], 'Snapshot date differs')
    require(snapshot['state']['scriptHash'] == meta['scriptHash'], 'Server scripts differ')
    require(snapshot['validationIssues'] == 0, 'Source snapshot validation failed')
    require(meta['limitations'] == snapshot['limitations'] and bool(meta['limitations']), 'Coverage limitations must be preserved')
    rules = {r['id'] for r in catalog['recipes'] if r.get('operation') == 'native-rule'}
    report = load(root / 'data/normalization-report.json')
    require(rules == {r['id'] for r in report['nativeRules']}, 'Unresolved native rule report differs')
    require(len(rules) == release['nativeRules'] == meta['coverage']['nativeRules'], 'Native rule count differs')
    require(report['publicRecords'] == len(catalog['recipes']), 'Recipe report differs')
    if meta['status'] == 'partial':
        require(meta['coverage']['complete'] is False, 'Partial release must not claim completeness')
        require(release['scope'] == 'observed-client-sources', 'Explicit partial release scope required')
    detail_ids = {}
    for r in catalog['recipes']:
        path = r['detailsFile']
        require(path.startswith('data/recipe-details/') and '..' not in Path(path).parts, 'Unsafe recipe detail reference')
        detail_ids.setdefault(path, set()).add(r['id'])
    for path, ids in detail_ids.items():
        require((root / path).stat().st_size < 10 * 1024 * 1024, 'Recipe detail file must be split into smaller chunks')
        require(ids.issubset(load(root / path)), 'Missing native metadata in ' + path)
    quests = load(root / 'data/quests.json')
    lines = load(root / 'data/quest-lines.json')
    knowledge = load(root / 'data/knowledge.json')
    counts = {'items': len(catalog['items']), 'recipes': len(catalog['recipes']), 'quests': len(quests), 'questLines': len(lines), 'pages': len(knowledge['pages'])}
    require(counts == release['counts'], 'Release counts differ')
    ids = {q['questID'] for q in quests}
    require(all(p in ids for q in quests for p in q.get('preRequisites', [])), 'Broken quest prerequisite')
    require(all(n['id'] in ids for line in lines for n in line['quests']), 'Broken chapter node')
    return {'status': meta['status'], **counts, 'nativeRules': len(rules)}


if __name__ == '__main__':
    print(json.dumps(validate_release()))
