'use strict';
const assert = require('node:assert/strict');
const { create } = require('./viewport.js');

class Target {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  fire(type, fields = {}) {
    const event = {
      type, target: this, cancelable: true, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; },
      stopPropagation() { this.stopped = true; },
      stopImmediatePropagation() { this.stopped = true; },
      ...fields
    };
    for (const listener of this.listeners.get(type) || []) { listener(event); if (event.stopped) break; }
    return event;
  }
  listenerCount() { return [...this.listeners.values()].reduce((total, set) => total + set.size, 0); }
}
class Element extends Target {
  constructor() {
    super(); this.clientWidth = 400; this.clientHeight = 300; this.style = {}; this.captures = new Set(); this.ignored = false;
    const classes = new Set();
    this.classList = { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name), toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name) };
  }
  closest() { return this.ignored ? this : null; }
  getBoundingClientRect() { return { left: 20, top: 30, width: this.clientWidth, height: this.clientHeight }; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); }
}
function setup(config = {}) {
  const win = new Target(), frames = new Map(), viewport = new Element(), world = new Element(), node = new Element();
  let id = 0, observer, frameWrites = 0;
  win.performance = { now: () => 100 };
  win.requestAnimationFrame = fn => { frames.set(++id, fn); return id; };
  win.cancelAnimationFrame = token => frames.delete(token);
  win.ResizeObserver = class { constructor(fn) { this.callback = fn; this.disconnected = false; observer = this; } observe() {} disconnect() { this.disconnected = true; } };
  viewport.ownerDocument = { defaultView: win };
  const api = create({ viewport, world, width: 1200, height: 1000, initialTransform: { x: -300, y: -200, scale: 1 }, onChange() { frameWrites++; }, ...config });
  const pointer = (type, pid, x, y, extra = {}) => (type === 'pointerdown' ? viewport : win).fire(type, { target: node, pointerId: pid, pointerType: 'touch', button: 0, clientX: x + 20, clientY: y + 30, ...extra });
  const click = (extra = {}) => viewport.fire('click', { target: node, detail: 1, pointerType: 'touch', ...extra });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  flush();
  return { api, win, viewport, world, node, frames, pointer, click, flush, resize(width, height) { viewport.clientWidth = width; viewport.clientHeight = height; observer.callback(); }, get writes() { return frameWrites; }, get observer() { return observer; } };
}
const near = (a, b, label = '') => assert(Math.abs(a - b) < 1e-8, `${label}: ${a} != ${b}`);
const worldAt = (state, x, y) => ({ x: (x - state.x) / state.scale, y: (y - state.y) / state.scale });
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }

test('tap and movement below threshold preserve native click and the node capture target', () => {
  const t = setup();
  t.pointer('pointerdown', 1, 100, 100);
  assert(t.node.hasPointerCapture(1)); assert(!t.viewport.hasPointerCapture(1));
  t.pointer('pointermove', 1, 103, 101); t.pointer('pointerup', 1, 103, 101);
  assert.deepEqual(t.api.getTransform(), { x: -300, y: -200, scale: 1 });
  assert(!t.click().prevented); assert(!t.node.hasPointerCapture(1)); t.api.destroy();
});
test('mouse drag pans and blocks its click before delegated node activation', () => {
  const t = setup();
  t.pointer('pointerdown', 1, 100, 100, { pointerType: 'mouse' });
  t.pointer('pointermove', 1, 145, 120, { pointerType: 'mouse' });
  assert.deepEqual(t.api.getTransform(), { x: -255, y: -180, scale: 1 });
  t.pointer('pointerup', 1, 145, 120, { pointerType: 'mouse' });
  const click = t.click({ pointerType: 'mouse' }); assert(click.prevented && click.stopped);
  assert(!t.click({ detail: 0, pointerType: '' }).prevented, 'keyboard activation must remain available');
  t.pointer('pointerdown', 1, 150, 120); t.pointer('pointerup', 1, 150, 120);
  assert(!t.click().prevented, 'the next deliberate tap must not be swallowed'); t.api.destroy();
});
test('pinch keeps the initial midpoint world coordinate under the moving midpoint', () => {
  const t = setup(); const anchor = worldAt(t.api.getTransform(), 150, 100);
  t.pointer('pointerdown', 1, 100, 100); t.pointer('pointerdown', 2, 200, 100);
  t.pointer('pointermove', 1, 50, 120); t.pointer('pointermove', 2, 250, 120);
  const next = t.api.getTransform(), projected = worldAt(next, 150, 120);
  near(next.scale, 2); near(projected.x, anchor.x); near(projected.y, anchor.y);
  t.pointer('pointerup', 2, 250, 120); assert(t.click().prevented); t.api.destroy();
});
test('lifting one pinch finger rebases pan without a jump', () => {
  const t = setup();
  t.pointer('pointerdown', 1, 100, 100); t.pointer('pointerdown', 2, 200, 100);
  t.pointer('pointermove', 1, 50, 100); t.pointer('pointermove', 2, 250, 100);
  t.pointer('pointerup', 2, 250, 100); const before = t.api.getTransform();
  t.pointer('pointermove', 1, 70, 110); const after = t.api.getTransform();
  near(after.x, before.x + 20); near(after.y, before.y + 10); near(after.scale, before.scale);
  t.pointer('pointerup', 1, 70, 110); assert(t.click().prevented); t.api.destroy();
});
test('pointer cancel and lost capture end gestures, release captures, and allow the next tap', () => {
  for (const end of ['pointercancel', 'lostpointercapture']) {
    const t = setup(); t.pointer('pointerdown', 1, 100, 100); t.pointer('pointermove', 1, 120, 100);
    t.pointer(end, 1, 120, 100); const before = t.api.getTransform();
    t.pointer('pointermove', 1, 200, 100);
    assert.deepEqual(t.api.getTransform(), before); assert(!t.node.hasPointerCapture(1)); assert(!t.viewport.classList.contains('is-panning'));
    t.pointer('pointerdown', 2, 200, 100); t.pointer('pointerup', 2, 200, 100); assert(!t.click().prevented); t.api.destroy();
  }
});
test('many pointer moves schedule one transform write per frame', () => {
  const t = setup(); const initialWrites = t.writes, initialStyle = t.world.style.transform;
  t.pointer('pointerdown', 1, 100, 100);
  for (let x = 110; x <= 170; x++) t.pointer('pointermove', 1, x, 100);
  assert.equal(t.frames.size, 1); assert.equal(t.writes, initialWrites); assert.equal(t.world.style.transform, initialStyle);
  t.flush(); assert.equal(t.writes, initialWrites + 1); assert.notEqual(t.world.style.transform, initialStyle); t.api.destroy();
});
test('wheel zoom is anchored to its cursor and only consumes canvas wheel events', () => {
  const t = setup(); const anchor = worldAt(t.api.getTransform(), 120, 90);
  const wheel = t.viewport.fire('wheel', { target: t.node, deltaY: -100, deltaMode: 0, clientX: 140, clientY: 120 });
  assert(wheel.prevented); const next = worldAt(t.api.getTransform(), 120, 90); near(next.x, anchor.x); near(next.y, anchor.y);
  assert.equal(t.win.listeners.get('wheel')?.size || 0, 0); t.api.destroy();
});
test('scale limits and translation limits keep content reachable', () => {
  const t = setup(); t.api.zoomBy(1000); near(t.api.getTransform().scale, 5);
  t.api.panBy(1e9, -1e9); const large = t.api.getTransform(); assert(large.x <= 24); assert(large.y >= 300 - 1000 * large.scale - 24);
  t.api.zoomBy(.000001); const small = t.api.getTransform(); near(small.scale, .08); near(small.x, (400 - 1200 * .08) / 2); near(small.y, (300 - 1000 * .08) / 2); t.api.destroy();
});
test('resize preserves world center and scale; a hidden canvas does not erase position', () => {
  const t = setup(); const before = worldAt(t.api.getTransform(), 200, 150);
  t.resize(800, 300); const after = worldAt(t.api.getTransform(), 400, 150);
  near(before.x, after.x); near(before.y, after.y); near(t.api.getTransform().scale, 1);
  const saved = t.api.getTransform(); t.resize(0, 0); assert.deepEqual(t.api.getTransform(), saved);
  t.resize(800, 300); assert.deepEqual(t.api.getTransform(), saved); t.api.destroy();
});
test('fit and changed world bounds produce a centered overview', () => {
  const t = setup(); t.api.setBounds({ width: 800, height: 400 }, { fit: true });
  const state = t.api.getTransform(); near(state.scale, .44); near(state.x, 24); near(state.y, 62);
  assert.equal(t.world.style.width, '800px'); assert.equal(t.world.style.height, '400px'); t.api.destroy();
});
test('keyboard controls stay local and do not intercept text editing or node activation', () => {
  const t = setup();
  const plus = t.viewport.fire('keydown', { target: t.node, key: '+' }); assert(plus.prevented); near(t.api.getTransform().scale, 1.25);
  assert(!t.viewport.fire('keydown', { target: t.node, key: 'Enter' }).prevented);
  assert(!t.viewport.fire('keydown', { target: t.node, key: '+', ctrlKey: true }).prevented);
  t.node.ignored = true; const state = t.api.getTransform(); assert(!t.viewport.fire('keydown', { target: t.node, key: '+' }).prevented); assert.deepEqual(t.api.getTransform(), state);
  assert.equal(t.win.listeners.get('keydown')?.size || 0, 0); t.api.destroy();
});
test('native selection and image dragging are prevented inside the canvas', () => {
  const t = setup(); assert(t.viewport.fire('dragstart', { target: t.node }).prevented); assert(t.viewport.fire('selectstart', { target: t.node }).prevented); t.api.destroy();
});
test('canvas overlay controls remain clickable immediately after a drag', () => {
  const t = setup(); t.pointer('pointerdown', 1, 100, 100); t.pointer('pointermove', 1, 150, 100); t.pointer('pointerup', 1, 150, 100);
  const control = new Element(); control.ignored = true;
  assert(!t.viewport.fire('click', { target: control, detail: 1, pointerType: 'mouse' }).prevented);
  assert(t.click().prevented, 'the dragged node click must still be suppressed'); t.api.destroy();
});
test('destroy removes active gesture listeners, captures, pending frames and observer', () => {
  const t = setup(); t.pointer('pointerdown', 1, 100, 100); t.pointer('pointermove', 1, 150, 100);
  t.api.destroy(); assert.equal(t.viewport.listenerCount(), 0); assert.equal(t.win.listenerCount(), 0); assert.equal(t.frames.size, 0); assert.equal(t.node.captures.size, 0); assert(t.observer.disconnected);
  t.api.destroy();
});
console.log(`${passed} viewport gesture tests passed.`);
