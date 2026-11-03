'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

// Exercise the real app functions with a small DOM adapter; visual geometry stays in browser QA.
function environment() {
  const elements = new Map(), timers = new Map(), windowEvents = new Map();
  let timerId = 0, historyCalls = 0;
  class Element {
    constructor(id) {
      this.id = id; this.innerHTML = ''; this.value = ''; this.hidden = false; this.dataset = {}; this.style = {};
      this.clientWidth = 600; this.clientHeight = 400; this.attributes = new Map(); this.handlers = new Map();
      this.computed = { gridTemplateColumns: '90px 90px 90px 90px 90px 90px', gridAutoRows: '112px', rowGap: '8px', paddingTop: '0px', paddingBottom: '0px' };
      const classes = new Set();
      this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle: (name, value) => value ? classes.add(name) : classes.delete(name) };
    }
    setAttribute(name, value) { this.attributes.set(name, value); }
    removeAttribute(name) { this.attributes.delete(name); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(name, handler) { this.handlers.set(name, handler); }
    click() { this.handlers.get('click')?.({ target: this }); }
    contains(other) { return other === this; }
    closest() { return null; }
    querySelector(selector) { return selector === '.guide-grid' ? element('guide-grid') : null; }
    querySelectorAll() { return []; }
    getBoundingClientRect() { return { width: this.clientWidth, height: this.clientHeight }; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = document.body; }
  }
  function element(id) { if (!elements.has(id)) elements.set(id, new Element(id)); return elements.get(id); }
  const document = {
    getElementById: element, querySelectorAll: () => [], addEventListener() {},
    querySelector: selector => selector.startsWith('meta[') ? null : element(selector),
    body: element('body'), activeElement: element('body')
  };
  const context = {
    console, document, URL, Event, innerWidth: 1200, getComputedStyle: node => node.computed,
    localStorage: { getItem: () => null, setItem() {} }, location: { href: 'https://example.com/atlas/' },
    history: { replaceState() { historyCalls++; } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    requestAnimationFrame(fn) { timers.set(++timerId, fn); return timerId; }, cancelAnimationFrame: id => timers.delete(id),
    window: { addEventListener: (name, fn) => windowEvents.set(name, fn), matchMedia: () => ({ matches: false }) }
  };
  const source = fs.readFileSync('app.js', 'utf8');
  const marker = '\n  init();\n})();';
  assert(source.includes(marker), 'App bootstrap marker changed; update test instrumentation.');
  const instrumented = source.replace(marker, '\n  window.__test={applyCatalog,results,capacity,favorite};\n})();');
  vm.createContext(context); vm.runInContext(instrumented, context);
  async function settle(promise) {
    let done = false, failure;
    promise.then(() => { done = true; }, error => { done = true; failure = error; });
    for (let pass = 0; pass < 100 && !done; pass++) {
      for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
      await Promise.resolve(); await Promise.resolve();
    }
    if (failure) throw failure;
    assert(done, 'Async indexing did not settle.');
  }
  return { app: context.window.UniLand, internal: context.window.__test, context, element, settle, windowEvents, get historyCalls() { return historyCalls; } };
}
function catalog(count = 3) {
  return { schemaVersion: 1, meta: {}, mods: [], items: Array.from({ length: count }, (_, i) => ({ id: `test:${i}`, name: `Item ${i}`, modId: 'test' })), recipes: [] };
}

test('search during yielded indexing is safe and only exposes a ready index', async () => {
  const env = environment(), pending = env.internal.applyCatalog(catalog(1201));
  env.app.state.query = 'item';
  assert.equal(env.app.ready, false); assert.equal(env.internal.results().length, 0);
  assert.doesNotThrow(() => env.app.renderCatalog());
  await env.settle(pending);
  assert.equal(env.app.ready, true); assert.equal(env.internal.results().length, 1201);
});
test('results are reused across rendering and invalidated by a favorites change', async () => {
  const env = environment(); await env.settle(env.internal.applyCatalog(catalog()));
  const first = env.internal.results(); assert.equal(env.internal.results(), first);
  env.app.state.favoritesOnly = true; assert.equal(env.internal.results().length, 0);
  env.internal.favorite('test:1'); assert.equal(env.internal.results().length, 1);
  assert.equal(env.internal.results()[0].id, 'test:1');
  env.internal.favorite('test:1'); assert.equal(env.internal.results().length, 0);
});
test('same-view navigation preserves current filters and returning restores the view state', async () => {
  const env = environment(); await env.settle(env.internal.applyCatalog(catalog()));
  env.app.state.query = 'old'; env.app.setView('quests'); env.app.setView('catalog');
  assert.equal(env.app.state.query, 'old');
  env.app.state.query = 'new'; env.app.setView('catalog'); assert.equal(env.app.state.query, 'new');
  env.app.setView('guides'); env.app.setView('catalog'); assert.equal(env.app.state.query, 'new');
});
test('favorites entered from another view stay selected even when the saved catalog was favorites', async () => {
  const env = environment(); await env.settle(env.internal.applyCatalog(catalog()));
  env.app.state.favoritesOnly = true; env.app.setView('quests'); env.element('favorite-items').click();
  assert.equal(env.app.state.view, 'catalog'); assert.equal(env.app.state.favoritesOnly, true);
});
test('guide capacity excludes inner padding and counts only complete visible rows', () => {
  const env = environment(), grid = env.element('guide-grid');
  grid.clientHeight = 260;
  grid.computed = { gridTemplateColumns: '240px 240px', gridAutoRows: '120px', rowGap: '10px', paddingTop: '16px', paddingBottom: '16px' };
  assert.equal(env.internal.capacity(true), 2);
});
test('output and input variants are indexed once per recipe', async () => {
  const env = environment(), data = catalog();
  data.recipes = [{ id: 'recipe', type: 'machine', inputs: [{ itemId: 'test:0', alternatives: ['test:1'], variants: [{ itemId: 'test:1', count: 1 }] }], outputs: [{ itemId: 'test:1', alternatives: ['test:2'], variants: [{ itemId: 'test:1', count: 1 }, { itemId: 'test:2', count: 1 }] }] }];
  await env.settle(env.internal.applyCatalog(data));
  assert.equal(env.app.recipesFor('test:1').length, 1); assert.equal(env.app.recipesFor('test:2').length, 1); assert.equal(env.app.usesFor('test:1').length, 1);
});
test('revealQuest selects the chapter and reveals its node without opening detail or changing the route', async () => {
  const env = environment(); await env.settle(env.internal.applyCatalog(catalog()));
  const quests = [1, 2, 3].map(id => ({ questID: id, properties: { betterquesting: { name: `Quest ${id}` } }, tasks: [] }));
  const lines = [{ lineID: 0, order: 0, properties: { betterquesting: { name: 'One' } }, quests: [{ id: 1, x: 0, y: 0, sizeX: 16, sizeY: 16 }] }, { lineID: 1, order: 1, properties: { betterquesting: { name: 'Two' } }, quests: [{ id: 2, x: 0, y: 0, sizeX: 16, sizeY: 16 }, { id: 3, x: 0, y: 200, sizeX: 16, sizeY: 16 }] }];
  const data = { 'data/quests.json': quests, 'data/quest-lines.json': lines, 'data/knowledge.json': { pages: [] } };
  let centered = 0;
  env.context.fetch = async url => ({ ok: true, json: async () => data[url] });
  env.context.window.UniLandViewport = { create: options => ({ getTransform: () => options.initialTransform || { x: 0, y: 0, scale: 1 }, getViewportSize: () => ({ width: 600, height: 400 }), setTransform() { centered++; }, destroy() {} }) };
  vm.runInContext(fs.readFileSync('knowledge.js', 'utf8'), env.context);
  env.app.state.view = 'quests'; env.app.state.mod = '0'; const knowledge = env.context.window.UniLandKnowledge;
  await knowledge.ensure();
  const historyBefore = env.historyCalls;
  assert.equal(knowledge.revealQuest('3'), true); assert.equal(env.app.state.mod, '1'); assert.equal(centered, 1);
  assert.equal(env.app.state.entity, null); assert.equal(env.historyCalls, historyBefore);
  assert.equal(knowledge.revealQuest('missing'), false);
});
test('guide cards show readable synopses without source directives or heading attributes', async () => {
  const env = environment(); await env.settle(env.internal.applyCatalog(catalog()));
  const markdown = [
    ':::callout{type="tip"}\n- Для **быстрой привязки** используйте жезл.\n:::',
    '{% if not mod:loli_elements_tmsky %}\nЭльфы давно покинули мир людей.\\\nИх следы остались.\n{% endif %}',
    'С [Гайи 2-го уровня](guide:gaia#tier-2) выпадают реликвии.\\\nОни привязываются к игроку.',
    '# Терра-плита {#terra-plate icon-item="Botania:terraPlate"}\nСоздаёт террасталь.'
  ];
  const pages = markdown.map((text, index) => ({ kind: 'guide', metadata: { id: `guide:${index}`, title: `Гайд ${index}` }, markdown: text }));
  const original = JSON.stringify(pages);
  const data = { 'data/quests.json': [], 'data/quest-lines.json': [], 'data/knowledge.json': { pages } };
  env.context.fetch = async url => ({ ok: true, json: async () => data[url] });
  vm.runInContext(fs.readFileSync('knowledge.js', 'utf8'), env.context);
  env.app.state.view = 'guides'; await env.context.window.UniLandKnowledge.ensure();
  const html = env.element('knowledge-view').innerHTML;
  for (const expected of ['Для быстрой привязки используйте жезл.', 'Эльфы давно покинули мир людей. Их следы остались.', 'С Гайи 2-го уровня выпадают реликвии. Они привязываются к игроку.', 'Терра-плита Создаёт террасталь.']) assert(html.includes(expected), expected);
  assert.doesNotMatch(html, /:::|callout|\{%|loli_elements|terra-plate|icon-item|Знания о мире|\\/);
  assert.equal(JSON.stringify(pages), original, 'Synopsis cleanup must not mutate guide source content.');
});
