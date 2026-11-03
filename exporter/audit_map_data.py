"""Validate actual exported references, loss markers and decoded inventory PNGs."""
import argparse
import collections
import json
from pathlib import Path
from PIL import Image
from build_map_data import load, save, walk


def audit(package, snapshot):
    issues, markers = [], collections.Counter()
    sources = load(package / 'registry-sources.json')
    for source in sources:
        doc = load(package / source['file'])
        data = doc.get('data')
        objects = [x for x in walk(data) if isinstance(x, dict)]
        ids = {x['$id'] for x in objects if '$id' in x}
        for obj in objects:
            for key in ('$error', '$truncatedType', '$excludedType', '$runtimeInfrastructure', 'dynamicRule'):
                if key in obj:
                    markers[key + ':' + str(obj[key])] += 1
                    if key in ('$error', '$truncatedType'):
                        issues.append({'kind': key, 'source': source['source'], 'value': obj[key]})
            if '$ref' in obj and obj['$ref'] not in ids:
                issues.append({'kind': 'broken-raw-reference', 'source': source['source'], 'ref': obj['$ref']})
        if isinstance(data, dict) and source['sourceCount'] >= 0:
            count = len(data.get('values', data.get('entries', [])))
            if count != source['sourceCount']:
                issues.append({'kind': 'source-count-mismatch', 'source': source['source'], 'actual': count})
    items = load(snapshot / 'items.json')
    blank, missing, bad = [], [], []
    for item in items:
        path = snapshot / item['icon']
        if not path.exists():
            missing.append(item['id'])
            continue
        try:
            with Image.open(path) as image:
                image.load()
                if image.size != (64, 64):
                    bad.append({'itemId': item['id'], 'size': image.size})
                if image.convert('RGBA').getchannel('A').getbbox() is None:
                    blank.append(item['id'])
        except Exception as exc:
            bad.append({'itemId': item['id'], 'error': str(exc)})
    result = {'issues': issues, 'rawMarkers': dict(markers), 'registriesChecked': len(sources),
              'sprites': {'totalItems': len(items), 'missing': missing, 'blank': blank, 'invalid': bad}}
    save(package / 'audit.json', result)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('package', type=Path)
    p.add_argument('snapshot', type=Path)
    a = p.parse_args()
    audit(a.package, a.snapshot)
