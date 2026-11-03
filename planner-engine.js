/*
 * UniLand production planner. No DOM, network, storage, or catalog mutations.
 * Browser / importScripts: UniLandPlanner.createPlanner(catalog).
 * Node: const {createPlanner} = require('./planner-engine.js').
 *
 * plan({target:{itemId,count,unit?,nbt?}, recipeChoices:{[nodeId]:recipeId},
 *   itemRecipes:{[itemId]:recipeId}, inputChoices:{[optionKey]:index|itemId},
 *   outputChoices:{[optionKey]:index|itemId}, baseItems:[itemId],
 *   inventory:{[itemId]:count} | [{itemId,count,unit?,nbt?}],
 *   chancePolicy:'guaranteed'|'expected', maxDepth:32, maxNodes:1500,
 *   compactInputs:true})
 *
 * Node IDs are paths: root, root/in:0, root/in:0/in:2. The option key for
 * input 0 is node.id + '/in:0'; outputs use '/out:0'. Index choices refer to
 * choices[].index, not a registry/meta ID. Per-node recipe choices override
 * itemRecipes. Changing an ancestor recipe may invalidate descendant choices;
 * invalid choices are reported, never silently replaced.
 * Identical sibling inputs are grouped before calculation. A grouped node's
 * inputIndexes lists its original slots; aliasNodeIds lists their other paths.
 * The parent's inputOptions and step.inputs always retain every original slot.
 * Different variants, explicit choices, or subtree settings prevent grouping.
 * Use UniLandPlanner.pathsForNode(plan, node.id) when changing a grouped route:
 * it expands that node's aliases and aliases of its ancestors only on demand.
 * The helper throws PLANNER_ALIAS_LIMIT above 4096 paths (optional limit <=
 * 10000), rather than silently applying a choice to only some occurrences.
 * compactInputs:false retains the ungrouped traversal for comparison/debugging.
 *
 * All amounts use exact item IDs (including their metadata/NBT suffix), unit,
 * and optional stack NBT as the resource identity. There is no unit conversion.
 * Alternatives are mutually exclusive; separate outputs are coproducts. Output
 * variants without a normalized relationship to inputs remain unresolved.
 * Explicit role:'catalyst' inputs are acquired once per sequential batch group
 * and returned after the operation. Other inputs are consumed as recorded.
 *
 * A shared, chronological lot ledger reuses leftovers and coproducts. It never
 * credits an operation's outputs before its inputs. Missing/cyclic/uncertain
 * inputs become explicitly conditional external requirements, not free items.
 * complete means the selected material tree has no unresolved requirements;
 * it does not attest completeness of the catalog or unnormalized mechanics.
 * expected probability mode is an average, never a success guarantee.
 * Selection is deterministic and favors short acyclic routes. It is not a
 * global optimizer: different routes/order can have different total costs.
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UniLandPlanner = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_AMOUNT = Number.MAX_SAFE_INTEGER;
  const has = (object, key) => object != null && Object.prototype.hasOwnProperty.call(object, key);
  const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT;
  const tolerance = n => Number.EPSILON * 16 * Math.min(Math.abs(n), 1024);
  const tidy = n => Math.abs(n - Math.round(n)) <= tolerance(n) ? Math.round(n) : n;
  const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const pick = (object, key) => object instanceof Map ? object.get(key) : has(object, key) ? object[key] : undefined;

  // These are documented display semantics in this catalog, not manufacturing.
  // FuelRecipeHandler also lists its fuel slot among display outputs. Treating
  // that slot as a product would incorrectly manufacture sticks/planks, etc.
  const REFERENCE_TYPES = new Set(['fuel', 'tconstruct.materials']);
  // The current exporter does not normalize the corresponding chance, cast
  // consumption, breeding, or state rules from detailsFile. Do not infer them
  // from a displayed stack count. Ordinary crafting/machine types still work.
  const DETAILS_TYPES = new Set([
    'forestry.bee_products', 'forestry.bee_breeding', 'forestry.bee_mutation_tree',
    'forestry.tree_products', 'forestry.tree_breeding', 'botany.flower_breeding',
    'forestry.centrifuge', 'forestry.squeezer', 'tconstruct.casting_table',
    'tconstruct.casting_basin', 'jgendustry.sampler', 'jgendustry.transposer',
    'mob_drop', 'mob_soul_drop', 'scrapbox', 'loli_utility.item_drop'
  ]);

  const messages = {
    'no-recipe': 'Рецепт производства не найден в загруженном каталоге.',
    'user-base': 'Предмет отмечен как базовое сырьё.',
    'missing-item': 'Предмет отсутствует в каталоге.',
    'missing-recipe': 'Выбранный рецепт отсутствует в каталоге.',
    'recipe-does-not-produce': 'Выбранный рецепт не производит этот вариант ресурса.',
    'unknown-output': 'У правила нет определённого выхода; количество рассчитать нельзя.',
    'unknown-input': 'В записи нет входов. Бесплатное производство не предполагается: требуется проверка сырья и условий.',
    'reference-only': 'Это справочная запись, а не рецепт производства.',
    'details-required': 'Вероятность, состояние или расход инструмента не нормализованы. Нужна проверка деталей рецепта.',
    'output-variants': 'Варианты выхода зависят от условий, связь с выбранными входами не определена.',
    'probabilistic-output': 'Для вероятностного выхода нельзя гарантировать результат за конечное число операций.',
    'zero-chance': 'У выбранного выхода нулевая вероятность.',
    'invalid-input-choice': 'Выбранный вариант ингредиента не принадлежит этому рецепту.',
    'invalid-output-choice': 'Выбранный вариант выхода не принадлежит этому рецепту.',
    'invalid-quantity': 'Количество должно быть конечным положительным числом в безопасном диапазоне.',
    'invalid-stack': 'Количество или идентификатор стека не определены.',
    'quantity-overflow': 'Количество операций или ресурсов превышает безопасный числовой диапазон.',
    cycle: 'Обнаружен цикл рецептов. Выбери другой маршрут или отметь этот ресурс базовым.',
    'max-depth': 'Достигнута предельная глубина дерева.',
    'max-nodes': 'Достигнут предел числа узлов. Часть ветвей не раскрыта.',
    'expected-output': 'Количество рассчитано в среднем по вероятности; фактический результат может отличаться.',
    'uncertain-byproduct': 'Неопределённый или вероятностный побочный выход не учтён в доступных остатках.',
    'input-chance': 'Вероятность на входе не интерпретирована как экономия; учтён полный расход.',
    'catalog-partial': 'Каталог неполный: отсутствие рецепта не доказывает, что предмет является природным сырьём.',
    'catalog-quantities': 'Расчёт использует количества каталога. Энергия, время и особые условия показаны отдельно и не превращены в ингредиенты.'
  };

  function canonical(value) {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
  }

  function pathsForNode(plan, nodeId, limit = 4096) {
    const maximum = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 10000) : 4096;
    const byId = new Map((plan?.nodes || []).map(node => [node.id, node]));
    const node = byId.get(nodeId);
    if (!node) {
      const error = new Error('Узел плана не найден: ' + nodeId);
      error.code = 'PLANNER_NODE_NOT_FOUND'; throw error;
    }
    function add(set, path) {
      set.add(path);
      if (set.size > maximum) {
        const error = new RangeError('У группы слишком много эквивалентных путей: больше ' + maximum + '. Выбор не применён.');
        error.code = 'PLANNER_ALIAS_LIMIT'; throw error;
      }
    }
    let paths = new Set();
    for (const path of [node.id, ...(node.aliasNodeIds || [])]) add(paths, path);
    let parentId = node.parentId;
    const visited = new Set([nodeId]);
    while (parentId != null && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) break;
      if (parent.aliasNodeIds?.length) {
        const expanded = new Set();
        for (const prefix of [parent.id, ...parent.aliasNodeIds]) for (const path of paths) {
          const matches = path === parent.id || path.startsWith(parent.id + '/');
          add(expanded, matches ? prefix + path.slice(parent.id.length) : path);
        }
        paths = expanded;
      }
      parentId = parent.parentId;
    }
    return [...paths];
  }

  function createPlanner(catalog) {
    if (!catalog || !Array.isArray(catalog.items) || !Array.isArray(catalog.recipes)) {
      throw new TypeError('Planner requires catalog.items and catalog.recipes arrays.');
    }
    const items = new Map(catalog.items.map(item => [item.id, item]));
    const recipes = new Map();
    const producers = new Map();
    const compiled = new Map();
    const summaries = new Map();
    const depths = new Map();
    const recipeDepths = new Map();
    let depthsReady = false;

    function resource(stack) {
      const item = items.get(stack.itemId);
      const unit = stack.unit == null ? (stack.kind === 'fluid' || item?.kind === 'fluid' ? 'mB' : '') : String(stack.unit);
      const result = {itemId: stack.itemId, unit};
      if (stack.nbt != null) result.nbt = stack.nbt;
      result.key = JSON.stringify([result.itemId, unit, result.nbt == null ? null : canonical(result.nbt)]);
      return result;
    }

    function rawChoices(stack) {
      if (Array.isArray(stack.variants) && stack.variants.length) return stack.variants;
      const ids = [stack.itemId, ...(Array.isArray(stack.alternatives) ? stack.alternatives : [])];
      return [...new Set(ids)].map(itemId => itemId === stack.itemId ? stack : {...stack, itemId});
    }

    function choices(stack) {
      const list = [];
      for (const variant of rawChoices(stack)) {
        const value = {...stack, ...variant};
        const amount = value.count == null ? 1 : value.count;
        const choice = {...resource(value), index: list.length, count: amount, valid: typeof value.itemId === 'string' && positive(amount)};
        if (value.kind != null) choice.kind = value.kind;
        if (value.role != null) choice.role = value.role;
        if (value.chance != null) choice.chance = value.chance;
        if (value.sourceCount != null) choice.sourceCount = value.sourceCount;
        list.push(choice);
      }
      return list;
    }

    for (const recipe of catalog.recipes) {
      if (!recipe || typeof recipe.id !== 'string' || recipes.has(recipe.id)) continue;
      recipes.set(recipe.id, recipe);
      const outputIds = new Set();
      for (const stack of recipe.outputs || []) for (const option of rawChoices(stack)) outputIds.add(option.itemId);
      for (const itemId of outputIds) {
        if (!producers.has(itemId)) producers.set(itemId, []);
        producers.get(itemId).push(recipe.id);
      }
    }
    for (const list of producers.values()) list.sort(compare);

    function getCompiled(id) {
      if (compiled.has(id)) return compiled.get(id);
      const recipe = recipes.get(id);
      if (!recipe) return null;
      const inputStacks = recipe.inputs || [];
      const value = {recipe, inputs: inputStacks.map(choices), outputs: (recipe.outputs || []).map(choices),
        inputSignatures: inputStacks.map(stack => canonical(Object.fromEntries(Object.entries(stack)
          .filter(([field]) => !['slot', 'screenX', 'screenY'].includes(field)))))};
      compiled.set(id, value);
      return value;
    }

    function baseReasons(recipe) {
      if (REFERENCE_TYPES.has(recipe.type)) return ['reference-only'];
      if (recipe.operation === 'native-rule' || !recipe.outputs?.length) return ['unknown-output'];
      if (DETAILS_TYPES.has(recipe.type)) return ['details-required'];
      if (!recipe.inputs?.length) return ['unknown-input'];
      return [];
    }

    function recipesFor(itemId) {
      if (summaries.has(itemId)) return summaries.get(itemId);
      const result = (producers.get(itemId) || []).map(id => {
        const data = getCompiled(id), recipe = data.recipe;
        const reasons = baseReasons(recipe);
        let amount = 0, expectedYield = 0, hasVariants = false, hasChance = false;
        for (const group of data.outputs) {
          const option = group.find(o => o.itemId === itemId);
          if (!option) continue;
          if (option.valid) {
            amount += option.count;
            expectedYield += option.count * (option.chance == null ? 1 : option.chance);
          }
          if (group.length > 1) hasVariants = true;
          if (option.chance != null && option.chance < 1) hasChance = true;
        }
        if (hasVariants) reasons.push('output-variants');
        if (hasChance) reasons.push('probabilistic-output');
        return {id, type: recipe.type, machine: recipe.machine || recipe.type, yield: tidy(amount), expectedYield: tidy(expectedYield),
          uncertain: reasons.length > 0, reasons, reference: REFERENCE_TYPES.has(recipe.type),
          conditions: Array.isArray(recipe.conditions) ? recipe.conditions : [], detailsFile: recipe.detailsFile || null};
      });
      summaries.set(itemId, result);
      return result;
    }

    // Shortest dependency depth to an item with no manufacturing recipe.
    // A closed reversible component stays at Infinity; it cannot bootstrap
    // itself. This is only route ordering, never a proof of obtainability.
    function ensureDepths() {
      if (depthsReady) return;
      depthsReady = true;
      for (const id of items.keys()) {
        const producing = (producers.get(id) || []).some(rid => !REFERENCE_TYPES.has(recipes.get(rid).type));
        depths.set(id, producing ? Infinity : 0);
      }
      const usable = [];
      for (const recipe of recipes.values()) {
        if (baseReasons(recipe).length) continue;
        const outputIds = [];
        for (const stack of recipe.outputs || []) {
          const options = rawChoices(stack);
          if (options.length === 1 && (options[0].chance == null || options[0].chance === 1)) outputIds.push(options[0].itemId);
        }
        if (outputIds.length) usable.push({recipe, outputIds, inputs: (recipe.inputs || []).map(s => rawChoices(s).map(o => o.itemId))});
      }
      for (let pass = 0; pass < 64; pass++) {
        let changed = false;
        for (const entry of usable) {
          let depth = 0;
          for (const alternatives of entry.inputs) {
            let best = Infinity;
            for (const id of alternatives) best = Math.min(best, depths.get(id) ?? Infinity);
            depth = Math.max(depth, best);
          }
          depth += 1;
          recipeDepths.set(entry.recipe.id, depth);
          for (const id of entry.outputIds) if (depth < (depths.get(id) ?? Infinity)) {
            depths.set(id, depth); changed = true;
          }
        }
        if (!changed) break;
      }
    }

    function plan(options = {}) {
      ensureDepths();
      const targetInput = typeof options.target === 'string' ? {itemId: options.target, count: 1} : options.target || {};
      const target = {...resource(targetInput), count: targetInput.count == null ? 1 : targetInput.count};
      const maximum = (value, fallback, cap) => Number.isInteger(value) && value > 0 ? Math.min(value, cap) : fallback;
      const maxDepth = maximum(options.maxDepth, 32, 128);
      const maxNodes = maximum(options.maxNodes, 1500, 10000);
      const expectedMode = options.chancePolicy === 'expected';
      const compactInputs = options.compactInputs !== false;
      const baseItems = new Set(options.baseItems || []);
      const nodes = [], steps = [], issues = [];
      const ledger = new Map(), base = new Map(), unresolved = new Map();
      const issueKeys = new Set();
      let approximate = false;

      // Compare overrides relative to each original slot. Looking through the
      // entire subtree prevents compaction from discarding an old saved choice
      // under a non-representative slot. Nothing is expanded into combinations.
      const overrideEntries = ['recipeChoices', 'inputChoices', 'outputChoices'].map(kind => {
        const value = options[kind];
        return (value instanceof Map ? [...value.entries()] : Object.entries(value || {}))
          .filter(([key, choice]) => typeof key === 'string' && choice !== undefined)
          .sort((a, b) => compare(a[0], b[0]));
      });
      const branchSignatures = new Map();
      function branchSignature(path) {
        if (!branchSignatures.has(path)) branchSignatures.set(path, canonical(overrideEntries.map(entries => entries
          .filter(([key]) => key === path || key.startsWith(path + '/'))
          .map(([key, choice]) => [key.slice(path.length), choice]))));
        return branchSignatures.get(path);
      }

      function issue(code, node, extra = {}, severity = 'warning') {
        const key = [code, node?.id || '', extra.recipeId || ''].join('|');
        if (issueKeys.has(key)) return;
        issueKeys.add(key);
        issues.push({code, severity, nodeId: node?.id || null, itemId: node?.itemId || null, message: messages[code] || code, ...extra});
      }
      if (catalog.meta?.status === 'partial' || catalog.meta?.coverage?.complete === false) issue('catalog-partial');
      issue('catalog-quantities', null, {}, 'info');

      function credit(spec, count, lot) {
        if (!(count > 0)) return;
        if (!ledger.has(spec.key)) ledger.set(spec.key, {spec, lots: []});
        ledger.get(spec.key).lots.push({count, ...lot});
      }
      function available(spec) {
        return (ledger.get(spec.key)?.lots || []).reduce((sum, lot) => sum + lot.count, 0);
      }
      function take(spec, count) {
        const allocations = [];
        let remaining = count;
        for (const lot of ledger.get(spec.key)?.lots || []) {
          if (!(remaining > tolerance(count))) break;
          if (!(lot.count > 0)) continue;
          const used = Math.min(remaining, lot.count);
          allocations.push({...lot, count: tidy(used)});
          lot.count = tidy(lot.count - used);
          remaining = tidy(remaining - used);
        }
        return {allocations, remaining: remaining <= tolerance(count) ? 0 : remaining};
      }
      function material(map, spec, count, nodeId, reason, conditional) {
        const key = spec.key + '|' + reason;
        if (!map.has(key)) map.set(key, {...spec, count: 0, reason, nodeIds: [], conditional});
        const record = map.get(key);
        record.count = tidy(record.count + count);
        if (record.count > MAX_AMOUNT || !Number.isFinite(record.count)) {
          record.overflow = true; approximate = true;
          issue('quantity-overflow', {id: nodeId, itemId: spec.itemId}, {}, 'error');
        }
        if (!record.nodeIds.includes(nodeId)) record.nodeIds.push(nodeId);
      }
      function external(node, spec, missing, reason, isBase = false) {
        const conditional = !isBase;
        material(isBase ? base : unresolved, spec, missing, node?.id || null, reason, conditional);
        if (node) {
          node.status = isBase ? 'base' : 'unresolved'; node.reason = reason;
          node.conditional ||= conditional;
          node.allocations.push({count: missing, source: isBase ? 'base' : 'unresolved', sourceNode: node.id, conditional});
        }
        if (!isBase) issue(reason, node, node?.recipeId ? {recipeId: node.recipeId, detailsFile: recipes.get(node.recipeId)?.detailsFile || null} : {}, 'error');
        return node;
      }

      const inventory = Array.isArray(options.inventory) ? options.inventory : Object.entries(options.inventory || {}).map(([itemId, count]) => ({itemId, count}));
      for (const entry of inventory) {
        if (items.has(entry.itemId) && positive(entry.count)) credit(resource(entry), entry.count, {source: 'inventory', sourceNode: null, conditional: false});
        else issue('invalid-quantity', null, {itemId: entry.itemId, context: 'inventory'}, 'error');
      }

      function selectOption(group, selector, demand, isOutput) {
        if (selector !== undefined) {
          if (Number.isInteger(selector)) return group[selector] || null;
          if (typeof selector === 'string') return group.find(choice => choice.itemId === selector) || null;
          if (selector && Number.isInteger(selector.index)) return group[selector.index] || null;
          return null;
        }
        if (isOutput) return group.find(choice => choice.key === demand.key) || group[0] || null;
        let best = null;
        for (const choice of group) {
          if (!best) {best = choice; continue;}
          const a = available(choice) >= choice.count ? 0 : 1, b = available(best) >= best.count ? 0 : 1;
          if (a < b || a === b && (depths.get(choice.itemId) ?? Infinity) < (depths.get(best.itemId) ?? Infinity)) best = choice;
        }
        return best;
      }

      function chooseRecipe(spec, path, ancestry) {
        const chosen = pick(options.recipeChoices, path) ?? pick(options.itemRecipes, spec.itemId);
        if (chosen !== undefined) return {id: chosen, explicit: true};
        const candidates = recipesFor(spec.itemId).filter(candidate => !candidate.reference &&
          getCompiled(candidate.id).outputs.some(group => group.some(choice => choice.key === spec.key)));
        candidates.sort((a, b) => {
          const repeatedA = ancestry.has(a.id + '|' + spec.key) ? 1 : 0;
          const repeatedB = ancestry.has(b.id + '|' + spec.key) ? 1 : 0;
          if (repeatedA !== repeatedB) return repeatedA - repeatedB;
          const unsafe = candidate => candidate.reasons.some(reason => reason !== 'probabilistic-output' || !expectedMode) ? 1 : 0;
          const unsafeA = unsafe(a), unsafeB = unsafe(b);
          if (unsafeA !== unsafeB) return unsafeA - unsafeB;
          const depthA = recipeDepths.get(a.id) ?? Infinity, depthB = recipeDepths.get(b.id) ?? Infinity;
          if (depthA !== depthB) return depthA < depthB ? -1 : 1;
          const inputsA = recipes.get(a.id).inputs?.length || 0, inputsB = recipes.get(b.id).inputs?.length || 0;
          return inputsA - inputsB || compare(a.id, b.id);
        });
        return {id: candidates[0]?.id || null, explicit: false};
      }

      function demand(spec, count, path, parentId, ancestry, depth) {
        if (nodes.length >= maxNodes) {
          material(unresolved, spec, count, parentId, 'max-nodes', true);
          issue('max-nodes', {id: parentId, itemId: spec.itemId}, {}, 'error');
          return null;
        }
        const node = {...spec, id: path, parentId, count, status: 'unresolved', reason: null, recipeId: null,
          batches: 0, yield: 0, children: [], recipeOptions: recipesFor(spec.itemId), inputOptions: [], outputOptions: [],
          allocations: [], conditions: [], conditional: false, truncatedChildren: 0, aliasNodeIds: [], inputIndexes: []};
        nodes.push(node);
        if (!positive(count)) {issue('invalid-quantity', node, {}, 'error'); node.reason = 'invalid-quantity'; return node;}
        if (!items.has(spec.itemId)) return external(node, spec, count, 'missing-item');

        const stock = take(spec, count);
        node.allocations.push(...stock.allocations);
        node.reused = tidy(count - stock.remaining);
        node.conditional = stock.allocations.some(lot => lot.conditional);
        const missing = stock.remaining;
        node.needed = missing;
        if (!missing) {node.status = 'reuse'; return node;}
        if (baseItems.has(spec.itemId) || baseItems.has(spec.key)) return external(node, spec, missing, 'user-base', true);

        const selected = chooseRecipe(spec, path, ancestry);
        if (!selected.id) return external(node, spec, missing, 'no-recipe', true);
        node.recipeId = selected.id;
        const data = getCompiled(selected.id);
        if (!data) return external(node, spec, missing, 'missing-recipe');
        const recipe = data.recipe;
        node.machine = recipe.machine || recipe.type; node.type = recipe.type;
        node.conditions = Array.isArray(recipe.conditions) ? recipe.conditions : [];
        node.detailsFile = recipe.detailsFile || null;
        const inputSelections = [], outputSelections = [];
        for (const [index, group] of data.inputs.entries()) {
          const key = path + '/in:' + index;
          const choice = selectOption(group, pick(options.inputChoices, key), spec, false);
          node.inputOptions.push({key, index, selected: choice?.index ?? null, choices: group});
          inputSelections.push(choice);
        }
        for (const [index, group] of data.outputs.entries()) {
          const key = path + '/out:' + index;
          const choice = selectOption(group, pick(options.outputChoices, key), spec, true);
          node.outputOptions.push({key, index, selected: choice?.index ?? null, choices: group});
          outputSelections.push(choice);
        }
        const reasons = baseReasons(recipe);
        if (reasons.length) return external(node, spec, missing, reasons[0]);
        if (inputSelections.some(choice => !choice)) return external(node, spec, missing, 'invalid-input-choice');
        if (outputSelections.some(choice => !choice)) return external(node, spec, missing, 'invalid-output-choice');
        if ([...inputSelections, ...outputSelections].some(choice => !choice.valid)) return external(node, spec, missing, 'invalid-stack');
        const matching = outputSelections.map((choice, index) => ({choice, index})).filter(entry => entry.choice.key === spec.key);
        if (!matching.length) return external(node, spec, missing, 'recipe-does-not-produce');
        if (matching.some(entry => data.outputs[entry.index].length > 1)) return external(node, spec, missing, 'output-variants');

        function effective(choice, group) {
          if (group.length > 1) return 0;
          const chance = choice.chance == null ? 1 : choice.chance;
          if (typeof chance !== 'number' || !Number.isFinite(chance) || chance < 0 || chance > 1) return 0;
          return chance === 1 ? choice.count : expectedMode ? choice.count * chance : 0;
        }
        const yieldAmount = matching.reduce((sum, entry) => sum + effective(entry.choice, data.outputs[entry.index]), 0);
        node.yield = tidy(yieldAmount);
        node.nominalYield = tidy(matching.reduce((sum, entry) => sum + entry.choice.count, 0));
        if (!Number.isFinite(yieldAmount) || yieldAmount > MAX_AMOUNT) return external(node, spec, missing, 'quantity-overflow');
        if (!positive(yieldAmount)) return external(node, spec, missing, matching.every(entry => entry.choice.chance === 0) ? 'zero-chance' : 'probabilistic-output');
        const token = selected.id + '|' + spec.key;
        if (ancestry.has(token)) {node.cycleTo = ancestry.get(token); return external(node, spec, missing, 'cycle');}
        if (depth >= maxDepth) return external(node, spec, missing, 'max-depth');
        const quotient = missing / yieldAmount;
        const batches = Math.ceil(quotient - tolerance(quotient));
        if (!positive(batches)) return external(node, spec, missing, 'quantity-overflow');
        node.batches = batches;
        const requirements = inputSelections.map((choice, index) => ({...choice, inputIndex: index,
          count: tidy(choice.count * (choice.role === 'catalyst' ? 1 : batches)), perBatch: choice.count}));
        const products = outputSelections.map((choice, index) => {
          const amount = effective(choice, data.outputs[index]);
          return {...choice, outputIndex: index, perBatch: choice.count, count: tidy(choice.count * batches),
            availableCount: tidy(amount * batches), expected: amount > 0 && choice.chance != null && choice.chance < 1};
        });
        if (requirements.some(input => !positive(input.count)) || products.some(output => !positive(output.count) || output.availableCount > MAX_AMOUNT)) {
          return external(node, spec, missing, 'quantity-overflow');
        }
        const grouped = new Map();
        for (const input of requirements) {
          const childPath = path + '/in:' + input.inputIndex;
          const signature = compactInputs ? canonical([input.key, input.role || 'consumed', input.chance ?? null,
            input.index, data.inputSignatures[input.inputIndex], branchSignature(childPath)]) : childPath;
          let group = grouped.get(signature);
          if (!group) {
            group = {...input, count: 0, perBatch: 0, inputIndexes: []};
            grouped.set(signature, group);
          }
          group.count = tidy(group.count + input.count);
          group.perBatch = tidy(group.perBatch + input.perBatch);
          group.inputIndexes.push(input.inputIndex);
        }
        const inputGroups = [...grouped.values()];
        if (inputGroups.some(input => !positive(input.count) || !positive(input.perBatch))) {
          return external(node, spec, missing, 'quantity-overflow');
        }
        const nextAncestry = new Map(ancestry); nextAncestry.set(token, path);
        // Consumables first: a catalyst used by a dependency can be reused by
        // this later operation. Simultaneous catalyst slots are still reserved.
        // Prefer an input whose selected route also supplies a sibling. This
        // reuses straightforward coproducts even if that sibling was listed
        // first in the grid. Paths remain tied to their original input index.
        const siblingKeys = new Set(inputGroups.filter(input => input.role !== 'catalyst').map(input => input.key));
        const coproductScores = new Map();
        if (inputGroups.length > 1) for (const input of inputGroups) {
          if (input.role === 'catalyst') continue;
          const next = chooseRecipe(input, path + '/in:' + input.inputIndex, nextAncestry);
          const producing = getCompiled(next.id);
          if (!producing || baseReasons(producing.recipe).length) continue;
          const supplied = new Set();
          for (const group of producing.outputs) if (group.length === 1 && group[0].key !== input.key &&
            siblingKeys.has(group[0].key) && (group[0].chance == null || group[0].chance === 1)) supplied.add(group[0].key);
          coproductScores.set(input.inputIndex, supplied.size);
        }
        const ordered = [...inputGroups].sort((a, b) => (a.role === 'catalyst' ? 1 : 0) - (b.role === 'catalyst' ? 1 : 0) ||
          (coproductScores.get(b.inputIndex) || 0) - (coproductScores.get(a.inputIndex) || 0) || a.inputIndex - b.inputIndex);
        const childByIndex = new Map(), heldCatalysts = [];
        let conditional = node.conditional;
        for (const input of ordered) {
          const child = demand(input, input.count, path + '/in:' + input.inputIndex, path, nextAncestry, depth + 1);
          if (child) {
            child.role = input.role || 'consumed'; child.inputIndex = input.inputIndex;
            child.inputIndexes = [...input.inputIndexes];
            child.aliasNodeIds = input.inputIndexes.slice(1).map(index => path + '/in:' + index);
            childByIndex.set(input.inputIndex, child); conditional ||= child.conditional || child.status === 'unresolved';
            if (input.role === 'catalyst') heldCatalysts.push({spec: input, allocations: child.allocations});
          } else {node.truncatedChildren++; conditional = true;}
          if (input.chance != null && input.chance < 1) {issue('input-chance', child || node); conditional = true;}
        }
        node.children = [...childByIndex.entries()].sort((a, b) => a[0] - b[0]).map(entry => entry[1]);
        const expected = products.some(product => product.expected);
        if (expected) {approximate = true; issue('expected-output', node, {recipeId: recipe.id});}
        for (const output of products) {
          if (output.availableCount > 0) credit(output, output.availableCount, {source: 'craft', sourceNode: path, conditional, expected: output.expected});
          else issue('uncertain-byproduct', node, {recipeId: recipe.id});
        }
        for (const held of heldCatalysts) for (const allocation of held.allocations) credit(held.spec, allocation.count, allocation);
        const produced = take(spec, missing);
        node.allocations.push(...produced.allocations);
        node.conditional = conditional || produced.allocations.some(lot => lot.conditional);
        node.status = 'craft';
        const step = {id: path, recipeId: recipe.id, itemId: spec.itemId, batches, machine: node.machine, type: recipe.type,
          inputs: requirements, outputs: products, conditions: node.conditions, detailsFile: node.detailsFile, conditional: node.conditional, expected};
        for (const field of ['duration', 'time', 'energy', 'energyCost', 'temperature']) if (has(recipe, field)) step[field] = recipe[field];
        steps.push(step);
        if (produced.remaining > 0) return external(node, spec, produced.remaining, 'quantity-overflow');
        return node;
      }

      const root = demand(target, target.count, 'root', null, new Map(), 0);
      const leftovers = [];
      for (const entry of ledger.values()) {
        const count = tidy(entry.lots.reduce((sum, lot) => sum + lot.count, 0));
        if (count > tolerance(count)) {
          const overflow = count > MAX_AMOUNT || !Number.isFinite(count);
          if (overflow) {approximate = true; issue('quantity-overflow', null, {itemId: entry.spec.itemId, context: 'leftovers'}, 'error');}
          leftovers.push({...entry.spec, count, overflow, conditional: entry.lots.some(lot => lot.count > 0 && lot.conditional),
            expected: entry.lots.some(lot => lot.count > 0 && lot.expected)});
        }
      }
      const sortMaterials = array => array.sort((a, b) => compare(a.itemId, b.itemId) || compare(a.key, b.key) || compare(a.reason || '', b.reason || ''));
      return {target, root, nodes, steps, baseMaterials: sortMaterials([...base.values()]), unresolvedMaterials: sortMaterials([...unresolved.values()]),
        leftovers: sortMaterials(leftovers), issues, complete: !issues.some(entry => entry.severity === 'error'), approximate,
        limits: {maxDepth, maxNodes}, compactInputs, calculation: 'catalog-quantities'};
    }

    return {plan, recipesFor, resourceKey: spec => resource(spec).key,
      stats: {items: items.size, recipes: recipes.size, producingItems: producers.size}};
  }

  return {createPlanner, pathsForNode, version: 1};
});
