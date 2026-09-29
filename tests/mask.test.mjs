import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// The ramp is sized from the mark and bounded to a narrow range: two pixels for a
// dot, ten for a broad sweep, never more. What is pinned here is that range, the
// follow-the-mark part of it, and the one guard that survives from the earlier
// sizing — a mark only a few pixels across takes a smaller ramp than the floor
// instead of being blurred out of existence.
function surface2d() {
  const noop = () => {};
  return new Proxy({}, { get: (target, key) => (key in target ? target[key] : noop), set: (target, key, value) => { target[key] = value; return true; } });
}
function element() {
  return {
    style: {},
    width: 0,
    height: 0,
    getContext: () => surface2d(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 768, height: 768, right: 768, bottom: 768 }),
    addEventListener: () => {},
    setPointerCapture: () => {}
  };
}
class Image {
  constructor() { this.complete = false; this.naturalWidth = 0; this.naturalHeight = 0; }
}

const nodes = { "draft-canvas": element(), "selection-canvas": element(), "mask-canvas": null, "stage-background": { style: {} } };
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console, Map, Set, WeakMap, Promise, setTimeout, clearTimeout, Uint8Array, TextEncoder, Image, document: {
  getElementById: (id) => (id in nodes ? nodes[id] : null),
  createElement: () => element()
} };
context.window = context;
context.PointerEvent = function PointerEvent() {};
vm.createContext(context);
function load(name) { vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name }); }
["app/core/namespace.js", "app/core/utils.js", "app/core/runtime.js", "app/core/drawing.js"].forEach(load);

const app = context.hamdraw;
app.services.imageEngine = { schedule: () => {} };
app.services.store = { scheduleCanvasSave: () => {} };
load("app/components/canvas-io.js");
load("app/components/canvas.js");
const canvas = app.components.canvas;
canvas.init();

const SIZE = 768;
function blank() { return new Uint8ClampedArray(SIZE * SIZE * 4); }
function fill(data, size, left, top, width, height) {
  for (let y = top; y < top + height; y += 1) {
    for (let x = left; x < left + width; x += 1) data[(y * size + x) * 4] = 255;
  }
}
function boxAt(size, width, height) {
  const data = new Uint8ClampedArray(size * size * 4);
  fill(data, size, Math.round((size - width) / 2), Math.round((size - height) / 2), width, height);
  return data;
}
function box(width, height) { return boxAt(SIZE, width, height); }
function discAt(size, radius) {
  const data = new Uint8ClampedArray(size * size * 4);
  const centre = size / 2;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = x - centre, dy = y - centre;
      if (dx * dx + dy * dy <= radius * radius) data[(y * size + x) * 4] = 255;
    }
  }
  return data;
}
function disc(radius) { return discAt(SIZE, radius); }
function radiusOf(data) { return canvas.maskFeatherRadius(data, SIZE); }

const MIN = 2, MAX = 10;

assert.equal(radiusOf(blank()), 0, "a mask that marks nothing has nothing to feather");

// The mark decides. A dot takes a few pixels, a mid-size blob more, and a broad
// sweep stops at the ceiling — so the ramp is following what was drawn rather
// than sitting at one number.
const dot = radiusOf(disc(20));
const mid = radiusOf(box(60, 60));
const broad = radiusOf(box(600, 600));
assert.ok(Math.abs(dot - 4.4) < 0.6, "a dot takes 0.22 of its own equivalent radius: " + dot);
assert.ok(Math.abs(mid - 7.5) < 0.6, "a mid-size blob takes proportionally more: " + mid);
assert.equal(broad, MAX, "a broad sweep stops at the ceiling: " + broad);
assert.ok(dot < mid && mid < broad, "the ramp grows with the mark: " + dot + " < " + mid + " < " + broad);

// The range is the whole contract: nothing ever leaves it, whatever was drawn.
for (const [name, data] of [["dot", disc(20)], ["block", box(200, 200)], ["wide", box(600, 600)], ["streak", box(512, 12)], ["edge", box(40, 768)], ["hairline", box(768, 3)]]) {
  const value = radiusOf(data);
  assert.ok(value >= 0 && value <= MAX, "a " + name + " never leaves the 0–" + MAX + " range: " + value);
}
assert.equal(radiusOf(box(200, 200)), MAX, "a large block is capped like any other broad mark: " + radiusOf(box(200, 200)));
assert.equal(radiusOf(box(40, 768)), MAX, "and so is a full-height bar: " + radiusOf(box(40, 768)));
assert.equal(radiusOf(box(512, 12)), 5.4, "a long thin streak is capped by its narrow side, not by its length");

// The one guard that survives from the earlier sizing: a mark only a few pixels
// across takes a smaller ramp than the floor rather than being blurred out of
// existence — smaller, but not zero.
const thin = radiusOf(box(768, 4));
assert.ok(thin > 0 && thin < MIN, "a four-pixel stroke takes less than the floor, not none of it: " + thin);

// The ramp is measured from the mark, so the canvas it sits on does not change it.
assert.equal(canvas.maskFeatherRadius(discAt(384, 20), 384), dot, "the same dot takes the same ramp on a smaller canvas");
assert.equal(canvas.maskFeatherRadius(boxAt(384, 300, 300), 384), MAX, "and a broad mark on a smaller canvas is still capped");

console.log("mask.test.mjs: ok (the ramp follows the mark, 2–10)");
