'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UniLandRuntime = api;
})(globalThis, function () {
  const FORMAT = 'uniland-runtime-v1';
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const fail = message => { throw new Error(`Некорректный runtime-каталог: ${message}`); };
  const reference = (value, table, name) => {
    if (!Number.isSafeInteger(value) || value < 0 || value >= table.length) fail(`${name}: индекс вне таблицы`);
    return table[value];
  };
  // Clone before freezing so decoding cannot modify objects supplied by a caller.
  const immutable = value => {
    if (Array.isArray(value)) return Object.freeze(value.map(immutable));
    if (object(value)) return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutable(entry)])));
    return value;
  };

  function decode(raw) {
    // Local development and older releases still use the complete v1 JSON.
    if (!object(raw) || !own(raw, 'runtimeFormat')) return raw;
    if (raw.runtimeFormat !== FORMAT || raw.schemaVersion !== 1) fail('неподдерживаемый формат');
    if (!Array.isArray(raw.items) || !Array.isArray(raw.recipes)) fail('нет массивов items/recipes');
    if (raw.items.length > 100000 || raw.recipes.length > 250000) fail('превышен размер каталога');
    if (!object(raw.sharedStacks) || !Array.isArray(raw.sharedStacks.alternatives) || !Array.isArray(raw.sharedStacks.variants)) fail('нет общих таблиц');
    const ids = raw.items.map(item => {
      if (!object(item) || typeof item.id !== 'string' || !item.id || item.id.length > 1024) fail('некорректный ID предмета');
      return item.id;
    });
    const itemId = value => reference(value, ids, 'itemId');
    const alternatives = raw.sharedStacks.alternatives.map(list => {
      if (!Array.isArray(list) || list.length > 2048) fail('некорректные альтернативы');
      return Object.freeze(list.map(itemId));
    });
    const variants = raw.sharedStacks.variants.map(list => {
      if (!Array.isArray(list)) fail('некорректные варианты');
      return Object.freeze(list.map(variant => {
        if (!object(variant)) fail('вариант должен быть объектом');
        return immutable({...variant, itemId: itemId(variant.itemId)});
      }));
    });
    function stack(value) {
      if (!object(value)) fail('ингредиент должен быть объектом');
      const result = {...value, itemId: itemId(value.itemId)};
      if (own(value, 'alternatives')) result.alternatives = reference(value.alternatives, alternatives, 'alternatives');
      if (own(value, 'variants')) result.variants = reference(value.variants, variants, 'variants');
      return result;
    }
    const recipes = raw.recipes.map(recipe => {
      if (!object(recipe) || !Array.isArray(recipe.inputs) || !Array.isArray(recipe.outputs)) fail('некорректный рецепт');
      return {...recipe, inputs: recipe.inputs.map(stack), outputs: recipe.outputs.map(stack)};
    });
    const {runtimeFormat, sharedStacks, ...catalog} = raw;
    return {...catalog, recipes};
  }
  return Object.freeze({FORMAT, decode});
});
