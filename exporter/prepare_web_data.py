"""Build the public browsing data from a verified local map snapshot.

Preserves explicit alternatives, native metadata and unresolved rule identities.
Does not turn unknown outputs into invented products or claim global completeness.
"""
import argparse
import collections
import hashlib
import json
import re
import shutil
from pathlib import Path
from build_map_data import Reader, canonical, load, save, walk


def clean(text):
    return re.sub(r'§.', '', str(text or ''))


def apply_display_grid(recipe, metadata):
    """The shaped Avaritia viewer uses nine cells, origin (3,3), pitch 18.

    Keep absolute source coordinates: empty border/interior slots are meaningful.
    Never infer shaped layouts for shapeless or unrelated machine displays.
    """
    kind = metadata.get('omnicraft.type', {}).get('id', {})
    if recipe['type'] != 'extreme_crafting' or kind.get('value') != 'Avaritia:extreme_shaped_crafting':
        return False
    slots = []
    for stack in recipe['inputs']:
        x, y = stack.get('screenX'), stack.get('screenY')
        if not all(isinstance(v, int) and 3 <= v <= 147 and (v - 3) % 18 == 0 for v in (x, y)):
            raise ValueError('Invalid shaped extreme-crafting coordinates: ' + recipe['id'])
        slots.append(((y - 3) // 18) * 9 + (x - 3) // 18)
    if len(set(slots)) != len(slots):
        raise ValueError('Duplicate extreme-crafting slot: ' + recipe['id'])
    for stack, slot in zip(recipe['inputs'], slots):
        stack['slot'] = slot
    recipe.update(width=9, height=9)
    return True


def write_details(root, details, recipes, max_bytes=8 * 1024 * 1024):
    """Bound individual GitHub blobs without discarding any native metadata."""
    paths = {}
    for file, content in details.items():
        chunks, chunk, size = [], {}, 2
        for rid, record in content.items():
            entry_size = len(json.dumps({rid: record}, ensure_ascii=False, separators=(',', ':')).encode('utf8'))
            if chunk and size + entry_size > max_bytes:
                chunks.append(chunk)
                chunk, size = {}, 2
            if entry_size > max_bytes:
                raise ValueError('Single native record exceeds detail chunk limit: ' + rid)
            chunk[rid] = record
            size += entry_size
        if chunk:
            chunks.append(chunk)
        for index, chunk in enumerate(chunks):
            target = file if len(chunks) == 1 else file.removesuffix('.json') + f'-{index:03}.json'
            save(root / target, chunk)
            paths.update((rid, target) for rid in chunk)
    for recipe in recipes:
        recipe['detailsFile'] = paths[recipe['id']]


class WebReader(Reader):
    def compact(self, value, seen=None, depth=0):
        value = self.ref(value)
        if not isinstance(value, (dict, list)):
            return value
        if isinstance(value, list):
            return [self.compact(x, seen, depth + 1) for x in value]
        typ = value.get('$type', '')
        fields = self.fields(value)
        if typ == 'net.minecraftforge.fluids.FluidStack':
            fluid = self.ref(fields.get('fluid', {}))
            return {'$type': 'fluid-stack', 'fluid': self.fields(fluid).get('fluidName'), 'amount': fields.get('amount'), 'unit': 'mB', 'nbt': fields.get('tag')}
        if typ == 'net.minecraftforge.fluids.Fluid':
            return {'$type': 'fluid', 'id': fields.get('fluidName')}
        if 'TextureAtlasSprite' in typ:
            return {'$type': 'icon-resource', 'name': fields.get('field_110984_i')}
        if typ.startswith(('java.lang.reflect.', 'io.netty.', 'java.nio.', 'java.lang.ref.')) or any(k in value for k in ('$excludedType', '$runtimeInfrastructure')):
            return None
        if typ in ('stack', 'fluid-stack', 'long', 'resource', 'item', 'block', 'icon-resource'):
            return {k: v for k, v in value.items() if k != '$id'}
        seen = set() if seen is None else seen
        if '$id' in value and value['$id'] in seen:
            return {'reference': value['$id']}
        seen = seen | {value.get('$id')}
        if depth > 6:
            return {'reference': value.get('$id'), 'class': typ}
        if 'values' in value:
            return [self.compact(x, seen, depth+1) for x in value['values']]
        if 'entries' in value:
            entries = value['entries']
            if all(isinstance(k, str) for k, v in entries):
                return {k: self.compact(v, seen, depth+1) for k, v in entries}
            return {'entries': [[self.compact(k, seen, depth+1), self.compact(v, seen, depth+1)] for k, v in entries]}
        if 'fields' in value:
            return {'class': typ, **{k: self.compact(v, seen, depth+1) for k, v in fields.items()}}
        return value


def prepare(package, root):
    manifest = load(package / 'manifest.json')
    validation = load(package / 'package-validation.json')
    if validation['issues']:
        raise ValueError('Source package has validation issues')
    items = load(package / 'items.json')
    for item in items:
        item['name'] = clean(item.get('name') or item['registryId'])
        item['kind'] = 'item'
        icon = item['icon']
        item['icon'] = 'assets/items/' + Path(icon).name
        target = root / item['icon']
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists():
            shutil.copy2(package / icon, target)
    for fluid in load(package / 'fluids.json'):
        icon = fluid.get('icon')
        row = {'id': 'fluid:' + fluid['id'], 'registryId': fluid['id'], 'name': clean(fluid.get('getLocalizedName') or fluid['id']),
               'englishName': fluid['id'], 'kind': 'fluid', 'modId': 'fluids', 'iconKind': fluid['iconKind'], 'fluidProperties': fluid}
        if icon:
            row['icon'] = 'assets/items/fluid-' + Path(icon).name
            shutil.copy2(package / icon, root / row['icon'])
        items.append(row)
    item_ids = {x['id'] for x in items}
    ores = {x['name']: [v for v in x['variants'].get('values', []) if v.get('$type') == 'stack'] for x in load(package / 'raw/ores.json')}
    handler_names = {x['id']: x['name'] for x in load(package / 'raw/handlers.json')}
    docs = {}
    def document(path):
        if path not in docs:
            docs.clear()
            doc = load(package / path)
            docs[path] = (doc, WebReader(doc.get('data')))
        return docs[path]
    def stack(value):
        if not isinstance(value, dict):
            return None
        if value.get('$type') == 'stack' and value['itemId'] in item_ids:
            if value.get('count', 1) <= 0:
                return {'itemId': value['itemId'], 'count': 1, 'role': 'catalyst', 'sourceCount': value.get('count')}
            return {'itemId': value['itemId'], 'count': value.get('count', 1)}
        if value.get('$type') == 'fluid-stack' and value.get('fluid') and value.get('amount', 0) > 0:
            fid = 'fluid:' + value['fluid']
            if fid not in item_ids:
                items.append({'id': fid, 'kind': 'fluid', 'registryId': value['fluid'], 'name': value['fluid'], 'modId': 'fluids'})
                item_ids.add(fid)
            return {'itemId': fid, 'kind': 'fluid', 'count': value['amount'], 'unit': 'mB', **({'nbt': value['nbt']} if value.get('nbt') else {})}
        return None
    def variants(values):
        if isinstance(values, str):
            values = ores.get(values, [])
        if not isinstance(values, list):
            values = [values]
        choices = [s for x in values if (s := stack(x))]
        if not choices:
            return None
        first = dict(choices[0])
        if len(choices) > 1:
            first['variants'] = choices
            first['alternatives'] = list(dict.fromkeys(x['itemId'] for x in choices))
        return first
    def stacks(value):
        if not isinstance(value, list):
            value = [value]
        result = []
        for v in value:
            if isinstance(v, dict) and 'variants' in v:
                s = variants(v['variants'])
                if s:
                    s.update({k: v[k] for k in ('screenX', 'screenY') if v.get(k) is not None})
                    result.append(s)
            elif isinstance(v, list) or isinstance(v, str):
                s = variants(v)
                if s:
                    result.append(s)
            elif (s := stack(v)):
                result.append(s)
        return result
    def find_fluids(value):
        return [s for x in walk(value) if isinstance(x, dict) and x.get('$type') == 'fluid-stack' and (s := stack(x))]
    recipes, details, unresolved = [], collections.defaultdict(dict), []
    for raw in load(package / 'recipes.json'):
        rec = {'id': raw['id'], 'type': raw['type'], 'machine': clean(raw.get('machine') or handler_names.get(raw['type'], raw['type'])),
               'inputs': stacks(raw.get('inputs')), 'outputs': stacks(raw.get('outputs')), 'verification': 'runtime', 'sources': raw['sources']}
        source = raw['sources'][0]
        doc, reader = document(source['file'])
        meta = raw.get('metadata') or {}
        if source['registry'].startswith(('luminous:', 'nei:')):
            value = reader.values(doc['data'])[source['index']]
            meta = reader.compact(reader.fields(value).get('metadata')) or {}
        # Recover fluid channels from typed native metadata with explicit semantic field names.
        for obj in walk(meta):
            if not isinstance(obj, dict):
                continue
            for field in ('inputFluid', 'inputFluids', 'fluidInput'):
                for s in find_fluids(obj.get(field)):
                    if s not in rec['inputs']:
                        rec['inputs'].append(s)
            for field in ('outputFluid', 'outputFluids', 'fluidOutput'):
                for s in find_fluids(obj.get(field)):
                    if s not in rec['outputs']:
                        rec['outputs'].append(s)
            if 'ItemToFluidEntry' in obj.get('class', ''):
                rec['outputs'].extend(s for s in find_fluids(obj.get('output')) if s not in rec['outputs'])
        if source['registry'] == 'CraftingManager.recipeList':
            rec['ruleClass'] = raw.get('ruleClass')
            if isinstance(raw.get('width'), int) and isinstance(raw.get('height'), int):
                original = raw.get('inputs') or []
                if isinstance(original, list):
                    rec['inputs'] = [dict(s, slot=i) for i, x in enumerate(original) if (s := variants(x))]
                    rec.update(width=raw['width'], height=raw['height'])
        apply_display_grid(rec, meta)
        if not rec['outputs']:
            rec['operation'] = 'native-rule'
            rec['notes'] = 'Правило зависит от параметров механизма или состояния предмета.'
            unresolved.append({'id': rec['id'], 'type': rec['type'], 'source': source})
        conditions = []
        labels = {'lolimagically.blood': 'Кровь, LP', 'lolimagically.altar_tier': 'Уровень алтаря',
                  'lolimagically.mana': 'Мана', 'energyCost': 'Энергия', 'craftingTier': 'Уровень', 'duration': 'Длительность, тики',
                  'temperature': 'Температура', 'research': 'Исследование', 'habitat': 'Место', 'mobName': 'Существо',
                  'mana': 'Мана', 'instability': 'Нестабильность'}
        for obj in walk(meta):
            if not isinstance(obj, dict):
                continue
            for key, label in labels.items():
                val = obj.get(key)
                if isinstance(val, dict) and val.get('$type') == 'long':
                    val = val['value']
                if isinstance(val, (int, float, str)) and val not in (0, ''):
                    condition = label + ': ' + clean(val)
                    if condition not in conditions:
                        conditions.append(condition)
        if conditions:
            rec['conditions'] = conditions
        rec['detailsFile'] = 'data/recipe-details/' + hashlib.sha256(rec['type'].encode()).hexdigest()[:16] + '.json'
        details[rec['detailsFile']][rec['id']] = {'metadata': meta, 'source': source, 'nativeRule': raw.get('ruleClass')}
        recipes.append(rec)
    # Typed display records remain explicit; metadata and differing mechanics are never merged by output alone.
    source_meta = manifest['state']
    fingerprint = hashlib.sha256((package / 'raw/client-manifest.json').read_bytes()).hexdigest()
    catalog = {'schemaVersion': 1, 'meta': {'title': 'LoliLand · TechnoMagic RPG', 'minecraftVersion': '1.7.10',
               'exportedAt': source_meta['exportedAt'], 'status': 'partial', 'serverSynchronized': True,
               'clientManifestSha256': fingerprint, 'scriptHash': source_meta['scriptHash'],
               'sources': [{'title': 'TechnoMagic RPG', 'url': 'https://loliland.ru/ru/servers/techno-magic-rpg'}],
               'coverage': {'runtimeExport': True, 'registryEnumerated': True, 'complete': False, 'items': len(items), 'recipes': len(recipes),
                            'definitionsExported': True, 'nativeRules': len(unresolved)},
               'limitations': manifest['limitations']},
               'mods': [{'id': m, 'name': 'Жидкости и газы' if m == 'fluids' else m} for m in sorted({x['modId'] for x in items})],
               'items': items, 'recipes': recipes}
    write_details(root, details, recipes)
    save(root / 'current/catalog.json', catalog)
    save(root / 'catalog.json', catalog)
    save(root / 'data/normalization-report.json', {'nativeRules': unresolved, 'sourceRecords': manifest['counts']['normalizedRecipeRecords'], 'publicRecords': len(recipes)})
    for source, target in [('quests.json', 'quests.json'), ('quest-lines.json', 'quest-lines.json'), ('knowledge-runtime.json', 'knowledge.json')]:
        shutil.copy2(package / source, root / 'data' / target)
    save(root / 'data/snapshot.json', manifest)
    shutil.copy2(package / 'coverage-report.json', root / 'data/coverage-report.json')
    shutil.copy2(package / 'raw/client-manifest.json', root / 'data/client-manifest.json')
    print(json.dumps({'items': len(items), 'recipes': len(recipes), 'nativeRules': len(unresolved), 'byType': dict(collections.Counter(x['type'] for x in unresolved))}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('package', type=Path)
    p.add_argument('root', type=Path)
    a = p.parse_args()
    prepare(a.package, a.root)
