'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createPlanner, pathsForNode} = require('./planner-engine.js');

const stack = (itemId, count = 1, extra = {}) => ({itemId, count, ...extra});
const recipe = (id, inputs, outputs, extra = {}) => ({id, type: 'crafting', machine: 'Верстак', inputs, outputs, ...extra});
function fixture(ids, recipes, extra = {}) {
  return {schemaVersion: 1, meta: {}, mods: [], items: ids.map(id => typeof id === 'string' ? {id, name: id} : id), recipes, ...extra};
}
const amount = (rows, id) => rows.filter(row => row.itemId === id).reduce((sum, row) => sum + row.count, 0);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

test('same pure API loads in a browser/worker global and Node', () => {
  const sandbox = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'planner-engine.js'), 'utf8'), sandbox);
  assert.equal(typeof sandbox.UniLandPlanner.createPlanner, 'function');
  assert.equal(typeof sandbox.UniLandPlanner.pathsForNode, 'function');
  assert.equal(sandbox.UniLandPlanner.createPlanner(fixture(['ore'], [])).plan({target: {itemId: 'ore', count: 2}}).baseMaterials[0].count, 2);
  assert.equal(typeof createPlanner, 'function');
});

test('output yields round to batches and carry surplus through a chain', () => {
  const engine = createPlanner(fixture(['ore', 'ingot', 'gear'], [
    recipe('smelt', [stack('ore')], [stack('ingot', 3)], {type: 'smelting', duration: 200, energyCost: 40, conditions: ['Температура: 600']}),
    recipe('gear', [stack('ingot', 2)], [stack('gear')])
  ]));
  const result = engine.plan({target: {itemId: 'gear', count: 2}});
  assert.equal(result.complete, true);
  assert.equal(amount(result.baseMaterials, 'ore'), 2);
  assert.equal(amount(result.leftovers, 'ingot'), 2);
  assert.deepEqual(result.steps.map(step => [step.recipeId, step.batches]), [['smelt', 2], ['gear', 2]]);
  assert.equal(result.steps[0].duration, 200);
  assert.equal(result.steps[0].energyCost, 40);
  assert.deepEqual(result.steps[0].conditions, ['Температура: 600']);
});

test('shared branches consume existing intermediate leftovers instead of double-counting', () => {
  const engine = createPlanner(fixture(['ore', 'plate', 'a', 'b', 'kit'], [
    recipe('plates', [stack('ore')], [stack('plate', 4)]),
    recipe('a', [stack('plate', 3)], [stack('a')]),
    recipe('b', [stack('plate', 3)], [stack('b')]),
    recipe('kit', [stack('a'), stack('b')], [stack('kit')])
  ]));
  const result = engine.plan({target: {itemId: 'kit', count: 1}});
  assert.equal(amount(result.baseMaterials, 'ore'), 2);
  assert.equal(amount(result.leftovers, 'plate'), 2);
  assert.equal(result.steps.filter(step => step.recipeId === 'plates').reduce((sum, step) => sum + step.batches, 0), 2);
  const secondPlate = result.nodes.find(node => node.id === 'root/in:1/in:0');
  assert.equal(secondPlate.reused, 1);
  assert.ok(secondPlate.allocations.some(lot => lot.sourceNode === 'root/in:0/in:0'));
});

test('coproducts supply sibling branches even when the sibling is listed first', () => {
  for (const inputs of [[stack('a', 2), stack('b', 2)], [stack('b', 2), stack('a', 2)]]) {
    const engine = createPlanner(fixture(['ore', 'a', 'b', 'kit'], [
      recipe('split', [stack('ore')], [stack('a', 2), stack('b', 3)]),
      recipe('expensive-b', [stack('ore', 10)], [stack('b')]),
      recipe('kit', inputs, [stack('kit')])
    ]));
    const result = engine.plan({target: {itemId: 'kit', count: 1}, itemRecipes: {b: 'expensive-b'}});
    assert.equal(amount(result.baseMaterials, 'ore'), 1);
    assert.equal(amount(result.leftovers, 'b'), 1);
    assert.deepEqual(result.steps.map(step => step.recipeId), ['split', 'kit']);
    assert.equal(result.root.children[0].id, 'root/in:0');
  }
});

