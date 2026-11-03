'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {decode, FORMAT} = require('./runtime.js');
const copy = value => JSON.parse(JSON.stringify(value));

const packed = {
  schemaVersion: 1, runtimeFormat: FORMAT,
  meta: {status: 'partial', exportedAt: '2026-11-03T00:00:00Z'},
  mods: [{id: 'mod', name: 'Мод'}],
  items: [
    {id: 'mod:item@0#exact-nbt', name: 'Предмет', nbt: {type: {value: 'original'}}, futureItem: {keep: true}},
    {id: 'mod:fluid', name: 'Жидкость', kind: 'fluid'}
  ],
  recipes: [{
    id: 'recipe:one', type: 'machine', conditions: ['Одна проверка'],
    inputs: [
      {itemId: 0, count: 2.5, alternatives: 0, variants: 0, role: 'catalyst', consumed: false,
        nbt: {display: ['original stack NBT']}, futureStack: {itemId: 'opaque-literal', value: [null, false, 7]}},
      {itemId: 0, count: 4, alternatives: 0, variants: 0}
    ],
    outputs: [{itemId: 1, count: 1000, unit: 'mB', chance: 0.25}],
    detailsFile: 'data/recipe-details/exact.json', futureRecipe: {keep: true}
  }, {
    id: 'recipe:native', type: 'native', operation: 'native-rule', inputs: [], outputs: [],
    sources: [{path: 'native/source', exact: true}], detailsFile: 'data/recipe-details/native.json'
  }],
  sharedStacks: {
    alternatives: [[0, 1]],
    variants: [[{itemId: 0, count: 2.5, chance: 0.5, role: 'catalyst', consumed: false,
      unit: 'mB', nbt: {exact: [1, 'value']}, futureVariant: {itemId: 'not-a-reference'}}]]
  },
  futureCatalog: {keep: true}
};
const original = copy(packed);
const decoded = decode(packed);
assert.deepEqual(packed, original, 'decoding must not change its input');
assert.ok(!Object.hasOwn(decoded, 'runtimeFormat') && !Object.hasOwn(decoded, 'sharedStacks'));
assert.deepEqual(decoded.items, original.items);
assert.deepEqual(decoded.futureCatalog, original.futureCatalog);
assert.deepEqual(decoded.recipes[1], original.recipes[1]);
const first = decoded.recipes[0].inputs[0];
const second = decoded.recipes[0].inputs[1];
assert.equal(first.itemId, original.items[0].id);
assert.deepEqual(first.alternatives, original.items.map(item => item.id));
assert.strictEqual(first.alternatives, second.alternatives, 'alternatives must stay shared');
assert.strictEqual(first.variants, second.variants, 'variants must stay shared');
assert.deepEqual(first.futureStack, original.recipes[0].inputs[0].futureStack);
assert.deepEqual(first.nbt, original.recipes[0].inputs[0].nbt);
assert.deepEqual(first.variants[0], {...original.sharedStacks.variants[0][0], itemId: original.items[0].id});
assert.ok(Object.isFrozen(first.alternatives) && Object.isFrozen(first.variants));
assert.ok(Object.isFrozen(first.variants[0]) && Object.isFrozen(first.variants[0].nbt));
assert.ok(!Object.isFrozen(packed.sharedStacks.variants[0][0].nbt), 'caller values must not be frozen');
assert.throws(() => first.alternatives.push('wrong'), TypeError);
assert.throws(() => { first.variants[0].count = 999; }, TypeError);
assert.deepEqual(decoded.recipes[0].outputs[0], {...original.recipes[0].outputs[0], itemId: original.items[1].id});
assert.strictEqual(decode(decoded), decoded, 'complete v1 catalogs must pass through');
assert.strictEqual(decode(null), null);

for (const invalid of [-1, 2, 0.5, '0', null, false, Number.MAX_SAFE_INTEGER + 1]) {
  const bad = copy(packed); bad.recipes[0].inputs[0].itemId = invalid;
  assert.throws(() => decode(bad), /itemId/, `bad item reference ${String(invalid)}`);
}
for (const field of ['alternatives', 'variants']) {
  for (const invalid of [-1, 1, 0.5, '0', null, false]) {
    const bad = copy(packed); bad.recipes[0].inputs[0][field] = invalid;
    assert.throws(() => decode(bad), new RegExp(field), `bad ${field} reference`);
  }
}
for (const mutate of [
  raw => { raw.runtimeFormat = 'uniland-runtime-future'; },
  raw => { raw.schemaVersion = 2; },
  raw => { raw.sharedStacks = null; },
  raw => { raw.sharedStacks.alternatives[0] = [99]; },
  raw => { raw.sharedStacks.variants[0][0].itemId = 99; },
  raw => { raw.sharedStacks.variants[0] = null; },
  raw => { raw.items[0].id = 4; },
  raw => { raw.recipes[0].inputs = null; }
]) {
  const bad = copy(packed); mutate(bad);
  assert.throws(() => decode(bad), /runtime-каталог/);
}

// An optional pair of paths exercises the Python encoder and JS decoder together,
// including a real release, without copying images or the large detail archive.
if (process.argv.length > 2) {
  assert.equal(process.argv.length, 4, 'provide source catalog and runtime catalog');
  const source = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const wire = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
  const actual = decode(wire);
  const expected = {...source,
    items: source.items.map(item => {
      const {translationKey, translationSource, iconKind, nameError, fluidProperties, representativeItemId, ...kept} = item;
      return kept;
    }),
    recipes: source.recipes.map(recipe => {
      const {ruleClass, ...kept} = recipe;
      if (recipe.operation !== 'native-rule') delete kept.sources;
      return kept;
    })
  };
  assert.deepEqual(actual, expected, 'all retained fields must match the complete source exactly');
  console.log(JSON.stringify({items: actual.items.length, recipes: actual.recipes.length,
    nativeRules: actual.recipes.filter(recipe => recipe.operation === 'native-rule').length,
    sharedAlternatives: wire.sharedStacks.alternatives.length, sharedVariants: wire.sharedStacks.variants.length}));
}
console.log('Runtime decoder checks passed.');
