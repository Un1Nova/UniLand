"""Build a loss-preserving local data package for the future progression map.

Raw registry snapshots remain authoritative for special mechanics. Derived graph
edges distinguish display ingredients, requirements, rewards and textual links.
This command never marks unresolved mechanics as fully normalized.
"""
import argparse
import collections
import hashlib
import json
import re
import shutil
from pathlib import Path


def load(p):
    return json.loads(p.read_text(encoding='utf-8'))


def save(p, data):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')


def canonical(o):
    def numbers(v):
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, dict):
            return {k: numbers(x) for k, x in v.items()}
        if isinstance(v, list):
            return [numbers(x) for x in v]
        return v
    return json.dumps(numbers(o), ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def sha(o):
    return hashlib.sha256(canonical(o).encode()).hexdigest()


def untag(n):
    if not isinstance(n, dict) or 'type' not in n:
        return n
    t, v = n['type'], n.get('value')
    if t == 10:
        return {k: untag(x) for k, x in v.items()}
    if t == 9:
        return [untag(x) for x in v]
    return v  # Longs remain decimal strings; typed source is retained separately.


class Reader:
    def __init__(self, source):
        self.ids = {}
        self.index(source)

    def index(self, v):
        if isinstance(v, dict):
            if '$id' in v:
                self.ids[v['$id']] = v
            for x in v.values():
                self.index(x)
        elif isinstance(v, list):
            for x in v:
                self.index(x)

    def ref(self, v):
        return self.ids.get(v['$ref'], v) if isinstance(v, dict) and '$ref' in v else v

    def fields(self, v):
        v = self.ref(v)
        return {k.rsplit('.', 1)[-1]: self.ref(x) for k, x in v.get('fields', {}).items()} if isinstance(v, dict) else {}

    def values(self, v):
        v = self.ref(v)
        return v.get('values', []) if isinstance(v, dict) else v if isinstance(v, list) else []

    def simplified(self, v, seen=None, depth=0):
        v = self.ref(v)
        if not isinstance(v, (dict, list)):
            return v
        seen = set() if seen is None else seen
        if isinstance(v, list):
            return [self.simplified(x, seen, depth+1) for x in v]
        if '$id' in v and v['$id'] in seen:
            return {'rawObjectRef': v['$id']}
        seen = seen | {v.get('$id')}
        typ = v.get('$type', '')
        if depth > 6 or 'TextureAtlasSprite' in typ or typ.startswith('java.lang.ref.'):
            return {'rawObjectRef': v.get('$id'), 'class': typ}
        if len(v.get('values', [])) > 1024 or len(v.get('entries', [])) > 1024:
            return {'rawObjectRef': v.get('$id'), 'class': typ, 'sourceCount': len(v.get('values', v.get('entries', [])))}
        if 'values' in v:
            return [self.simplified(x, seen, depth+1) for x in v['values']]
        if 'entries' in v:
            if all(isinstance(k, str) for k, x in v['entries']):
                return {k: self.simplified(x, seen, depth+1) for k, x in v['entries']}
            return {'entries': [[self.simplified(k, seen, depth+1), self.simplified(x, seen, depth+1)] for k, x in v['entries']]}
        if 'fields' in v:
            return {'class': typ, **{k: self.simplified(x, seen, depth+1) for k, x in self.fields(v).items()}}
        return {k: self.simplified(x, seen, depth+1) for k, x in v.items() if k != '$id'}


def walk(v):
    yield v
    if isinstance(v, dict):
        for x in v.values():
            yield from walk(x)
    elif isinstance(v, list):
        for x in v:
            yield from walk(x)


def make(snapshot, knowledge, assets, destination):
    destination.mkdir(parents=True, exist_ok=True)
    items = load(snapshot / 'items.json')
    item_by_key = {(x['registryId'], x['damage'], canonical(x.get('nbt'))): x['id'] for x in items}
    item_ids = {x['id'] for x in items}
    by_registry, by_variant = collections.defaultdict(list), collections.defaultdict(list)
    for item in items:
        by_registry[item['registryId']].append(item['id'])
        by_variant[(item['registryId'], item['damage'])].append(item)
    recipes, recipe_keys, sources = [], {}, []
    issues, edges = [], []

    def add_recipe(recipe):
        source = recipe.pop('source')
        key = sha(recipe)
        if key in recipe_keys:
            recipe_keys[key]['sources'].append(source)
            return
        recipe['id'] = 'recipe:' + key
        recipe['sources'] = [source]
        recipe_keys[key] = recipe
        recipes.append(recipe)

    handlers = load(snapshot / 'handlers.json')
    by_handler = {x['id']: x for x in handlers}
    nei_evidence = load(snapshot / 'nei-coverage.json') if (snapshot / 'nei-coverage.json').exists() else []
    nei_paths = {x.get('path'): x for x in nei_evidence}
    for path in sorted((snapshot / 'registries').glob('*.json')):
        doc = load(path)
        data, name = doc.get('data'), doc['source']
        if name.startswith('nei:') and ('registries/' + path.name) not in nei_paths:
            continue
        print('Registry:', name, flush=True)
        r = Reader(data)
        provenance = {'file': 'raw/registries/' + path.name, 'registry': name}
        sources.append({'source': name, 'sourceCount': doc['sourceCount'], 'file': provenance['file']})
        if name.startswith(('luminous:', 'nei:')):
            typ = name.split(':', 1)[1] if name.startswith('luminous:') else nei_paths['registries/' + path.name]['type']
            for idx, value in enumerate(r.values(data)):
                fields = r.fields(value)
                def slots(v):
                    result = []
                    for slot in r.values(v):
                        f = r.fields(slot)
                        result.append({'variants': r.simplified(f.get('variants')), 'screenX': f.get('gridX'), 'screenY': f.get('gridY')})
                    return result
                entry = {'type': typ, 'machine': by_handler.get(typ, {}).get('name', typ), 'inputs': slots(fields.get('inputs')), 'outputs': slots(fields.get('outputs')),
                         'metadata': r.simplified(fields.get('metadata'), depth=5), 'verification': 'runtime', 'source': {**provenance, 'index': idx}}
                if not entry['outputs']:
                    entry['outputSemantics'] = 'see typed metadata and raw registry; may be fluid, energy, research or a dynamic rule'
                add_recipe(entry)
        elif name == 'CraftingManager.recipeList':
            for idx, value in enumerate(r.values(data)):
                v = r.ref(value)
                f = r.fields(v)
                inputs = next((f[k] for k in ('field_77574_d', 'field_77579_b', 'input', 'inputs', 'recipeItems') if k in f), None)
                output = next((f[k] for k in ('field_77575_e', 'field_77580_a', 'output', 'recipeOutput') if k in f), None)
                width = next((f[k] for k in ('field_77576_b', 'width') if k in f), None)
                height = next((f[k] for k in ('field_77577_c', 'height') if k in f), None)
                rec = {'type': 'crafting', 'ruleClass': v.get('$type'), 'inputs': r.simplified(inputs), 'outputs': r.simplified(output),
                       'source': {**provenance, 'index': idx}, 'verification': 'runtime', 'nativeObjectRef': v.get('$id')}
                if width is not None and height is not None:
                    rec.update(width=width, height=height)
                if inputs is None or output is None:
                    rec['normalization'] = 'native-rule-preserved'
                add_recipe(rec)
        elif name == 'FurnaceRecipes.smeltingList':
            for idx, (inp, output) in enumerate(data['entries']):
                add_recipe({'type': 'smelting', 'inputs': [r.simplified(inp)], 'outputs': [r.simplified(output)], 'verification': 'runtime', 'source': {**provenance, 'index': idx}})
        # Native records are retained with exact types and scope-local reference IDs.
        # Their graph links are added below without guessing the meaning of obfuscated fields.
    for rec in recipes:
        for role in ('inputs', 'outputs'):
            for value in walk(rec.get(role)):
                if isinstance(value, dict) and value.get('$type') == 'stack':
                    edges.append({'from': value['itemId'] if role == 'inputs' else rec['id'], 'to': rec['id'] if role == 'inputs' else value['itemId'], 'relation': 'ingredient' if role == 'inputs' else 'produces', 'count': value.get('count')})
                    if value['itemId'] not in item_ids:
                        issues.append({'kind': 'missing-item', 'itemId': value['itemId'], 'recipe': rec['id']})

    quests, lines = [], []
    for file, dest in (('QuestDatabase.json', quests), ('QuestLineDatabase.json', lines)):
        doc = load(snapshot / file)
        dest.extend(untag(doc['data']))
        if len(dest) != doc['sourceCount']:
            raise ValueError('Quest source count mismatch: ' + file)
    quest_ids = {q['questID'] for q in quests}
    raw_quests = load(snapshot / 'QuestDatabase.json')['data']['value']
    for q, raw_quest in zip(quests, raw_quests):
        q['id'] = f"quest:{q['questID']}"
        for parent in q['preRequisites']:
            edges.append({'from': f'quest:{parent}', 'to': q['id'], 'relation': 'prerequisite', 'logic': q['properties']['betterquesting'].get('questLogic')})
            if parent not in quest_ids:
                issues.append({'kind': 'missing-quest', 'quest': q['questID'], 'dependency': parent})
        # Keep tasks/rewards verbatim; an item-bearing object is annotated, never replaced.
        def annotate(raw, v, role):
            if not isinstance(raw, dict):
                return
            if raw.get('type') == 10:
                fields = raw['value']
                if isinstance(v.get('id'), str) and 'Count' in v:
                    target = item_by_key.get((v['id'], v.get('Damage', 0), canonical(fields.get('tag'))))
                    if target:
                        v['itemId'] = target
                        edges.append({'from': q['id'], 'to': target, 'relation': role, 'count': v['Count']})
                    else:
                        v['itemCandidates'] = [x['id'] for x in by_variant[(v['id'], v.get('Damage', 0))]]
                        issues.append({'kind': 'unresolved-quest-stack', 'quest': q['id'], 'registryId': v['id'], 'role': role})
                for k, value in fields.items():
                    annotate(value, v[k], role)
            elif raw.get('type') == 9:
                for a, b in zip(raw['value'], v):
                    annotate(a, b, role)
        for field, role in [('tasks', 'requires-item'), ('rewards', 'rewards-item'), ('properties', 'quest-icon')]:
            if field in raw_quest['value']:
                annotate(raw_quest['value'][field], q[field], role)
    for line in lines:
        for node in line['quests']:
            if node['id'] not in quest_ids:
                issues.append({'kind': 'missing-quest-layout-target', 'line': line['lineID'], 'quest': node['id']})

    knowledge_manifest = load(knowledge / 'manifest.json')
    pages = []
    for entry in knowledge_manifest['entries']:
        if not entry['resource'].endswith('.md'):
            continue
        text = (knowledge / entry['localPath']).read_text(encoding='utf-8')
        page_id = 'page:' + sha([entry['archive'], entry['resource']])
        pages.append({'id': page_id, 'kind': 'guide' if '/guides/' in entry['resource'] else 'wiki', 'markdown': text, 'source': entry})
        for registry in sorted(set(re.findall(r'[A-Za-z_][\w.-]*:[A-Za-z_][\w./-]*', text))):
            matched = by_registry[registry]
            for target in matched:
                edges.append({'from': page_id, 'to': target, 'relation': 'mentions-registry', 'registryId': registry})
    assets_manifest = load(assets / 'manifest.json')
    english, russian = {}, {}
    for row in assets_manifest['entries']:
        name = row['resource'].lower()
        target = english if name.endswith('/en_us.lang') else russian if name.endswith('/ru_ru.lang') else None
        if target is not None:
            for line in (assets / row['file']).read_text(encoding='utf-8', errors='replace').splitlines():
                if '=' in line and not line.startswith('#'):
                    k, v = line.split('=', 1)
                    target[k] = v
    for item in items:
        key = item.get('translationKey', '')
        item['englishName'] = english.get(key + '.name', english.get(key))
        item['translationSource'] = 'shipped-language-resources; display name captured from runtime'
    for name, content in [('items.json', items), ('recipes.json', recipes), ('quests.json', quests), ('quest-lines.json', lines), ('pages.json', pages), ('graph.json', {'edges': edges}), ('registry-sources.json', sources), ('validation.json', {'issues': issues}), ('translations.json', {'en_us': english, 'ru_ru': russian})]:
        save(destination / name, content)
    # Copy exact raw snapshots for special mechanics and reproducibility; omit private log/state files.
    raw = destination / 'raw'
    raw.mkdir(exist_ok=True)
    shutil.copytree(snapshot / 'registries', raw / 'registries', dirs_exist_ok=True)
    for file in ('state.json', 'QuestDatabase.json', 'QuestLineDatabase.json', 'coverage.json', 'handlers.json', 'ores.json', 'errors.json', 'supplement-coverage.json', 'supplement-errors.json', 'active-resourcepacks.json', 'nei-coverage.json', 'repair-coverage.json', 'repair-errors.json', 'repair-state.json', 'finish-coverage.json', 'finish-errors.json', 'finish-state.json', 'fluids.json', 'sprites-progress.json', 'sprites-errors.json'):
        if (snapshot / file).exists():
            shutil.copy2(snapshot / file, raw / file)
    summary = {'status': 'partial', 'runtimeExport': True, 'state': load(snapshot / 'state.json'), 'counts': {'items': len(items), 'normalizedRecipeRecords': len(recipes), 'rawRegistrySnapshots': len(sources), 'quests': len(quests), 'questLines': len(lines), 'guides': sum(x['kind'] == 'guide' for x in pages), 'wikiPages': sum(x['kind'] == 'wiki' for x in pages), 'edges': len(edges), 'sourcePngResources': sum(x['resource'].endswith('.png') for x in assets_manifest['entries'])},
               'limitations': ['Special machine mechanics retained in typed native registry records; not all fields are yet semantically normalized.', 'Dynamic rules and unobtainable server-only information cannot be claimed as exhaustive by counting display recipes.', 'Sprite render coverage is recorded separately.'], 'validationIssues': len(issues)}
    save(destination / 'manifest.json', summary)
    return summary


if __name__ == '__main__':
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('snapshot', type=Path)
    p.add_argument('knowledge', type=Path)
    p.add_argument('assets', type=Path)
    p.add_argument('destination', type=Path)
    a = p.parse_args()
    print(json.dumps(make(a.snapshot, a.knowledge, a.assets, a.destination), ensure_ascii=False))