test('variant-specific quantities and exclusive alternatives are honored', () => {
  const engine = createPlanner(fixture(['ore', 'dust', 'part'], [recipe('part', [stack('ore', 2, {
    alternatives: ['ore', 'dust'], variants: [stack('ore', 2), stack('dust', 5)]
  })], [stack('part')])]));
  const result = engine.plan({target: {itemId: 'part', count: 3}, inputChoices: {'root/in:0': 1}});
  assert.equal(amount(result.baseMaterials, 'dust'), 15);
  assert.equal(amount(result.baseMaterials, 'ore'), 0);
  assert.equal(result.root.inputOptions[0].selected, 1);
  assert.equal(result.root.inputOptions[0].key, 'root/in:0');
  assert.equal(result.root.children.length, 1);
  assert.equal(engine.plan({target: {itemId: 'part', count: 3}, inputChoices: {'root/in:0': 'ore'}}).baseMaterials[0].count, 6);
});

test('alternatives without variants inherit the stack amount; available inventory can choose one', () => {
  const engine = createPlanner(fixture(['wood-a', 'wood-b', 'part'], [
    recipe('part', [stack('wood-a', 2, {alternatives: ['wood-a', 'wood-b']})], [stack('part')])
  ]));
  const result = engine.plan({target: {itemId: 'part', count: 1}, inventory: {'wood-b': 2}});
  assert.equal(result.root.inputOptions[0].choices.length, 2);
  assert.equal(result.root.inputOptions[0].choices[result.root.inputOptions[0].selected].itemId, 'wood-b');
  assert.equal(result.baseMaterials.length, 0);
});

test('per-node choices override per-item defaults and preserve stable branch paths', () => {
  const engine = createPlanner(fixture(['ore-a', 'ore-b', 'part', 'kit'], [
    recipe('from-a', [stack('ore-a')], [stack('part')]),
    recipe('from-b', [stack('ore-b')], [stack('part')]),
    recipe('kit', [stack('part'), stack('part')], [stack('kit')])
  ]));
  const result = engine.plan({target: {itemId: 'kit', count: 1}, itemRecipes: {part: 'from-b'}, recipeChoices: {'root/in:0': 'from-a'}});
  assert.equal(amount(result.baseMaterials, 'ore-a'), 1);
  assert.equal(amount(result.baseMaterials, 'ore-b'), 1);
  assert.deepEqual(result.root.children.map(node => [node.id, node.recipeId]), [['root/in:0', 'from-a'], ['root/in:1', 'from-b']]);
});

test('invalid saved recipe/input/output choices remain explicit unresolved errors', () => {
  const engine = createPlanner(fixture(['ore', 'part', 'unrelated'], [recipe('part', [stack('ore')], [stack('part')])]));
  assert.equal(engine.plan({target: 'part', inputChoices: {'root/in:0': 4}}).root.reason, 'invalid-input-choice');
  assert.equal(engine.plan({target: 'part', outputChoices: {'root/out:0': 4}}).root.reason, 'invalid-output-choice');
  assert.equal(engine.plan({target: 'part', recipeChoices: {root: 'gone'}}).root.reason, 'missing-recipe');
  assert.equal(engine.plan({target: 'unrelated', recipeChoices: {root: 'part'}}).root.reason, 'recipe-does-not-produce');
});

test('output variants are all discoverable but never credited as simultaneous coproducts', () => {
  const engine = createPlanner(fixture(['ore', 'a', 'b'], [recipe('variants', [stack('ore')], [stack('a', 1, {
    alternatives: ['a', 'b'], variants: [stack('a'), stack('b', 4)]
  })])]));
  assert.equal(engine.recipesFor('b')[0].yield, 4);
  assert.equal(engine.recipesFor('b')[0].uncertain, true);
  const result = engine.plan({target: 'b', outputChoices: {'root/out:0': 1}});
  assert.equal(result.root.reason, 'output-variants');
  assert.equal(result.complete, false);
  assert.equal(result.steps.length, 0);
  assert.equal(result.leftovers.length, 0);
});

