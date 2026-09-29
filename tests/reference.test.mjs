import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// What leaves the app for a local redraw and what leaves it for a snapshot are two
// different pictures of the same moment, and the difference is the colour grade.
//
// The reference has to be the picture as generated: a grade baked into it would have
// the model repaint against a filtered image and the repainted area then be filtered
// again on the way back to the screen, so it would no longer match its neighbours. The
// snapshot has to be the picture as it is on screen, grade and all, because that is
// what the user put into their artwork.
//
// Pinning those two sentences as text is not enough: the switch can be read and then
// ignored (`var original = false`), which every string assertion in verify.mjs would
// happily keep passing. So the grade is read back off the composition that actually
// reaches the renderer, in the same call the device makes.
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
    toDataURL: () => "data:image/png;base64,x",
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 768, height: 768, right: 768, bottom: 768 }),
    addEventListener: () => {},
    setPointerCapture: () => {}
  };
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console, Map, Set, WeakMap, Promise, setTimeout, clearTimeout, Uint8Array, Float32Array, TextEncoder, Image: class Image {}, document: {
  createElement: () => element(),
  getElementById: () => null
} };
context.window = context;
vm.createContext(context);
function load(name) { vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name }); }
["app/core/namespace.js", "app/core/utils.js", "app/core/runtime.js", "app/core/drawing.js", "app/components/canvas-io.js"].forEach(load);

const app = context.hamdraw;
const state = {
  background: "#ffffff", objects: [], maskMode: false, maskVisible: true,
  resultOpacity: 1, layerOpacity: 1, resultVisible: true, overlayGenerate: false,
  resultAdjustmentsEnabled: true,
  result: { src: "data:image/png;base64,result", slot: "quick" },
  resultBrightness: 100, resultContrast: 100, resultSaturation: 100, resultHue: 0, resultGlow: 0, resultClarity: 0
};

// Every composition that reaches the renderer is kept, so the assertion can be made
// against what the renderer was handed rather than against a variable in a closure.
const rendered = [];
const io = app.components.canvasIo.create({
  state: state,
  WIDTH: 768,
  isMaskStroke: object => object.tool === "mask",
  drawStroke: () => {},
  drawPicture: () => {},
  drawResult: (targetContext, image, width, height, contained, composition) => { rendered.push(composition); },
  drawCovered: () => {},
  loadImage: async () => ({ naturalWidth: 4, naturalHeight: 4 }),
  setSelection: () => {},
  render: () => {},
  commit: () => {},
  resetHistory: () => {}
});

const GRADE_OFF = "the picture that leaves for a local redraw must be the one the model generated, with no colour grade baked in";
const GRADE_ON = "the picture that leaves for a snapshot must be the graded one that is on screen, or the artwork would silently lose its grade";

async function compositionOf(call) {
  rendered.length = 0;
  await call();
  assert.ok(rendered.length, "the renderer must have been handed a composition at all");
  return rendered[rendered.length - 1];
}

const reference = await compositionOf(() => io.composeInput({ withResult: true, size: 64, mime: "image/png" }));
assert.equal(reference.resultAdjustmentsEnabled, false, GRADE_OFF);
assert.equal(reference.localMode, true, "a local redraw's reference must be composed in local mode, so the element layer cannot ride along");

const onScreen = await compositionOf(() => io.composeVisibleInput({ size: 64, mime: "image/png" }));
assert.equal(onScreen.resultAdjustmentsEnabled, true, GRADE_ON);

// The pair has to move in opposite directions, which is what makes this a reading of
// the grade rather than two constants that happen to be different. Flip the source and
// both answers must follow it: the snapshot to ungraded, the reference to ungraded
// still. If either answer was hard-wired, one of these two would stop tracking.
state.resultAdjustmentsEnabled = false;
const ungradedOnScreen = await compositionOf(() => io.composeVisibleInput({ size: 64, mime: "image/png" }));
assert.equal(ungradedOnScreen.resultAdjustmentsEnabled, false, "the snapshot must follow the switch when the switch is off — otherwise the reading above was not a reading");
const stillUngradedReference = await compositionOf(() => io.composeInput({ withResult: true, size: 64, mime: "image/png" }));
assert.equal(stillUngradedReference.resultAdjustmentsEnabled, false, GRADE_OFF);
state.resultAdjustmentsEnabled = true;

// The snapshot is the third caller and the one that must not inherit the switch: it
// goes through the same capture with no overrides at all.
const snapshot = await compositionOf(() => io.snapshotVisible());
assert.equal(snapshot.resultAdjustmentsEnabled, true, GRADE_ON);
assert.equal(snapshot.localMode, false, "a snapshot is not a local redraw, so the element layer must be in it");
assert.equal(state.objects.length, 1, "the snapshot must still land on the canvas as one picture element");

console.log("reference.test.mjs: ok (the local redraw references the ungraded picture, the snapshot keeps the graded one)");
