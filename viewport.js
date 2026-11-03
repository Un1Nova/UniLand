'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UniLandViewport = api;
})(typeof window === 'undefined' ? globalThis : window, function () {
  const instances = new WeakMap();
  const finite = (value, fallback) => Number.isFinite(value) ? value : fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const copy = (value) => ({ x: value.x, y: value.y, scale: value.scale });

  function clampTransform(value, size, bounds, options) {
    const scale = clamp(finite(value.scale, 1), options.minScale, options.maxScale);
    const axis = (position, viewport, content) => {
      if (!viewport) return finite(position, 0);
      const padding = Math.min(options.padding, viewport / 4);
      if (content <= viewport - padding * 2) return (viewport - content) / 2;
      return clamp(finite(position, 0), viewport - content - padding, padding);
    };
    return {
      x: axis(value.x, size.width, bounds.width * scale),
      y: axis(value.y, size.height, bounds.height * scale),
      scale
    };
  }

  function zoomAt(value, scale, anchor) {
    const ratio = scale / value.scale;
    return { x: anchor.x - (anchor.x - value.x) * ratio, y: anchor.y - (anchor.y - value.y) * ratio, scale };
  }

  function create(config) {
    const viewport = config.viewport, world = config.world;
    if (!viewport || !world) throw new TypeError('Viewport and world elements are required.');
    instances.get(viewport)?.destroy();
    const win = viewport.ownerDocument?.defaultView || globalThis;
    const options = {
      minScale: Math.max(.001, finite(config.minScale, .08)),
      maxScale: Math.max(.001, finite(config.maxScale, 5)),
      fitMaxScale: Math.max(.001, finite(config.fitMaxScale, 1.2)),
      padding: Math.max(0, finite(config.padding, 24)),
      threshold: Math.max(1, finite(config.dragThreshold, 6)),
      fitOnResize: config.fitOnResize === true
    };
    options.maxScale = Math.max(options.minScale, options.maxScale);
    const raf = win.requestAnimationFrame.bind(win), cancelRaf = win.cancelAnimationFrame.bind(win);
    const now = () => win.performance?.now() ?? Date.now();
    let bounds = { width: Math.max(1, finite(config.width, 1)), height: Math.max(1, finite(config.height, 1)) };
    let size = { width: viewport.clientWidth || 0, height: viewport.clientHeight || 0 };
    let state = config.initialTransform ? copy(config.initialTransform) : { x: 0, y: 0, scale: 1 };
    let frame = 0, destroyed = false, gesture = null, moved = false, blockedUntil = 0, rect = null;
    const pointers = new Map(), captures = new Map();
    const activeOptions = { capture: true, passive: false };
    viewport.classList.add('uniland-viewport');
    world.classList.add('uniland-viewport-world');

    const ignore = (target) => !!target?.closest?.('[data-viewport-ignore],input,select,textarea,[contenteditable="true"]');
    const center = () => ({ x: size.width / 2, y: size.height / 2 });
    const local = (pointer) => ({ x: pointer.x - rect.left - (viewport.clientLeft || 0), y: pointer.y - rect.top - (viewport.clientTop || 0) });
    const setMoving = (value) => viewport.classList.toggle('is-panning', value);
    function schedule() {
      if (frame || destroyed) return;
      frame = raf(() => {
        frame = 0;
        if (destroyed) return;
        world.style.transform = `translate(${state.x}px,${state.y}px) scale(${state.scale})`;
        if (typeof config.onChange === 'function') config.onChange(copy(state), { ...size });
      });
    }
    function update(value) { state = clampTransform(value, size, bounds, options); schedule(); }
    function dimensions() { world.style.width = `${bounds.width}px`; world.style.height = `${bounds.height}px`; }
    function fit() {
      if (!size.width || !size.height) return;
      const padding = Math.min(options.padding, size.width / 4, size.height / 4);
      const scale = clamp(Math.min((size.width - padding * 2) / bounds.width, (size.height - padding * 2) / bounds.height, options.fitMaxScale), options.minScale, options.maxScale);
      update({ x: (size.width - bounds.width * scale) / 2, y: (size.height - bounds.height * scale) / 2, scale });
      rebase();
    }
    function zoomBy(factor, anchor = center()) {
      if (!(factor > 0) || !Number.isFinite(factor)) return;
      const scale = clamp(state.scale * factor, options.minScale, options.maxScale);
      update(zoomAt(state, scale, anchor));
      rebase();
    }
    function panBy(dx, dy) { update({ x: state.x + finite(dx, 0), y: state.y + finite(dy, 0), scale: state.scale }); rebase(); }
    function rebase() {
      const active = [...pointers.values()];
      if (!active.length) { gesture = null; return; }
      rect = viewport.getBoundingClientRect();
      if (active.length === 1) gesture = { type: 'pan', origin: local(active[0]), state: copy(state) };
      else {
        const a = local(active[0]), b = local(active[1]);
        gesture = { type: 'pinch', origin: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), state: copy(state) };
      }
    }
    function resize() {
      if (destroyed) return;
      const next = { width: viewport.clientWidth || 0, height: viewport.clientHeight || 0 };
      if (!next.width || !next.height || (next.width === size.width && next.height === size.height)) return;
      const previous = size; size = next;
      if (options.fitOnResize || ((!previous.width || !previous.height) && !config.initialTransform)) fit();
      else if (!previous.width || !previous.height) { update(state); rebase(); }
      else { update({ x: state.x + (size.width - previous.width) / 2, y: state.y + (size.height - previous.height) / 2, scale: state.scale }); rebase(); }
    }
    function capture(event) {
      const target = typeof event.target?.setPointerCapture === 'function' ? event.target : viewport;
      try { target.setPointerCapture(event.pointerId); captures.set(event.pointerId, target); } catch { /* Window listeners also cover capture-unavailable devices. */ }
    }
    function release(id) {
      const target = captures.get(id); captures.delete(id);
      try { if (target?.hasPointerCapture(id)) target.releasePointerCapture(id); } catch { /* The target can disappear during a view change. */ }
    }
    function listenActive(add) {
      const method = add ? 'addEventListener' : 'removeEventListener';
      win[method]('pointermove', onMove, activeOptions);
      win[method]('pointerup', onUp, activeOptions);
      win[method]('pointercancel', onCancel, activeOptions);
      win[method]('lostpointercapture', onLostCapture, true);
      win[method]('blur', cancelGesture);
    }
    function onDown(event) {
      if (destroyed || event.button !== 0 || ignore(event.target)) return;
      if (!pointers.size) { moved = false; blockedUntil = 0; listenActive(true); }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      capture(event);
      if (pointers.size > 1) { moved = true; setMoving(true); if (event.cancelable) event.preventDefault(); }
      rebase();
    }
    function move(event) {
      if (!pointers.has(event.pointerId) || !gesture) return;
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const active = [...pointers.values()];
      if (gesture.type === 'pinch' && active.length > 1) {
        const a = local(active[0]), b = local(active[1]), midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        const scale = clamp(gesture.state.scale * Math.hypot(b.x - a.x, b.y - a.y) / gesture.distance, options.minScale, options.maxScale);
        const zoomed = zoomAt(gesture.state, scale, gesture.origin);
        update({ x: zoomed.x + midpoint.x - gesture.origin.x, y: zoomed.y + midpoint.y - gesture.origin.y, scale });
        moved = true;
      } else {
        const point = local(active[0]), dx = point.x - gesture.origin.x, dy = point.y - gesture.origin.y;
        if (!moved && Math.hypot(dx, dy) < options.threshold) return;
        moved = true; update({ x: gesture.state.x + dx, y: gesture.state.y + dy, scale: gesture.state.scale });
      }
      setMoving(true);
      if (event.cancelable) event.preventDefault();
    }
    function onMove(event) { move(event); }
    function finish(event, cancelled) {
      if (!pointers.has(event.pointerId)) return;
      if (!cancelled) move(event); else moved = true;
      pointers.delete(event.pointerId);
      if (moved) blockedUntil = now() + 750;
      release(event.pointerId);
      if (!pointers.size) { gesture = null; setMoving(false); listenActive(false); }
      else rebase();
    }
    function onUp(event) { finish(event, false); }
    function onCancel(event) { finish(event, true); }
    function onLostCapture(event) { if (pointers.has(event.pointerId)) finish(event, true); }
    function cancelGesture() {
      if (pointers.size) blockedUntil = now() + 750;
      const ids = [...pointers.keys()]; pointers.clear(); gesture = null;
      ids.forEach(release); setMoving(false); listenActive(false);
    }
    function onClick(event) {
      if (ignore(event.target)) return;
      const keyboard = event.detail === 0 && !event.pointerType;
      if (keyboard || (!(pointers.size && moved) && now() >= blockedUntil)) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }
    function onNativeDrag(event) { event.preventDefault(); }
    function onWheel(event) {
      if (ignore(event.target)) return;
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
      if (!delta) return;
      if (event.cancelable) event.preventDefault();
      rect = viewport.getBoundingClientRect();
      zoomBy(Math.exp(-clamp(delta, -240, 240) * .002), local({ x: event.clientX, y: event.clientY }));
    }
    function onKey(event) {
      if (ignore(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const step = event.shiftKey ? 96 : 48;
      if (event.key === '+' || event.key === '=') zoomBy(1.25);
      else if (event.key === '-' || event.key === '_') zoomBy(1 / 1.25);
      else if (event.key === 'Home' || event.key === '0') fit();
      else if (event.key === 'ArrowLeft') panBy(step, 0);
      else if (event.key === 'ArrowRight') panBy(-step, 0);
      else if (event.key === 'ArrowUp') panBy(0, step);
      else if (event.key === 'ArrowDown') panBy(0, -step);
      else return;
      event.preventDefault(); event.stopPropagation();
    }

    viewport.addEventListener('pointerdown', onDown);
    viewport.addEventListener('click', onClick, true);
    viewport.addEventListener('dragstart', onNativeDrag, true);
    viewport.addEventListener('selectstart', onNativeDrag);
    viewport.addEventListener('wheel', onWheel, { passive: false });
    viewport.addEventListener('keydown', onKey);
    let observer;
    if (typeof win.ResizeObserver === 'function') { observer = new win.ResizeObserver(resize); observer.observe(viewport); }
    else win.addEventListener('resize', resize);
    dimensions();
    if (config.initialTransform) update(state); else fit();

    const api = {
      fit, zoomBy, panBy,
      getTransform: () => copy(state),
      getViewportSize: () => ({ ...size }),
      setTransform(value) { update(value); rebase(); },
      setBounds(value, settings = {}) {
        bounds = { width: Math.max(1, finite(value.width, bounds.width)), height: Math.max(1, finite(value.height, bounds.height)) };
        dimensions(); if (settings.fit) fit(); else { update(state); rebase(); }
      },
      destroy() {
        if (destroyed) return;
        destroyed = true; cancelGesture(); if (frame) cancelRaf(frame);
        observer?.disconnect(); win.removeEventListener('resize', resize);
        viewport.removeEventListener('pointerdown', onDown);
        viewport.removeEventListener('click', onClick, true);
        viewport.removeEventListener('dragstart', onNativeDrag, true);
        viewport.removeEventListener('selectstart', onNativeDrag);
        viewport.removeEventListener('wheel', onWheel, { passive: false });
        viewport.removeEventListener('keydown', onKey);
        viewport.classList.remove('uniland-viewport', 'is-panning'); world.classList.remove('uniland-viewport-world');
        if (instances.get(viewport) === api) instances.delete(viewport);
      }
    };
    instances.set(viewport, api);
    return api;
  }

  return { create, math: { clampTransform, zoomAt } };
});