test('reversible cycles do not bootstrap material, while a viable raw route wins', () => {
  const conversions = [recipe('00-a-from-b', [stack('b')], [stack('a', 9)]), recipe('01-b-from-a', [stack('a', 9)], [stack('b')])];
  const cyclic = createPlanner(fixture(['a', 'b'], conversions)).plan({target: {itemId: 'a', count: 9}});
  assert.equal(cyclic.complete, false);
  assert.ok(cyclic.unresolvedMaterials.some(row => row.reason === 'cycle'));
  assert.equal(cyclic.baseMaterials.length, 0);
  assert.ok(cyclic.steps.every(step => step.conditional));
  const engine = createPlanner(fixture(['a', 'b', 'ore'], [...conversions, recipe('99-smelt-a', [stack('ore')], [stack('a')])]));
  const result = engine.plan({target: {itemId: 'a', count: 9}});
  assert.equal(result.complete, true);
  assert.equal(result.root.recipeId, '99-smelt-a');
  assert.equal(amount(result.baseMaterials, 'ore'), 9);
});

test('revisiting an item with a different explicit recipe is not falsely called a cycle', () => {
  const engine = createPlanner(fixture(['a', 'b', 'ore'], [
    recipe('a-from-b', [stack('b')], [stack('a')]), recipe('b-from-a', [stack('a')], [stack('b')]), recipe('a-from-ore', [stack('ore')], [stack('a')])
  ]));
  const result = engine.plan({target: 'a', recipeChoices: {root: 'a-from-b', 'root/in:0': 'b-from-a', 'root/in:0/in:0': 'a-from-ore'}});
  assert.equal(result.complete, true);
  assert.equal(amount(result.baseMaterials, 'ore'), 1);
  assert.equal(result.steps.length, 3);
});

test('inventory can satisfy the target and user-base deliberately stops expansion', () => {
  const engine = createPlanner(fixture(['a', 'b'], [recipe('a', [stack('b')], [stack('a')]), recipe('b', [stack('a')], [stack('b')])]));
  const stocked = engine.plan({target: {itemId: 'a', count: 2}, inventory: {a: 3}});
  assert.equal(stocked.root.status, 'reuse');
  assert.equal(stocked.steps.length, 0);
  assert.equal(amount(stocked.leftovers, 'a'), 1);
  const stopped = engine.plan({target: {itemId: 'a', count: 2}, baseItems: ['a']});
  assert.equal(stopped.root.reason, 'user-base');
  assert.equal(stopped.complete, true);
  assert.equal(stopped.baseMaterials[0].count, 2);
});

test('explicit catalysts are reused across batches and nested sequential operations', () => {
  const engine = createPlanner(fixture(['tool', 'ore', 'part', 'kit'], [
    recipe('part', [stack('ore'), stack('tool', 1, {role: 'catalyst'})], [stack('part')]),
    recipe('kit', [stack('tool', 1, {role: 'catalyst'}), stack('part', 2)], [stack('kit')])
  ]));
  const result = engine.plan({target: {itemId: 'kit', count: 2}});
  assert.equal(result.complete, true);
  assert.equal(amount(result.baseMaterials, 'tool'), 1);
  assert.equal(amount(result.baseMaterials, 'ore'), 4);
  assert.equal(amount(result.leftovers, 'tool'), 1);
  assert.equal(result.steps[0].batches, 4);
  assert.equal(result.steps[0].inputs.find(input => input.role === 'catalyst').count, 1);
  assert.equal(result.root.children[0].status, 'reuse');
});

test('two simultaneous catalyst slots require two tools, rather than sharing one', () => {
  const engine = createPlanner(fixture(['tool', 'part'], [recipe('part', [stack('tool', 1, {role: 'catalyst'}), stack('tool', 1, {role: 'catalyst'})], [stack('part')])]));
  const result = engine.plan({target: {itemId: 'part', count: 10}});
  assert.equal(amount(result.baseMaterials, 'tool'), 2);
  assert.equal(amount(result.leftovers, 'tool'), 2);
  assert.equal(result.root.children.length, 1);
  assert.equal(result.root.children[0].count, 2);
  assert.deepEqual(result.root.children[0].inputIndexes, [0, 1]);
});

