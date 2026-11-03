"""Apply the same grid normalization to an already prepared public catalog."""
import json
from pathlib import Path
from prepare_web_data import apply_display_grid

root = Path(__file__).resolve().parents[1]
for path in (root / 'catalog.json', root / 'current/catalog.json'):
    catalog = json.loads(path.read_text(encoding='utf8'))
    details, fixed = {}, 0
    for recipe in catalog['recipes']:
        if recipe['type'] != 'extreme_crafting':
            continue
        name = recipe['detailsFile']
        if name not in details:
            details[name] = json.loads((root / name).read_text(encoding='utf8'))
        fixed += apply_display_grid(recipe, details[name][recipe['id']]['metadata'])
    path.write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')), encoding='utf8')
    print(path.name, fixed, 'shaped grids restored')
