"""Build a smaller browser bootstrap while preserving the full source catalog.

Only unused display/provenance metadata is omitted. Item IDs (including NBT
variants), complete item NBT, recipe details links and all stack fields survive.
Repeated alternative/variant arrays are stored once; item references use the
position in the unchanged items array. runtime.js restores the normal v1 shape.
"""
import json

RUNTIME_FORMAT = 'uniland-runtime-v1'
ITEM_METADATA_FIELDS = frozenset({
    'translationKey', 'translationSource', 'iconKind', 'nameError',
    'fluidProperties', 'representativeItemId',
})
RECIPE_METADATA_FIELDS = frozenset({'ruleClass'})


def encode_runtime_catalog(catalog):
    if not isinstance(catalog, dict) or catalog.get('schemaVersion') != 1:
        raise ValueError('Runtime bootstrap requires a v1 catalog')
    if 'runtimeFormat' in catalog or 'sharedStacks' in catalog:
        raise ValueError('Source catalog contains reserved runtime fields')
    if not isinstance(catalog.get('items'), list) or not isinstance(catalog.get('recipes'), list):
        raise ValueError('Runtime bootstrap requires items and recipes arrays')
    item_indices = {}
    for index, item in enumerate(catalog['items']):
        item_id = item.get('id') if isinstance(item, dict) else None
        if not isinstance(item_id, str) or not item_id or item_id in item_indices:
            raise ValueError('Runtime bootstrap requires unique string item IDs')
        item_indices[item_id] = index

    def item_reference(item_id):
        if not isinstance(item_id, str) or item_id not in item_indices:
            raise ValueError(f'Unknown runtime item reference: {item_id!r}')
        return item_indices[item_id]

    shared = {'alternatives': [], 'variants': []}
    table_indices = {name: {} for name in shared}

    def array_reference(name, value):
        # Sorting object keys affects deduplication only, never the stored values.
        key = json.dumps(value, ensure_ascii=False, separators=(',', ':'),
                         sort_keys=True, allow_nan=False)
        index = table_indices[name].get(key)
        if index is None:
            index = len(shared[name])
            table_indices[name][key] = index
            shared[name].append(value)
        return index

    def encode_stack(stack):
        if not isinstance(stack, dict):
            raise ValueError('Runtime recipe stacks must be objects')
        encoded = dict(stack)
        encoded['itemId'] = item_reference(stack.get('itemId'))
        if 'alternatives' in stack:
            if not isinstance(stack['alternatives'], list):
                raise ValueError('Runtime alternatives must be arrays')
            encoded['alternatives'] = array_reference(
                'alternatives', [item_reference(value) for value in stack['alternatives']])
        if 'variants' in stack:
            if not isinstance(stack['variants'], list):
                raise ValueError('Runtime variants must be arrays')
            variants = []
            for variant in stack['variants']:
                if not isinstance(variant, dict):
                    raise ValueError('Runtime variants must be objects')
                variants.append({**variant, 'itemId': item_reference(variant.get('itemId'))})
            encoded['variants'] = array_reference('variants', variants)
        return encoded

    recipes = []
    for recipe in catalog['recipes']:
        if not isinstance(recipe, dict):
            raise ValueError('Runtime recipes must be objects')
        if not isinstance(recipe.get('inputs'), list) or not isinstance(recipe.get('outputs'), list):
            raise ValueError('Runtime recipes require inputs and outputs arrays')
        omitted = RECIPE_METADATA_FIELDS
        if recipe.get('operation') != 'native-rule':
            omitted = omitted | {'sources'}
        encoded = {key: value for key, value in recipe.items() if key not in omitted}
        encoded['inputs'] = [encode_stack(stack) for stack in recipe['inputs']]
        encoded['outputs'] = [encode_stack(stack) for stack in recipe['outputs']]
        recipes.append(encoded)

    return {
        **catalog,
        'items': [{key: value for key, value in item.items() if key not in ITEM_METADATA_FIELDS}
                  for item in catalog['items']],
        'recipes': recipes,
        'runtimeFormat': RUNTIME_FORMAT,
        'sharedStacks': shared,
    }