function materialTotals(rows) {
  return rows.map(row => [row.key, row.reason || '', row.count, !!row.conditional]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('identical grid slots become one quantified route while every slot remains configurable', () => {
  const inputs = ['wire', 'redstone', 'wire', 'wire', 'plate', 'wire', 'wire', 'redstone', 'wire']
    .map((id, slot) => stack(id, 1, {slot, screenX: slot % 3 * 18, screenY: Math.floor(slot / 3) * 18}));
  const engine = createPlanner(fixture(['metal', 'rubber', 'wire', 'redstone', 'plate', 'circuit'], [
    recipe('wire', [stack('metal'), stack('rubber')], [stack('wire', 3)]), recipe('circuit', inputs, [stack('circuit')])
  ]));
  const options = {target: {itemId: 'circuit', count: 2}, inventory: {wire: 2}};
  const compact = engine.plan(options), expanded = engine.plan({...options, compactInputs: false});
  assert.equal(expanded.root.children.length, 9);
  assert.equal(compact.root.children.length, 3);
  assert.deepEqual(compact.root.children.map(node => [node.itemId, node.count]), [['wire', 12], ['redstone', 4], ['plate', 2]]);
  assert.equal(compact.root.children[0].batches, 4);
  assert.deepEqual(compact.root.children[0].inputIndexes, [0, 2, 3, 5, 6, 8]);
  assert.deepEqual(compact.root.children[0].aliasNodeIds, ['root/in:2', 'root/in:3', 'root/in:5', 'root/in:6', 'root/in:8']);
  assert.equal(compact.root.inputOptions.length, 9);
  assert.equal(compact.steps.at(-1).inputs.length, 9);
  assert.deepEqual(materialTotals(compact.baseMaterials), materialTotals(expanded.baseMaterials));
  assert.deepEqual(materialTotals(compact.leftovers), materialTotals(expanded.leftovers));
  assert.equal(compact.complete, expanded.complete);
});

test('different variant sets and explicit slot choices are never silently merged', () => {
  const sameVariants = [stack('a'), stack('b', 3)];
  const engine = createPlanner(fixture(['a', 'b', 'c', 'part'], [recipe('part', [
    stack('a', 1, {variants: sameVariants}), stack('a', 1, {variants: sameVariants}),
    stack('a', 1, {variants: [stack('a'), stack('c', 3)]})
  ], [stack('part')])]));
  assert.equal(engine.plan({target: 'part'}).root.children.length, 2);
  const explicitlySeparate = engine.plan({target: 'part', inputChoices: {'root/in:0': 0}});
  assert.equal(explicitlySeparate.root.children.length, 3);
  const different = engine.plan({target: 'part', inputChoices: {'root/in:0': 1, 'root/in:1': 0}});
  assert.equal(different.root.children.length, 3);
  assert.equal(amount(different.baseMaterials, 'b'), 3);
  assert.equal(amount(different.baseMaterials, 'a'), 2);
});

test('nested group aliases apply a recipe choice to every original occurrence without splitting the group', () => {
  const engine = createPlanner(fixture(['ore-a', 'ore-b', 'rod', 'part', 'kit'], [
    recipe('a-rod', [stack('ore-a')], [stack('rod')]), recipe('b-rod', [stack('ore-b')], [stack('rod')]),
    recipe('part', [stack('rod'), stack('rod')], [stack('part')]), recipe('kit', [stack('part'), stack('part')], [stack('kit')])
  ]));
  const initial = engine.plan({target: 'kit'});
  const rod = initial.root.children[0].children[0];
  assert.equal(rod.count, 4);
  const paths = pathsForNode(initial, rod.id);
  assert.deepEqual(paths, ['root/in:0/in:0', 'root/in:0/in:1', 'root/in:1/in:0', 'root/in:1/in:1']);
  const recipeChoices = Object.fromEntries(paths.map(path => [path, 'b-rod']));
  const changed = engine.plan({target: 'kit', recipeChoices});
  assert.equal(changed.root.children.length, 1);
  assert.equal(changed.root.children[0].children.length, 1);
  assert.equal(changed.root.children[0].children[0].recipeId, 'b-rod');
  assert.equal(amount(changed.baseMaterials, 'ore-b'), 4);
  assert.equal(amount(changed.baseMaterials, 'ore-a'), 0);
  // A pre-existing choice for only one occurrence must retain its own branch.
  const separate = engine.plan({target: 'kit', recipeChoices: {'root/in:1/in:0': 'b-rod'}});
  assert.equal(separate.root.children.length, 2);
  assert.equal(amount(separate.baseMaterials, 'ore-b'), 1);
  assert.equal(amount(separate.baseMaterials, 'ore-a'), 3);
});

test('nested grouped input choices preserve all source quantities', () => {
  const engine = createPlanner(fixture(['ore', 'dust', 'rod', 'part', 'kit'], [
    recipe('rod', [stack('ore', 1, {variants: [stack('ore'), stack('dust', 3)]})], [stack('rod')]),
    recipe('part', [stack('rod'), stack('rod')], [stack('part')]), recipe('kit', [stack('part'), stack('part')], [stack('kit')])
  ]));
  const initial = engine.plan({target: 'kit'}), rod = initial.root.children[0].children[0];
  const inputChoices = Object.fromEntries(pathsForNode(initial, rod.id).map(path => [path + '/in:0', 1]));
  const changed = engine.plan({target: 'kit', inputChoices});
  assert.equal(changed.root.children.length, 1);
  assert.equal(changed.root.children[0].children.length, 1);
  assert.equal(amount(changed.baseMaterials, 'dust'), 12);
  assert.equal(amount(changed.baseMaterials, 'ore'), 0);
});

test('alias expansion is lazy and explicitly bounded instead of creating an exponential result', () => {
  const nodes = [{id: 'root', parentId: null, aliasNodeIds: []}];
  for (let depth = 0; depth < 14; depth++) {
    const parent = nodes.at(-1);
    nodes.push({id: parent.id + '/in:0', parentId: parent.id, aliasNodeIds: [parent.id + '/in:1']});
  }
  const plan = {nodes};
  assert.equal(nodes.length, 15);
  assert.deepEqual(pathsForNode(plan, 'root'), ['root']);
  assert.throws(() => pathsForNode(plan, nodes.at(-1).id), error => error instanceof RangeError && error.code === 'PLANNER_ALIAS_LIMIT');
  assert.throws(() => pathsForNode(plan, 'missing'), error => error.code === 'PLANNER_NODE_NOT_FOUND');
});

test('probability needs an explicit average mode and is never a guaranteed finite batch count', () => {
  const engine = createPlanner(fixture(['ore', 'gem'], [recipe('wash', [stack('ore')], [stack('gem', 1, {chance: 0.25})], {type: 'wash'})]));
  const guaranteed = engine.plan({target: {itemId: 'gem', count: 3}});
  assert.equal(guaranteed.root.reason, 'probabilistic-output');
  assert.equal(guaranteed.complete, false);
  assert.equal(guaranteed.steps.length, 0);
  const expected = engine.plan({target: {itemId: 'gem', count: 3}, chancePolicy: 'expected'});
  assert.equal(expected.root.batches, 12);
  assert.equal(amount(expected.baseMaterials, 'ore'), 12);
  assert.equal(expected.approximate, true);
  assert.equal(expected.steps[0].outputs[0].availableCount, 3);
  assert.ok(expected.issues.some(issue => issue.code === 'expected-output'));
});

test('unguaranteed side products cannot silently satisfy another required branch', () => {
  const engine = createPlanner(fixture(['ore', 'a', 'b', 'kit'], [
    recipe('a', [stack('ore')], [stack('a'), stack('b', 1, {chance: 0.5})]),
    recipe('b', [stack('ore', 2)], [stack('b')]), recipe('kit', [stack('a'), stack('b')], [stack('kit')])
  ]));
  const result = engine.plan({target: 'kit'});
  assert.equal(amount(result.baseMaterials, 'ore'), 3);
  assert.equal(result.approximate, false);
  assert.ok(result.issues.some(issue => issue.code === 'uncertain-byproduct'));
});

test('zero probability cannot be inverted even in average mode', () => {
  const engine = createPlanner(fixture(['ore', 'gem'], [recipe('none', [stack('ore')], [stack('gem', 1, {chance: 0})])]));
  const result = engine.plan({target: 'gem', chancePolicy: 'expected'});
  assert.equal(result.root.reason, 'zero-chance');
  assert.equal(result.steps.length, 0);
});

test('native rules and known unnormalized machine mechanics remain unresolved', () => {
  const engine = createPlanner(fixture(['ore', 'comb', 'honey'], [
    recipe('native', [stack('ore')], [], {operation: 'native-rule', sources: [{file: 'raw/rule.json'}], detailsFile: 'data/rule.json'}),
    recipe('centrifuge', [stack('comb')], [stack('honey')], {type: 'forestry.centrifuge', detailsFile: 'data/centrifuge.json'})
  ]));
  assert.equal(engine.recipesFor('ore').length, 0);
  assert.equal(engine.plan({target: 'ore', recipeChoices: {root: 'native'}}).root.reason, 'unknown-output');
  assert.equal(engine.plan({target: 'honey'}).root.reason, 'details-required');
});

test('fuel/material reference displays never become manufacturing routes', () => {
  const engine = createPlanner(fixture(['sequence', 'stick'], [recipe('fuel', [stack('sequence')], [stack('stick')], {type: 'fuel'})]));
  assert.equal(engine.recipesFor('stick')[0].reference, true);
  const result = engine.plan({target: 'stick'});
  assert.equal(result.root.reason, 'no-recipe');
  assert.equal(result.steps.length, 0);
  assert.equal(amount(result.baseMaterials, 'stick'), 1);
  assert.equal(engine.plan({target: 'stick', recipeChoices: {root: 'fuel'}}).root.reason, 'reference-only');
});

test('empty display inputs never imply free material; a real material route wins', () => {
  const empty = recipe('00-empty-display', [], [stack('ingot')], {type: 'crystallization_cooling_complex'});
  const engine = createPlanner(fixture(['ore', 'ingot'], [empty, recipe('99-smelt', [stack('ore')], [stack('ingot')])]));
  const selected = engine.plan({target: 'ingot'});
  assert.equal(selected.root.recipeId, '99-smelt');
  assert.equal(amount(selected.baseMaterials, 'ore'), 1);
  const explicit = engine.plan({target: 'ingot', recipeChoices: {root: empty.id}});
  assert.equal(explicit.root.reason, 'unknown-input');
  assert.equal(explicit.complete, false);
  assert.equal(explicit.steps.length, 0);
});

test('exact metadata IDs and stack NBT variants never merge; fluid units remain explicit', () => {
  const engine = createPlanner(fixture(['ore-a', 'ore-b', 'battery@0', 'battery@1#charged', 'kit', {id: 'fluid:f', name: 'f', kind: 'fluid'}], [
    recipe('fluid-a', [stack('ore-a')], [stack('fluid:f', 250, {nbt: {tag: 'a'}})]),
    recipe('fluid-b', [stack('ore-b')], [stack('fluid:f', 200, {nbt: {tag: 'b'}})]),
    recipe('kit', [stack('fluid:f', 100, {nbt: {tag: 'a'}}), stack('fluid:f', 100, {nbt: {tag: 'b'}}), stack('battery@0'), stack('battery@1#charged')], [stack('kit')])
  ]));
  const result = engine.plan({target: 'kit'});
  assert.equal(amount(result.baseMaterials, 'ore-a'), 1);
  assert.equal(amount(result.baseMaterials, 'ore-b'), 1);
  assert.equal(amount(result.baseMaterials, 'battery@0'), 1);
  assert.equal(amount(result.baseMaterials, 'battery@1#charged'), 1);
  const fluids = result.leftovers.filter(row => row.itemId === 'fluid:f');
  assert.deepEqual(fluids.map(row => [row.nbt.tag, row.count, row.unit]), [['a', 150, 'mB'], ['b', 100, 'mB']]);
  assert.notEqual(engine.resourceKey({itemId: 'fluid:f', unit: 'L'}), engine.resourceKey({itemId: 'fluid:f', unit: 'mB'}));
  assert.equal(engine.resourceKey({itemId: 'fluid:f', nbt: {a: 1, b: 2}}), engine.resourceKey({itemId: 'fluid:f', nbt: {b: 2, a: 1}}));
});

test('fractional amounts survive batching without turning floating residue into another craft', () => {
  const engine = createPlanner(fixture(['ore', {id: 'fluid:f', name: 'f', kind: 'fluid'}], [recipe('fluid', [stack('ore')], [stack('fluid:f', 0.4)])]));
  const result = engine.plan({target: {itemId: 'fluid:f', count: 0.7}});
  assert.equal(result.root.batches, 2);
  assert.equal(amount(result.baseMaterials, 'ore'), 2);
  close(amount(result.leftovers, 'fluid:f'), 0.1);
});

test('bounded node/depth expansion reports unresolved requirements and never silently truncates', () => {
  const wide = createPlanner(fixture(['ore', 'kit'], [recipe('kit', Array.from({length: 10}, () => stack('ore')), [stack('kit')])]));
  const limited = wide.plan({target: 'kit', maxNodes: 3, compactInputs: false});
  assert.equal(limited.nodes.length, 3);
  assert.equal(limited.root.truncatedChildren, 8);
  assert.equal(amount(limited.baseMaterials, 'ore'), 2);
  assert.equal(amount(limited.unresolvedMaterials, 'ore'), 8);
  assert.equal(limited.complete, false);
  assert.equal(limited.steps[0].conditional, true);
  const compact = wide.plan({target: 'kit', maxNodes: 3});
  assert.equal(compact.nodes.length, 2);
  assert.equal(compact.complete, true);
  assert.equal(amount(compact.baseMaterials, 'ore'), 10);
  const deep = createPlanner(fixture(['ore', 'a', 'b'], [recipe('a', [stack('ore')], [stack('a')]), recipe('b', [stack('a')], [stack('b')])]));
  assert.equal(deep.plan({target: 'b', maxDepth: 1}).root.children[0].reason, 'max-depth');
});

test('unknown IDs and unsafe quantities are explicit errors', () => {
  const engine = createPlanner(fixture(['ore', 'part'], [recipe('part', [stack('ore', 2)], [stack('part')])]));
  assert.equal(engine.plan({target: 'unknown'}).root.reason, 'missing-item');
  for (const count of [0, -1, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const result = engine.plan({target: {itemId: 'part', count}});
    assert.equal(result.root.reason, 'invalid-quantity');
    assert.equal(result.complete, false);
  }
  assert.equal(engine.plan({target: {itemId: 'part', count: Number.MAX_SAFE_INTEGER}}).root.reason, 'quantity-overflow');
  const large = createPlanner(fixture(['ore', 'part'], [recipe('part', [stack('ore', Number.MAX_SAFE_INTEGER), stack('ore', Number.MAX_SAFE_INTEGER)], [stack('part')])]));
  const combined = large.plan({target: 'part', compactInputs: false});
  assert.equal(combined.complete, false);
  assert.equal(combined.baseMaterials[0].overflow, true);
  assert.equal(combined.approximate, true);
  assert.equal(large.plan({target: 'part'}).root.reason, 'quantity-overflow');
});

test('frozen shared arrays are read-only, results deterministic and structured-cloneable', () => {
  const variants = [stack('a'), stack('b')];
  const catalog = freeze(fixture(['a', 'b', 'part'], [recipe('part', [stack('a', 1, {variants, alternatives: ['a', 'b']})], [stack('part')])]));
  const before = JSON.stringify(catalog);
  const engine = createPlanner(catalog);
  const one = engine.plan({target: 'part'}), two = engine.plan({target: 'part'});
  assert.deepEqual(one, two);
  assert.deepEqual(structuredClone(one), one);
  assert.equal(JSON.stringify(catalog), before);
});

const catalogPath = path.join(__dirname, 'catalog.json');
let actualCatalog;
function loadActualCatalog() {
  if (!actualCatalog) actualCatalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  return actualCatalog;
}
test('actual catalog subset preserves molten-metal yield, output variant coverage, and non-producing native/fuel rules', {skip: !fs.existsSync(catalogPath)}, () => {
  // Parse the 56 MB source once, and exercise a small real dependency subgraph.
  const catalog = loadActualCatalog();
  const melt = catalog.recipes.find(row => row.id === 'recipe:b7b074c16c96acc744310c2b687e947bcd4628f069d1f9bef55d1648de07fb5f');
  assert.ok(melt, 'expected actual iron-ore melting record');
  const sampler = catalog.recipes.find(row => row.type === 'jgendustry.sampler' && row.outputs.some(output => output.variants?.length > 1));
  const native = catalog.recipes.find(row => row.operation === 'native-rule' && !row.outputs.length);
  const fuel = catalog.recipes.find(row => row.type === 'fuel' && row.outputs.some(output => output.itemId === 'minecraft:stick@0'));
  assert.ok(sampler && native && fuel);
  const selected = [melt, sampler, native, fuel];
  const usedIds = new Set();
  for (const row of selected) for (const value of [...row.inputs, ...row.outputs]) {
    usedIds.add(value.itemId);
    for (const id of value.alternatives || []) usedIds.add(id);
    for (const variant of value.variants || []) usedIds.add(variant.itemId);
  }
  const engine = createPlanner({...catalog, items: catalog.items.filter(item => usedIds.has(item.id)), recipes: selected});
  const result = engine.plan({target: {itemId: 'fluid:iron.molten', count: 500}});
  assert.equal(result.root.batches, 2);
  assert.equal(amount(result.baseMaterials, 'minecraft:iron_ore@0'), 2);
  assert.equal(amount(result.leftovers, 'fluid:iron.molten'), 76);
  assert.equal(result.leftovers[0].unit, 'mB');
  assert.deepEqual(result.steps[0].conditions, melt.conditions || []);
  const variant = sampler.outputs.find(output => output.variants?.length > 1).variants.at(-1);
  assert.ok(engine.recipesFor(variant.itemId).some(option => option.id === sampler.id));
  assert.equal(engine.plan({target: variant.itemId, recipeChoices: {root: sampler.id}}).root.reason, 'details-required');
  assert.equal(engine.plan({target: native.inputs[0].itemId, recipeChoices: {root: native.id}}).root.reason, 'unknown-output');
  assert.equal(engine.plan({target: 'minecraft:stick@0'}).root.reason, 'no-recipe');
});

test('actual IC2 circuit has three primary branches with unchanged total materials and leftovers', {skip: !fs.existsSync(catalogPath)}, () => {
  const engine = createPlanner(loadActualCatalog());
  const options = {target: {itemId: 'IC2:itemPartCircuit@0', count: 1}, maxNodes: 1500};
  const expanded = engine.plan({...options, compactInputs: false});
  const compact = engine.plan(options);
  assert.equal(expanded.root.children.length, 9);
  assert.equal(compact.root.children.length, 3);
  assert.deepEqual(compact.root.children.map(node => [node.itemId, node.count]), [
    ['IC2:itemCable@0', 6], ['uniresources:dustRedstone@0', 2], ['uniresources:plateIron@0', 1]
  ]);
  assert.equal(compact.root.inputOptions.length, 9);
  assert.deepEqual(pathsForNode(compact, 'root/in:0'), ['root/in:0', 'root/in:2', 'root/in:3', 'root/in:5', 'root/in:6', 'root/in:8']);
  assert.deepEqual(materialTotals(compact.baseMaterials), materialTotals(expanded.baseMaterials));
  assert.deepEqual(materialTotals(compact.unresolvedMaterials), materialTotals(expanded.unresolvedMaterials));
  assert.deepEqual(materialTotals(compact.leftovers), materialTotals(expanded.leftovers));
  assert.equal(compact.complete, expanded.complete);
});
