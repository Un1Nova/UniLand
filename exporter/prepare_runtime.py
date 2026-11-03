"""Generate a reviewed read-only static recipe registry plan from class metadata."""
import json
from pathlib import Path

work = Path(__file__).resolve().parents[2]
classes = json.loads((work / 'tmr-inspection/candidate-apis.json').read_text())
roots = set()
for cls in classes:
    name = cls['name'].replace('/', '.')
    if any(s in name.lower() for s in ('container', 'nei', 'luminous', 'minetweaker', 'zenscript')):
        continue
    for field in cls['fields']:
        if (field['accessFlags'] & 8 and
            field['descriptor'].startswith(('Ljava/util/Map', 'Ljava/util/List', 'Ljava/util/Set',
                'Ljava/util/Collection', 'Ljava/util/HashMap', 'Ljava/util/ArrayList', 'Lcom/google/common/collect')) and
            any(s in field['name'].lower() for s in ('recipe', 'mutation'))):
            roots.add((name, field['name']))
target = work / 'tmr-runtime-private/registry-roots.tsv'
target.write_text('\n'.join('\t'.join(x) for x in sorted(roots)), encoding='utf-8')
print(json.dumps({'roots': len(roots), 'target': str(target)}))
