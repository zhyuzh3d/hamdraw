import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Two halves of the turn feature can only be seen by running it: where the handles land on
// a turned picture, and what a drag does to what is selected. So the canvas is loaded here
// behind a DOM small enough to be honest - every 2D call is a no-op, which is fine because
// nothing below asserts on pixels - and the gestures are dispatched at the very listeners
// the canvas binds for itself. The device self-test walks the same path on the phone; this
// one runs on every verify, so a sign or an anchor that drifts is caught without a device.
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
const handlers = {};
const stage = nodes["draft-canvas"];
stage.addEventListener = (name, handler) => { handlers[name] = handler; };

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
const drawing = app.drawing;
canvas.init();

// One finger. The pointer id is what tells two fingers apart, and the canvas reads a pair off exactly
// that, so a gesture with two of them has to be able to name them.
function firePointer(pointerId, name, x, y) {
  const handler = handlers["pointer" + name];
  assert.ok(handler, "the canvas must bind its own pointer" + name + " listener");
  handler({ type: "pointer" + name, button: 0, isPrimary: pointerId === 1, pointerId, clientX: x, clientY: y, preventDefault: () => {} });
}
function fire(name, x, y) { firePointer(1, name, x, y); }
function picture(overrides) {
  const object = { id: "img", type: "image", url: "data:image/png;base64,AAAA", src: "data:image/png;base64,AAAA", x: 264, y: 284, width: 240, height: 180, logicalFileId: "", name: "t.png" };
  Object.assign(object, overrides || {});
  return object;
}
// Fresh records for every scene: a section that reused the objects the last one turned would be
// testing a selection the user cannot make, and the mixed angles it would leave behind are a
// different case with a different box.
function pencil(overrides) {
  const object = { id: "s", type: "stroke", tool: "pencil", color: "#111111", width: 8, opacity: 1, points: [{ x: 100, y: 100 }, { x: 200, y: 100 }] };
  Object.assign(object, overrides || {});
  return object;
}
function scene(objects, selectedIds) {
  app.state.objects = objects;
  app.state.result = null;
  app.state.history = [];
  app.state.future = [];
  //: The containers go with the objects: a scene that kept the last one's would be testing a
  //: selection no user could make, since the canvas takes a temporary container away the moment the
  //: selection is not its own.
  app.state.groups = {};
  app.state.tool = "select";
  app.state.selectedIds = selectedIds.slice();
  app.state.selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : "";
  canvas.render();
  return objects;
}
// The container a member is in, as the canvas itself reads it. A member only names its group; where
// the group is drawn - its angle and its size - is written down once, on the container, and this is
// where. An object that has never been in a container has none.
function containerOf(object) { return drawing.groupNode(object.groupId); }
function containerAngle(object) { const node = containerOf(object); return node ? drawing.placement.angleOf(node.m) : 0; }
function containerCount() { return Object.keys(app.state.groups || {}).length; }
function keys() { return canvas.selectionHandles().map((handle) => handle.key).join(","); }
function handle(key) { return canvas.selectionHandles().find((item) => item.key === key); }
// A number a comparison can be exact about: a placement read out of a matrix and the same placement
// written down by hand differ in the last bits of the arithmetic, and nothing here is about those.
function round(value) { return Math.round(value * 1e9) / 1e9; }
// The pivot the canvas itself works from: the centre of the box around the selection. For a
// lone picture that is the picture's own centre, at any angle, because the box turns with it.
function frameCentre() {
  const ids = app.state.selectedIds;
  const selected = app.state.objects.filter((object) => ids.indexOf(object.id) >= 0);
  const box = drawing.selectionBounds(selected, drawing.bounds);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
// Drags the grip by `degrees` around the pivot, holding the radius the grip already sits at -
// which is what a finger does when it follows the circle.
function turnBy(degrees) {
  const from = handle("rotate"), centre = frameCentre();
  assert.ok(from, "a selection must offer the turn circle");
  const radius = Math.hypot(from.x - centre.x, from.y - centre.y);
  const start = Math.atan2(from.y - centre.y, from.x - centre.x), land = start + degrees * Math.PI / 180;
  const target = { x: centre.x + Math.cos(land) * radius, y: centre.y + Math.sin(land) * radius };
  fire("down", from.x, from.y);
  fire("move", target.x, target.y);
  fire("up", target.x, target.y);
}
// The same drag made in several moves instead of one. A canvas that folds every frame onto the
// snapshot lands in the same place either way; one that folded each move onto the last would not.
function turnBySteps(degrees, steps) {
  const grip = handle("rotate"), centre = frameCentre();
  assert.ok(grip, "a selection must offer the turn circle");
  const radius = Math.hypot(grip.x - centre.x, grip.y - centre.y);
  const start = Math.atan2(grip.y - centre.y, grip.x - centre.x);
  const at = (turn) => ({ x: centre.x + Math.cos(start + turn) * radius, y: centre.y + Math.sin(start + turn) * radius });
  fire("down", grip.x, grip.y);
  for (let step = 1; step <= steps; step += 1) {
    const land = at(degrees * Math.PI / 180 * step / steps);
    fire("move", land.x, land.y);
  }
  const last = at(degrees * Math.PI / 180);
  fire("up", last.x, last.y);
}
// The same drag, but about the centre of the box the canvas itself is drawing rather than about the
// centre of the box around what is drawn. The two are the same while nothing is turned; once the
// selection has been turned they part company - an upright box around a turned group is not itself a
// turn of the box that was turned - and it is the canvas's own centre the finger has to go round.
function turnAboutFrame(degrees) {
  const frame = canvas.selectionFrame(), grip = handle("rotate");
  assert.ok(grip, "a selection must offer the turn circle");
  const centre = { x: frame.x, y: frame.y };
  const radius = Math.hypot(grip.x - centre.x, grip.y - centre.y);
  const start = Math.atan2(grip.y - centre.y, grip.x - centre.x), land = start + degrees * Math.PI / 180;
  const target = { x: centre.x + Math.cos(land) * radius, y: centre.y + Math.sin(land) * radius };
  fire("down", grip.x, grip.y);
  fire("move", target.x, target.y);
  fire("up", target.x, target.y);
}
function turnPoint(angle, x, y) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}
function turnAbout(value, origin, angle) {
  const turned = turnPoint(angle, value.x - origin.x, value.y - origin.y);
  return { x: origin.x + turned.x, y: origin.y + turned.y };
}
// Every corner of what a member is drawn as, worked out from the record the way the canvas paints it:
// the record's own box through the member's own placement and then through its container's. Both
// levels live in matrices - the member's in its own record, the container's in the container - and
// the pairing of them is the whole of where a member is drawn.
function drawnCorners(object) {
  return drawing.placement.corners(drawing.placedMap(object), drawing.localBounds(object));
}
// A box is the box around what is drawn when both halves hold: nothing drawn falls outside it, and
// every one of its four sides is touched by something drawn. The first alone would pass for any box
// big enough, which is exactly the box that came loose from a selection of members drawn at angles
// that are not the same - a box measured around a member's leaned bounds is larger than the member.
function assertBoxes(corners, frame, label) {
  const half = { x: frame.width / 2, y: frame.height / 2 };
  const edge = { left: 0, right: 0, top: 0, bottom: 0 };
  corners.forEach((point) => {
    const local = turnPoint(-frame.angle, point.x - frame.x, point.y - frame.y);
    assert.ok(Math.abs(local.x) <= half.x + 1e-6 && Math.abs(local.y) <= half.y + 1e-6,
      label + ": every corner of what is drawn must lie inside the box");
    edge.left = Math.min(edge.left, local.x); edge.right = Math.max(edge.right, local.x);
    edge.top = Math.min(edge.top, local.y); edge.bottom = Math.max(edge.bottom, local.y);
  });
  assert.ok(Math.abs(edge.left + half.x) < 1e-6 && Math.abs(edge.right - half.x) < 1e-6 && Math.abs(edge.top + half.y) < 1e-6 && Math.abs(edge.bottom - half.y) < 1e-6,
    label + ": and every side of the box must be touched by one of those corners, or it is not the box around what is drawn");
}
function assertFramedBy(objects, frame, label) {
  const corners = objects.reduce((all, object) => all.concat(drawnCorners(object)), []);
  assertBoxes(corners, frame, label);
}
// The ink of a member: a picture is its record's rectangle, which is the shape itself, and a stroke is
// its points. The difference is the whole point - a record's box is only the extent of a polyline, and
// carrying that box round an angle takes with it a rectangle the stroke does not fill - so a box
// measured on the ink and a box measured on the records are the same box only for pictures, and the
// stroke case is the one where the older measurement stands off the drawing.
function inkPoints(object) {
  const raw = object.type === "image"
    ? [[object.x, object.y], [object.x + object.width, object.y], [object.x, object.y + object.height], [object.x + object.width, object.y + object.height]]
    : object.points.map((point) => [point.x, point.y]);
  const map = drawing.placedMap(object);
  return raw.map((corner) => drawing.placement.apply(map, corner[0], corner[1]));
}
// A brush is round, so its reach past the points is a length with no axis to lean along. Read the way
// the canvas reads it, so that an ink-measured box and the record's own box agree wherever they should.
function inkReach(object) { return object.type === "image" ? 0 : object.width / 2 + 5; }
// Where a point of the record is drawn: through the member's own placement and then its container's.
// What a pull has to be read on, because a record is not the drawing.
function drawnOf(object, point) {
  return drawing.placement.apply(drawing.placedMap(object), point.x, point.y);
}
function hullOf(points) {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  return { left: Math.min.apply(null, xs), right: Math.max.apply(null, xs), top: Math.min.apply(null, ys), bottom: Math.max.apply(null, ys) };
}
// The box around what is drawn, read on the ink: nothing drawn outside it, brush included, and every
// side of it touched by something drawn. The second half is the one that matters - a box that is
// merely large enough passes the first half for any size at all, which is exactly the box that came
// loose from a selection once the records started being measured instead of the shapes.
function assertHugsInk(objects, frame, label) {
  const half = { x: frame.width / 2, y: frame.height / 2 };
  const span = { left: 0, right: 0, top: 0, bottom: 0 };
  objects.forEach((object) => {
    const reach = inkReach(object);
    inkPoints(object).forEach((point) => {
      const local = turnPoint(-frame.angle, point.x - frame.x, point.y - frame.y);
      assert.ok(Math.abs(local.x) + reach <= half.x + 1e-6 && Math.abs(local.y) + reach <= half.y + 1e-6,
        label + ": nothing drawn may lie outside the box, the brush included");
      span.left = Math.min(span.left, local.x - reach); span.right = Math.max(span.right, local.x + reach);
      span.top = Math.min(span.top, local.y - reach); span.bottom = Math.max(span.bottom, local.y + reach);
    });
  });
  assert.ok(Math.abs(span.left + half.x) < 1e-6 && Math.abs(span.right - half.x) < 1e-6 && Math.abs(span.top + half.y) < 1e-6 && Math.abs(span.bottom - half.y) < 1e-6,
    label + ": and every side of the box must be touched, or the box is larger than the objects it boxes - which is the complaint it exists to answer");
}
// A pull is a map of the plane about the corner being held: each axis by its own factor, read in the
// box's own axes. Where a point of the ink lands under it is the assertion, because that is what the
// hand sees - and because it is the one reading that tells the two-axis pull from a single factor
// shared by both axes, which is what the gesture must never become.
function assertPulledInk(frame, pin, before, after, factorX, factorY, label) {
  assert.equal(before.length, after.length, label + ": the ink must not gain or lose points");
  before.forEach((point, index) => {
    const local = turnPoint(-frame.angle, point.x - pin.x, point.y - pin.y);
    const want = turnPoint(frame.angle, local.x * factorX, local.y * factorY);
    assert.ok(Math.abs(after[index].x - (pin.x + want.x)) < 1e-6 && Math.abs(after[index].y - (pin.y + want.y)) < 1e-6,
      label + ": ink point " + index + " must land where the pull puts it - " + factorX + " times as far out on one axis and " + factorY + " on the other, from the corner being held");
  });
}
// Every number a transform could write to a member. A group is transformed by transforming the group,
// so not one of these may move - and a reading that looked only at the geometry would not notice a
// member that had been handed a placement of its own instead: a matrix, an offset, a centre to turn
// about. The three of them are what a member's own layer can be written as, and all three are here.
function memberNumbers(object) {
  return JSON.stringify([object.x, object.y, object.width, object.height, object.rotation, object.rotationPivot, object.linear, object.offset, object.points]);
}
function assertMembersUnchanged(objects, before, label) {
  assert.equal(objects.map(memberNumbers).join("|"), before.join("|"), label);
}
// A point of the canvas named in the box's own axes: the box's centre, plus that much along the box's
// own two directions. Where a finger has to come down inside a turned box, this is how it is aimed.
function boxPoint(localX, localY) {
  const frame = canvas.selectionFrame();
  assert.ok(frame, "a box to aim at");
  const turned = turnPoint(frame.angle, localX, localY);
  return { x: frame.x + turned.x, y: frame.y + turned.y };
}
function midpointOf(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
// Two fingers: both down inside the box, both moved, then both lifted. The pair is answered only when
// both come down inside the box, so the four points are aimed in the box's own frame.
function pinchFingers(a0, b0, a1, b1) {
  firePointer(1, "down", a0.x, a0.y);
  firePointer(2, "down", b0.x, b0.y);
  firePointer(1, "move", a1.x, a1.y);
  firePointer(2, "move", b1.x, b1.y);
  firePointer(1, "up", a1.x, a1.y);
  firePointer(2, "up", b1.x, b1.y);
}
// One finger, down, across, up. Past the threshold a drag has to pass before it is a drag, with room
// to spare, so that what is measured below is the gesture and not the threshold.
function dragFrom(from, dx, dy) {
  fire("down", from.x, from.y);
  fire("move", from.x + dx, from.y + dy);
  fire("up", from.x + dx, from.y + dy);
}
function dragBox(dx, dy) { dragFrom({ x: canvas.selectionFrame().x, y: canvas.selectionFrame().y }, dx, dy); }

// 1. An upright picture is boxed by its own rectangle: the four corners, then the circle.
scene([picture()], ["img"]);
assert.equal(keys(), "nw,ne,sw,se,rotate", "the corners must come first and the circle last, for the array order is also the order taps are tested in");
assert.deepEqual({ x: handle("nw").x, y: handle("nw").y }, { x: 264, y: 284 }, "an upright picture must be boxed by the rectangle its record spells out");
assert.deepEqual({ x: handle("se").x, y: handle("se").y }, { x: 504, y: 464 }, "and by all four of its corners");
assert.ok(handle("rotate").y > 284 + 180 && Math.abs(handle("rotate").x - 384) < 1e-9, "the circle must hang below the box, centred under its bottom edge");

// The circle's distance to the bottom edge is the owner's number, and it is measured off the
// handles the canvas hands out rather than read off the constant, because what matters is where
// the circle lands on the box.
assert.equal(handle("rotate").radius, 27, "the turn circle must be drawn at 27 - half again the 18 it was - and must stay the biggest handle on the box");
assert.equal(handle("rotate").reach, 60, "and must reach 60, so a bigger picture is not a smaller target");
assert.ok(handle("rotate").radius > handle("nw").radius, "the circle must stay wider than a corner handle, which is what makes it read as a different kind of handle");
// Halving that distance puts the circle nearer the edge than its own reach is long, so "which
// target answers" can no longer be settled by distance alone: where the circle's aim crosses the
// box, the box has to win. Every reading below is what the gesture then does, not which handle
// was picked, so a circle that merely got closer without giving the edge back is caught.
[4, 40, 240, 900].forEach((width) => {
  scene([picture({ width: width })], ["img"]);
  const frame = canvas.selectionFrame(), grip = handle("rotate");
  assert.ok(Math.abs(grip.y - (frame.y + frame.height / 2) - 56) < 1e-9,
    "at width " + width + " the circle must hang 56 below the bottom edge - half the 112 it hung, so it sits near the edge where a thumb already is");

  // Each corner keeps its own ink, however narrowly the circle aims at it: a grab on a corner
  // resizes and never turns. At width 4 the corners and the circle are all inside one finger.
  const corner = handle("sw");
  fire("down", corner.x, corner.y);
  fire("move", corner.x - 60, corner.y + 60);
  fire("up", corner.x - 60, corner.y + 60);
  assert.equal(app.state.objects[0].rotation, undefined, "at width " + width + " a grab on the sw corner must not turn the picture, however close the circle has come");
  assert.ok(app.state.objects[0].width > width, "at width " + width + " the corner must still answer as a corner, and widen the box");
});
// The sliver the circle now covers is the box's own bottom edge, and that edge belongs to the
// object: a touch there drags it. Widths where the corners reach the middle of the edge are left
// out - at 4 and 40 the corner answers first, which is a different promise, tested above.
[240, 900].forEach((width) => {
  scene([picture({ width: width })], ["img"]);
  const grip = handle("rotate"), edge = { x: grip.x, y: grip.y - 56 };
  assert.ok(Math.hypot(grip.x - edge.x, grip.y - edge.y) <= grip.reach, "at width " + width + " this reading only means something while the circle's reach covers the edge");
  fire("down", edge.x, edge.y);
  fire("move", edge.x + 30, edge.y);
  fire("up", edge.x + 30, edge.y);
  assert.equal(app.state.objects[0].rotation, undefined, "at width " + width + " a touch on the box's own bottom edge must not start a turn, even though the circle's reach now covers it");
  assert.ok(Math.abs(app.state.objects[0].x - (264 + 30)) < 1e-9, "and that touch must still drag the object, which is what the edge has always done");
});

// 2. A turned picture is boxed by its own turned rectangle, not by the larger upright box that
//    contains it. At 30 degrees those are two different rectangles, so the corner assertion
//    below means something: the bounds really are the wider one.
const angle = Math.PI / 6;
scene([picture({ rotation: angle })], ["img"]);
const centre = { x: 384, y: 374 };
const bounds = drawing.bounds(app.state.objects[0]);
assert.ok(Math.abs(bounds.width - (240 * Math.abs(Math.cos(angle)) + 180 * Math.abs(Math.sin(angle)))) < 1e-6 && bounds.width > 240, "the containing bounds of a picture turned 30 degrees must be the wider box, or this test would not tell the two apart");
const nw = turnPoint(angle, -120, -90);
assert.ok(Math.abs(handle("nw").x - (centre.x + nw.x)) < 1e-6 && Math.abs(handle("nw").y - (centre.y + nw.y)) < 1e-6, "the box must ride the picture's angle rather than the upright bounds around it");
assert.ok(handle("rotate").y > centre.y, "the circle must stay on the outside of the turned box");

// 3. A quarter turn lands on sideways exactly, and the picture turns where it stands.
scene([picture()], ["img"]);
turnBy(90);
assert.equal(app.state.objects[0].rotation, Math.PI / 2, "a quarter turn must land on sideways exactly, not within a rounding of it");
const turned = drawing.bounds(app.state.objects[0]);
assert.ok(Math.abs(turned.x + turned.width / 2 - centre.x) < 1e-9 && Math.abs(turned.y + turned.height / 2 - centre.y) < 1e-9, "a turn must leave the box's centre where it was, or the picture would walk across the canvas");
assert.ok(Math.abs(turned.width - 180) < 1e-6 && Math.abs(turned.height - 240) < 1e-6, "a quarter turn must swap the picture's sides");
assert.equal(app.state.history.length, 1, "a turn must be one step in the journal");

// 4. The magnet holds a few degrees and nothing more. Both halves matter: without the first a
//    picture can never be brought back to level by hand - it keeps a residue like 0.7 degrees -
//    and with too strong a magnet a small turn would be silently swallowed instead.
turnBy(3);
assert.equal(app.state.objects[0].rotation, Math.PI / 2, "a few degrees of residue must be absorbed into upright");
assert.equal(app.state.history.length, 1, "an absorbed drag must not land in the journal");
turnBy(-40);
assert.ok(Math.abs(app.state.objects[0].rotation - (Math.PI / 2 - 40 * Math.PI / 180)) < 1e-3, "a real turn must not be swallowed by the magnet");
assert.equal(app.state.history.length, 2, "and it must be a step of its own");

// 5. Pulling a corner of a turned picture holds the corner opposite exactly still, which is what
//    the drawn, turned box promises. Working from the upright bounds instead would slide the
//    picture sideways the moment the two boxes stop coinciding.
scene([picture({ rotation: angle })], ["img"]);
const anchored = drawing.selectionBounds(app.state.objects, drawing.bounds);
const anchorBefore = handle("nw"), oppositeBefore = handle("se");
fire("down", oppositeBefore.x, oppositeBefore.y);
const pulled = { x: anchorBefore.x + (oppositeBefore.x - anchorBefore.x) * 1.5, y: anchorBefore.y + (oppositeBefore.y - anchorBefore.y) * 1.5 };
fire("move", pulled.x, pulled.y);
fire("up", pulled.x, pulled.y);
const anchorAfter = handle("nw"), resized = app.state.objects[0];
assert.ok(Math.abs(anchorAfter.x - anchorBefore.x) < 1e-6 && Math.abs(anchorAfter.y - anchorBefore.y) < 1e-6, "the corner opposite the one being pulled must not move");
assert.ok(Math.abs(resized.width - 240 * 1.5) < 1e-6 && Math.abs(resized.height - 180 * 1.5) < 1e-6, "the drag must scale by the same ratio it was pulled by");
assert.ok(Math.abs(resized.rotation - angle) < 1e-12, "resizing a turned picture must leave its angle alone");
assert.ok(anchored.width > 0);

// 6. A group turns as one, and not one number of the geometry it is stored on moves: the whole
//    selection is given one angle about one centre, and that angle is written on the container
//    around it - which is one rigid turn of everything inside. The rectangle turns with it - the
//    container's own rectangle, measured around the members before the turn - because a box that
//    re-fitted itself upright around a turned group would tell the user the selection is straight
//    when it is not. The centre is the centre of the box being held, which is what keeps the box
//    spinning where it is instead of swinging around some other point.
const pencilGroup = [pencil(), picture({ id: "img", x: 300, y: 300, width: 120, height: 120 })];
scene(pencilGroup, ["s", "img"]);
const pivot = frameCentre(), before = { nw: handle("nw"), ne: handle("ne"), sw: handle("sw"), se: handle("se") };
turnBy(90);
const [turnedStroke, turnedPicture] = app.state.objects;
assert.equal(turnedStroke.points[0].x, 100, "a turn must be carried by the container alone: a stroke that moved its own points would creep a little on every drag of the same handle");
assert.equal(turnedPicture.x, 300, "and a picture must keep the four numbers it was stored with");
assert.equal(turnedStroke.groupId, turnedPicture.groupId, "both members must name the one container, or there would be nothing holding the turn they share");
const turnedContainer = containerOf(turnedStroke);
assert.ok(turnedContainer, "and that container must really be there, since a name with nothing behind it is not a group");
assert.ok(Math.abs(drawing.placement.angleOf(turnedContainer.m) - Math.PI / 2) < 1e-9,
  "the turn must be written on the container, at the one angle the whole selection was turned through");
const held = drawing.placement.apply(turnedContainer.m, pivot.x, pivot.y);
assert.ok(Math.abs(held.x - pivot.x) < 1e-9 && Math.abs(held.y - pivot.y) < 1e-9,
  "and about the centre of the box the user is holding, which is the one point a turn leaves where it is");
assert.ok(turnedStroke.rotation === undefined && turnedPicture.rotation === undefined,
  "the turn belongs to the container and not to the members: a member that adopted the turn as its own angle would have no angle left that was its own");
assert.ok(turnedStroke.linear === undefined && turnedPicture.linear === undefined && turnedStroke.offset === undefined,
  "and takes no placement of its own at all, which is what a member that has never been transformed on its own looks like");
// Where it is drawn: the stroke's own extent, 118 by 18, carried a quarter turn about that centre.
const strokeBox = drawing.bounds(turnedStroke), strokeDrawnCentre = turnAbout({ x: 150, y: 100 }, pivot, Math.PI / 2);
assert.ok(Math.abs(strokeBox.width - 18) < 1e-9 && Math.abs(strokeBox.height - 118) < 1e-9, "a quarter turn must swap a stroke's sides just as it swaps a picture's");
assert.ok(Math.abs(strokeBox.x + strokeBox.width / 2 - strokeDrawnCentre.x) < 1e-9 && Math.abs(strokeBox.y + strokeBox.height / 2 - strokeDrawnCentre.y) < 1e-9,
  "and must leave it drawn where the turn put it, not where a fresh box would put it");
// The box itself: turned, centred where it was, and every corner the corner it already had.
const groupFrame = canvas.selectionFrame();
assert.ok(Math.abs(groupFrame.angle - Math.PI / 2) < 1e-9, "the box around a turned group must turn with it instead of re-fitting itself upright");
assert.ok(Math.abs(groupFrame.x - pivot.x) < 1e-9 && Math.abs(groupFrame.y - pivot.y) < 1e-9, "and must keep the centre it was turned about, or the box would slide off what it boxes");
["nw", "ne", "sw", "se"].forEach((key) => {
  const corner = handle(key), back = turnAbout({ x: corner.x, y: corner.y }, pivot, -Math.PI / 2);
  assert.ok(Math.abs(back.x - before[key].x) < 1e-6 && Math.abs(back.y - before[key].y) < 1e-6, "the " + key + " corner must be the corner it already was, carried round by the turn");
});
assert.ok(Math.hypot(handle("rotate").x - pivot.x, handle("rotate").y - pivot.y) > groupFrame.height / 2, "and the circle must stay outside the turned box, wherever the box is turned to");

// 7. A tap is answered by the picture, not by the empty corner of the box around it.
scene([picture({ rotation: Math.PI / 4 })], []);
const cornerOfBox = { x: drawing.bounds(app.state.objects[0]).x + 2, y: drawing.bounds(app.state.objects[0]).y + 2 };
fire("down", cornerOfBox.x, cornerOfBox.y);
fire("up", cornerOfBox.x, cornerOfBox.y);
assert.equal(app.state.selectedIds.length, 0, "the empty triangle beside a turned picture must not select it");
fire("down", 384, 374);
fire("up", 384, 374);
assert.equal(app.state.selectedIds.join(","), "img", "a tap on the picture itself must still select it");

// 8. A turned group resizes the way a turned picture does, which is what the corners of a turned
//    box are for: pulling one stretches the whole selection along the box's own axes and leaves the
//    corner opposite exactly where the box promised it was. What is stretched is the container, so
//    the members' records do not move at all - which is the whole of "transforming a group touches
//    the group and not the things in it": two pictures first, so that the box is drawn by the
//    pictures themselves and the corner can be held to the last bit of precision.
scene([picture({ id: "a", x: 100, y: 120, width: 200, height: 160 }), picture({ id: "b", x: 380, y: 300, width: 120, height: 120 })], ["a", "b"]);
turnBy(90);
const pairHeld = handle("nw"), pairPulled = handle("se");
const pairRecords = app.state.objects.map((object) => ({ x: object.x, y: object.y, width: object.width, height: object.height, rotation: object.rotation, linear: object.linear }));
fire("down", pairPulled.x, pairPulled.y);
const pairTarget = { x: pairHeld.x + (pairPulled.x - pairHeld.x) * 1.5, y: pairHeld.y + (pairPulled.y - pairHeld.y) * 1.5 };
fire("move", pairTarget.x, pairTarget.y);
fire("up", pairTarget.x, pairTarget.y);
const pairCorner = handle("nw"), pairFrame = canvas.selectionFrame();
assert.ok(Math.abs(pairCorner.x - pairHeld.x) < 1e-9 && Math.abs(pairCorner.y - pairHeld.y) < 1e-9, "the corner opposite the one being pulled must not move at all, however the group is turned");
assert.ok(Math.abs(handle("se").x - pairTarget.x) < 1e-9 && Math.abs(handle("se").y - pairTarget.y) < 1e-9, "and the corner being pulled must land under the finger");
assert.ok(Math.abs(pairFrame.width - 400 * 1.5) < 1e-9 && Math.abs(pairFrame.height - 300 * 1.5) < 1e-9, "the pull must stretch the box by the ratio it was pulled by, on both axes");
assert.ok(Math.abs(pairFrame.angle - Math.PI / 2) < 1e-9, "and leave the box at the angle it was already at: a group pulled by the same amount on both axes is still a turned group");
app.state.objects.forEach((object, index) => {
  const record = pairRecords[index];
  assert.ok(object.x === record.x && object.y === record.y && object.width === record.width && object.height === record.height,
    "member " + index + " must keep the four numbers it is stored with: the stretch belongs to the container, so nothing inside it is rewritten");
  assert.ok(object.rotation === record.rotation && object.linear === record.linear,
    "and must not be given a placement of its own either, which is what a resize that reached inside the group would do");
});
assert.equal(containerCount(), 1, "and it must stay one container: a resize that made a second one would leave the first holding half a group");
// A stroke answers with a fixed margin around itself - five pixels plus half its line - and the
// margin is fixed in the record, which the container's stretch carries with the rest of the drawing.
// So the drawn line is scaled exactly like everything else, and its reach is asserted on the drawn
// brush rather than on a record that is not rewritten at all any more.
scene([pencil(), picture({ id: "img", x: 300, y: 300, width: 120, height: 120 })], ["s", "img"]);
turnBy(180);
const strokeHeld = handle("nw"), strokePulled = handle("se");
fire("down", strokePulled.x, strokePulled.y);
const strokeTarget = { x: strokeHeld.x + (strokePulled.x - strokeHeld.x) / 2, y: strokeHeld.y + (strokePulled.y - strokeHeld.y) / 2 };
fire("move", strokeTarget.x, strokeTarget.y);
fire("up", strokeTarget.x, strokeTarget.y);
const strokeCorner = handle("nw"), scaledStroke = app.state.objects[0], scaledPicture = app.state.objects[1];
// What a member is drawn at, size and angle together: its record's sides through its own placement
// and then its container's.
function drawnSize(object) {
  const axes = drawing.placement.axesOf(drawing.placedMap(object));
  const box = drawing.localBounds(object);
  return { width: box.width * axes[0], height: box.height * axes[1] };
}
assert.equal(scaledPicture.x, 300, "the picture's record must be left exactly as it was: a group resize writes to the container and to nothing else");
assert.ok(Math.abs(drawnSize(scaledPicture).width - 60) < 1e-6 && Math.abs(drawnSize(scaledPicture).height - 60) < 1e-6, "while the picture as drawn must be half the size, which is the ratio the box was pulled by");
assert.ok(Math.abs(scaledStroke.width * drawing.placement.axesOf(drawing.placedMap(scaledStroke))[0] - 4) < 1e-9, "and a stroke's line as drawn must scale with it, not stay the width it was drawn at");
assert.ok(Math.abs(scaledStroke.points[1].x - scaledStroke.points[0].x - 100) < 1e-9, "and its own points must be left alone, since the container carries the stretch for it");
const scaledInk = inkPoints(scaledStroke);
const inkSpanX = scaledInk.reduce((span, point) => ({ left: Math.min(span.left, point.x), right: Math.max(span.right, point.x) }), { left: Infinity, right: -Infinity });
assert.ok(Math.abs(inkSpanX.right - inkSpanX.left - 50) < 1e-9, "so its own extent as drawn must be half of what it was: a hundred points become fifty");
assert.ok(Math.abs(strokeCorner.x - strokeHeld.x) < 3 && Math.abs(strokeCorner.y - strokeHeld.y) < 3, "the corner opposite must still be held, within the slack a stroke's fixed margin costs");

// 9. Turning back by exactly what it was turned costs nothing, in a group as much as alone: the
//    reverse turn is written against the state the second drag began with - which is the container
//    as the first turn left it - so it takes the first turn straight back out rather than being
//    folded into the members one at a time. Two turns that cancel are the case a single angle cannot
//    spell, which is why the container is a matrix and not a pair of numbers; what is asserted is
//    what is drawn, and after a two-step drag as well: a drag that arrived in one jump and a drag
//    that arrived in two must leave the same thing behind, which is the promise of rebuilding every
//    frame from the snapshot rather than folding each move onto the last.
scene([pencil(), picture({ id: "img", x: 300, y: 300, width: 120, height: 120 })], ["s", "img"]);
const roundStart = app.state.objects.map((object) => drawing.bounds(object));
turnBy(90);
const turnedNode = containerOf(app.state.objects[0]);
assert.ok(turnedNode && Math.abs(drawing.placement.angleOf(turnedNode.m) - Math.PI / 2) < 1e-9,
  "the turn must really have been given at the container, or there is nothing for the reverse turn below to be written against");
turnBy(-90);
const roundEnd = app.state.objects.map((object) => drawing.bounds(object));
roundStart.forEach((box, index) => {
  const back = roundEnd[index];
  assert.ok(Math.abs(back.x - box.x) < 1e-6 && Math.abs(back.y - box.y) < 1e-6 && Math.abs(back.width - box.width) < 1e-6 && Math.abs(back.height - box.height) < 1e-6,
    "member " + index + " must be drawn where it started after a turn and its reverse");
});
// The container is what the two turns were written on, so the container is what comes back: the same
// one, holding both turns and their sum. A build that melted the container between the two drags, or
// that made a second one for the reverse turn, would have to write the members to do it.
assert.equal(containerCount(), 1, "the two turns must have gone onto the one container, not onto two");
assert.ok(Math.abs(drawing.placement.angleOf(containerOf(app.state.objects[0]).m)) < 1e-6, "and a turn and its reverse must leave that container at no angle at all");
assert.ok(Math.abs(drawing.placement.axesOf(containerOf(app.state.objects[0]).m)[0] - 1) < 1e-9, "at its own size, neither stretched nor shrunk");
app.state.objects.forEach((object, index) => {
  assert.ok(object.rotation === undefined && object.linear === undefined && object.offset === undefined && object.groupRotation === undefined && object.groupPivot === undefined,
    "member " + index + " must never have been touched by either turn: not one number of its record is the turning's business");
});
scene([picture()], ["img"]);
const jumpStart = drawing.bounds(app.state.objects[0]);
turnBySteps(90, 4);
turnBySteps(-90, 3);
const jumpEnd = drawing.bounds(app.state.objects[0]);
assert.ok(Math.abs(jumpEnd.x - jumpStart.x) < 1e-9 && Math.abs(jumpEnd.width - jumpStart.width) < 1e-9, "a lone picture must come back to its own rectangle exactly, not to within a rounding of it, even when the drag arrived in four moves and left in three");

// 10. A corner drag is two drags, one per axis: pull the bottom right corner further right than
//     down and the box gets wider more than it gets taller, which is how a picture is made long
//     and thin. What tells this apart from a scale is where the dragged corner lands - it must be
//     under the finger on both axes at once, read in the box's own axes - while the corner
//     opposite stays exactly where it was. Turned as well as upright, since a box that only knows
//     how to scale all of itself by one number fails the first assertion the moment the two
//     numbers differ, and a box that reads the upright bounds of a turned picture fails the second.
[{ name: "upright", angle: 0 }, { name: "turned", angle: Math.PI / 6 }].forEach((mode) => {
  const record = picture();
  if (mode.angle) record.rotation = mode.angle;
  scene([record], ["img"]);
  const pinned = handle("nw"), grabbed = handle("se");
  const pull = turnPoint(mode.angle, 40, 50);
  const finger = { x: grabbed.x + pull.x, y: grabbed.y + pull.y };
  fire("down", grabbed.x, grabbed.y);
  fire("move", finger.x, finger.y);
  fire("up", finger.x, finger.y);
  const resized = app.state.objects[0], after = canvas.selectionFrame();
  assert.ok(Math.abs(handle("se").x - finger.x) < 1e-9 && Math.abs(handle("se").y - finger.y) < 1e-9,
    "a " + mode.name + " box must put the corner being pulled under the finger on both axes, or the gesture is not the one the finger made");
  assert.ok(Math.abs(handle("nw").x - pinned.x) < 1e-9 && Math.abs(handle("nw").y - pinned.y) < 1e-9,
    "and must hold the corner opposite it still, at an angle as much as upright");
  assert.ok(Math.abs(resized.width - 280) < 1e-9 && Math.abs(resized.height - 230) < 1e-9,
    "a " + mode.name + " picture must take each side's own share of the pull: 40 across and 50 down, not one ratio for both");
  assert.ok(Math.abs(after.width - 280) < 1e-9 && Math.abs(after.height - 230) < 1e-9 && Math.abs(after.angle - mode.angle) < 1e-12,
    "and the box must be the resized box, at the angle it was already at");
  assert.equal(resized.rotation, mode.angle || undefined, "resizing must leave the angle the picture already carried exactly as it was");
});

// 11. A pull that lengthens the box without changing its width is still a change, and still a step
//     of the journal. The factor belonging to the axis that did not move lands on exactly one, so a
//     build that read only the first of the two would drop the step and the pull could not be taken
//     back - which is the sort of thing a straight-down drag makes visible and an angled one hides.
scene([picture()], ["img"]);
const tallerGrab = handle("se"), tallerPin = handle("nw"), stepsBefore = app.state.history.length;
fire("down", tallerGrab.x, tallerGrab.y);
fire("move", tallerPin.x + 240, tallerPin.y + 230);
fire("up", tallerPin.x + 240, tallerPin.y + 230);
assert.equal(app.state.objects[0].width, 240, "a pull straight down from the corner must leave the width exactly as it was, to the last bit");
assert.ok(Math.abs(app.state.objects[0].height - 230) < 1e-9, "and must lengthen the box by the whole of the pull");
assert.equal(app.state.history.length, stepsBefore + 1, "and it must still be one step of the journal, or a pull that moved a single axis could never be taken back");

// 12. A selection of members turned against each other still turns as one box - which is the whole
//     reason a group is a container with an angle of its own. No member is asked to adopt another's
//     angle: each keeps its own, and keeps it when the group is broken up again, while the
//     container's angle is what the whole selection is turned through. Before the turn there is no
//     container and so the box is the tight upright rectangle around what is drawn. After it, the box
//     is the container's own rectangle - the one measured before the turn - carried round by the
//     turn: it is the box the user was holding, the box they can see, and not a rectangle re-fitted
//     to face the canvas. A box that re-fitted itself would tell the user a turned selection is
//     straight, and would change size as it turned, which is what a box nobody is holding must not do.
const mixedGroup = [
  picture({ id: "a", x: 200, y: 260, width: 200, height: 140, rotation: Math.PI / 6 }),
  picture({ id: "b", x: 460, y: 400, width: 160, height: 200 })
];
scene(mixedGroup, ["a", "b"]);
const mixedFrame = canvas.selectionFrame(), mixedPivot = { x: mixedFrame.x, y: mixedFrame.y };
const mixedCorners = { nw: handle("nw"), se: handle("se") };
const mixedDrawn = mixedGroup.map((object) => { const box = drawing.bounds(object); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
assert.equal(mixedFrame.angle, 0, "a selection that no one has transformed yet is boxed upright, whatever angles its members carry");
assert.equal(containerCount(), 0, "and it is in no container yet: a container is made by transforming, not by selecting");
assertFramedBy(mixedGroup, mixedFrame, "the box around two members at different angles before the turn");
turnAboutFrame(90);
const mixedTurned = app.state.objects, mixedAfter = canvas.selectionFrame();
assert.ok(Math.abs(mixedAfter.angle - Math.PI / 2) < 1e-9,
  "after the turn the box is the container's own rectangle, turned by the angle the selection was turned through - not a rectangle re-fitted upright to face the canvas");
assert.ok(Math.abs(mixedAfter.width - mixedFrame.width) < 1e-9 && Math.abs(mixedAfter.height - mixedFrame.height) < 1e-9,
  "and it is the same rectangle, neither wider nor narrower: the turn is rigid, so the box the user held is the box they still hold");
assert.ok(Math.abs(mixedAfter.x - mixedFrame.x) < 1e-9 && Math.abs(mixedAfter.y - mixedFrame.y) < 1e-9,
  "still centred where it was, because the turn was given about that centre");
assertFramedBy(mixedTurned, mixedAfter, "the box around two members at different angles after the turn");
assert.equal(containerCount(), 1, "and the whole selection is in the one container, or its box would stop turning");
["nw", "se"].forEach((key) => {
  const corner = handle(key), carried = turnAbout(mixedCorners[key], mixedPivot, Math.PI / 2);
  assert.ok(Math.abs(corner.x - carried.x) < 1e-9 && Math.abs(corner.y - carried.y) < 1e-9,
    "the " + key + " handle must be the corner it already was, carried round by the turn: the box is where the hand left it, not re-fitted");
});
mixedTurned.forEach((object) => {
  assert.equal(object.rotation, object.id === "a" ? Math.PI / 6 : undefined,
    "a member must keep the angle it was drawn at: the turn belongs to the container, so a member that took the turn as its own angle would have been straightened out instead");
  assert.ok(Math.abs(containerAngle(object) - Math.PI / 2) < 1e-9, "and its container must carry the turn, which is the one angle the whole selection shares");
});
assert.ok(Math.abs(containerOf(mixedTurned[0]).m[4] - containerOf(mixedTurned[1]).m[4]) < 1e-9,
  "one container for the whole selection: two containers would come apart on the next drag");
mixedDrawn.forEach((centre, index) => {
  const box = drawing.bounds(mixedTurned[index]), carried = turnAbout(centre, mixedPivot, Math.PI / 2);
  assert.ok(Math.abs(box.x + box.width / 2 - carried.x) < 1e-9 && Math.abs(box.y + box.height / 2 - carried.y) < 1e-9,
    "member " + index + " must be drawn where the turn put it, so the whole selection moved as one rigid piece");
});
// A member that joins a turned selection arrives without a container of its own. The selection then
// has no one container to turn in, so the containers already in play are folded into their members -
// which moves nothing - and the whole selection carries on in one fresh, upright container. The
// picture a member is drawn at is the same before and after that folding, and the folding is not
// something the user asked for: it is what makes one box around the whole selection possible at all.
app.state.objects.push(picture({ id: "c", x: 620, y: 300, width: 140, height: 140 }));
app.state.selectedIds = ["a", "b", "c"]; app.state.selectedId = "c"; canvas.render();
const jointFrame = canvas.selectionFrame(), jointPivot = { x: jointFrame.x, y: jointFrame.y };
const jointDrawn = app.state.objects.map((object) => { const box = drawing.bounds(object); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
assert.equal(jointFrame.angle, 0, "a selection that cannot agree on one container starts from an upright one, which is what makes a single box around it possible at all");
assertFramedBy(app.state.objects, jointFrame, "the box around a selection that arrived without one container");
turnAboutFrame(90);
const jointTurned = app.state.objects, jointAfter = canvas.selectionFrame();
assert.ok(Math.abs(jointAfter.angle - Math.PI / 2) < 1e-9, "and after the turn it is that fresh container's rectangle, turned by the angle the selection was turned through");
assertFramedBy(jointTurned, jointAfter, "the box around a selection that arrived without one container, after the turn");
jointDrawn.forEach((centre, index) => {
  const box = drawing.bounds(jointTurned[index]), carried = turnAbout(centre, jointPivot, Math.PI / 2);
  assert.ok(Math.abs(box.x + box.width / 2 - carried.x) < 1e-9 && Math.abs(box.y + box.height / 2 - carried.y) < 1e-9,
    "member " + index + " must be drawn where the turn put it, whether or not it arrived carrying a container of its own");
});
assert.equal(containerCount(), 1, "and the containers the members arrived in must be gone, folded into them: the selection ends up in one container, not in three");
const jointIds = jointTurned.map((object) => object.groupId);
assert.ok(jointIds[0] && jointIds.every((id) => id === jointIds[0]), "all three members naming the one container, or the box would stop turning on the next drag");

// 13. A picture that has been turned carries the centre it turns about in its record, and a pull must
//     leave that centre where it is. It is the one point a turn leaves alone, so a pull that let the
//     centre drift to the new centre of the record - which is what happens when the placement is read
//     off the record's own box, and the box has just changed size - would swing the whole picture
//     while the corner under the hand stayed where it was put. An anisotropic pull about a corner is
//     the case that shows it, because the pulled record is not the same shape about the same centre.
scene([picture()], ["img"]);
turnBy(90);
const turnedRecord = app.state.objects[0];
const carriedPivot = turnedRecord.rotationPivot;
assert.ok(carriedPivot, "a picture turned on its own must carry the centre it turns about, or there is nothing here for the pull to keep still");
const pinnedInk = inkPoints(turnedRecord);
const pulledGrab = handle("se"), pulledPin = handle("nw");
const pulledFrame = canvas.selectionFrame();
const localOffset = turnPoint(-pulledFrame.angle, pulledGrab.x - pulledPin.x, pulledGrab.y - pulledPin.y);
const spread = turnPoint(pulledFrame.angle, localOffset.x * 1.6, localOffset.y * 0.7);
const pulledFinger = { x: pulledPin.x + spread.x, y: pulledPin.y + spread.y };
fire("down", pulledGrab.x, pulledGrab.y);
fire("move", pulledFinger.x, pulledFinger.y);
fire("up", pulledFinger.x, pulledFinger.y);
const pulledObject = app.state.objects[0], resizedPivot = pulledObject.rotationPivot;
assert.ok(Math.abs(handle("se").x - pulledFinger.x) < 1e-9 && Math.abs(handle("se").y - pulledFinger.y) < 1e-9, "a two-axis pull on a picture that carries a centre must still land the corner under the finger");
assert.ok(Math.abs(resizedPivot.x - carriedPivot.x) < 1e-9 && Math.abs(resizedPivot.y - carriedPivot.y) < 1e-9,
  "and must leave the centre where it was: it is the point the turn leaves alone, so moving it moves the picture");
assert.ok(Math.abs(pulledObject.x + pulledObject.width / 2 - carriedPivot.x) > 1,
  "which is not the centre of the pulled record, or this would pass on a record that never had a centre of its own at all");
inkPoints(pulledObject).forEach((point, index) => {
  const local = turnPoint(-pulledFrame.angle, pinnedInk[index].x - pulledPin.x, pinnedInk[index].y - pulledPin.y);
  const want = turnPoint(pulledFrame.angle, local.x * 1.6, local.y * 0.7);
  assert.ok(Math.abs(point.x - (pulledPin.x + want.x)) < 1e-6 && Math.abs(point.y - (pulledPin.y + want.y)) < 1e-6,
    "ink point " + index + " must land where a stretch of the box's own axes puts it, read from the corner being held");
});

// 14. A member of a turned group, taken on its own, is boxed by what is drawn and by nothing else.
//     The box has to say the whole of the member's angle - its own, with the container's on top -
//     because that is the angle the picture is drawn at; and it has to be the picture's own box,
//     because a box the picture does not fill is a box whose corners are not on the shape. Reading
//     the container's angle alone put the box at half the turn, and measuring the box around the
//     member's leaned rectangle widened it: those are the two symptoms of a box that came loose from
//     its picture the moment two members at different angles were turned as a group.
const pickedGroup = [
  picture({ id: "a", x: 200, y: 260, width: 200, height: 140, rotation: Math.PI / 6 }),
  picture({ id: "b", x: 460, y: 400, width: 160, height: 200, rotation: -Math.PI / 9 })
];
scene(pickedGroup, ["a", "b"]);
turnAboutFrame(90);
const pickedNode = containerOf(app.state.objects[0]);
assert.ok(pickedNode && Math.abs(drawing.placement.angleOf(pickedNode.m) - Math.PI / 2) < 1e-9,
  "the two must really have been turned as one group, or there is no container turn for the box below to carry");
// The selection is set straight on the state here rather than through the canvas, because this is the
// state a box has to answer for while a selection is being changed: a member of a temporary container
// is drawn through it until the moment the container is folded away, and the box drawn around that
// member in between has to be the member's own box at the angle it is really drawn at.
["a", "b"].forEach((id) => {
  app.state.selectedIds = [id]; app.state.selectedId = id; canvas.render();
  const object = app.state.objects.find((entry) => entry.id === id);
  const frame = canvas.selectionFrame(), map = drawing.placedMap(object);
  assert.ok(Math.abs(frame.angle - drawing.placement.angleOf(map)) < 1e-9,
    "taken on its own, a member must be boxed at the angle it is drawn at - its own angle with the container's on top - or the box sits at half the turn while the picture sits at the whole of it");
  assert.ok(Math.abs(frame.width - object.width * drawing.placement.axesOf(map)[0]) < 1e-9 &&
    Math.abs(frame.height - object.height * drawing.placement.axesOf(map)[1]) < 1e-9,
    "and the box must be the picture's own box, not a wider box measured around the leaned one");
  // Every corner of the box is the matching corner of the shape: the record's own box carried by the
  // two placements, which is the order the canvas paints them in.
  const drawnCornersOfMember = drawing.placement.corners(map, drawing.localBounds(object));
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach((corner, index) => {
    const drawn = drawnCornersOfMember[index];
    const local = turnPoint(frame.angle, corner[0] * frame.width / 2, corner[1] * frame.height / 2);
    assert.ok(Math.abs(frame.x + local.x - drawn.x) < 1e-9 && Math.abs(frame.y + local.y - drawn.y) < 1e-9,
      "corner " + corner.join(",") + " of the box must be that corner of what is drawn, at whatever angle the member carries");
  });
  assert.ok(Math.abs(handle("nw").x - (frame.x + turnPoint(frame.angle, -frame.width / 2, -frame.height / 2).x)) < 1e-9,
    "and the handles must ride those corners, or the box would be right and the targets on it would not");
});
assert.equal(containerCount(), 1, "and asking for the box must not have taken the container away: that is the selection's business, not the box's");

// 15. A corner pull is two axes for every selection, whatever angles its members are drawn at. It was
//     always that, and it is not this gesture's business to withdraw it: a selection whose members are
//     drawn at angles that are not the same is still asked to be wider, or taller, or both, and the
//     two numbers the finger asked for are the answer. What such a selection cannot have is a member
//     stretched along axes that are not its own *and* still a rectangle, so each member takes the pull
//     in its own axes and is fitted as tightly as a rectangle can be - and a member that has no
//     rectangle at all, a polyline, is moved point by point, which is exact. That exactness is what is
//     asserted here: not "it grew by one factor", which is a promise about the refusal and says nothing
//     about the corner, but where the ink lands.
function pullCorner(dx, dy) {
  const frame = canvas.selectionFrame(), pin = handle("nw"), grabbed = handle("se");
  const offset = turnPoint(frame.angle, dx, dy);
  const finger = { x: grabbed.x + offset.x, y: grabbed.y + offset.y };
  fire("down", grabbed.x, grabbed.y);
  fire("move", finger.x, finger.y);
  fire("up", finger.x, finger.y);
  return pin;
}
function sides() {
  return app.state.objects.map((object) => ({ width: object.width, height: object.height || 0, rotation: object.rotation || 0 }));
}
function sameSides(before, label) {
  sides().forEach((side, index) => {
    assert.ok(Math.abs(side.width - before[index].width) < 1e-9 && Math.abs(side.height - before[index].height) < 1e-9 && Math.abs(side.rotation - before[index].rotation) < 1e-12,
      label + ": member " + index + " must come back the size and the angle it was, to the last bit");
  });
}

// Two strokes carried corner to corner, which is what makes the two ways of measuring a box tell each
// other apart: the ink is a diagonal of the record's box, so a box around the turned records is wider
// than a box around the turned ink by most of the box, and the assertion below cannot pass on both.
function twoDiagonalStrokes() {
  scene([pencil({ id: "a", points: [{ x: 120, y: 120 }, { x: 320, y: 320 }] })], ["a"]);
  turnBy(35);
  scene(app.state.objects.concat([pencil({ id: "b", points: [{ x: 140, y: 360 }, { x: 300, y: 480 }] })]), ["b"]);
  turnBy(-22);
  return scene(app.state.objects, ["a", "b"]);
}
function inkOf(objects) { return objects.map((object) => object.points.map((point) => drawnOf(object, point))); }

twoDiagonalStrokes();
const strokeBoxFrame = canvas.selectionFrame();
assert.equal(strokeBoxFrame.angle, 0, "two members drawn at angles that are not the same are boxed upright, since there is no rectangle they have in common");
assertHugsInk(app.state.objects, strokeBoxFrame, "the box around two strokes at different angles");
// And the older measurement really is a different box, or the assertion above would say nothing about
// which of the two the canvas is drawing.
const recordHull = hullOf(app.state.objects.reduce((all, object) => all.concat(drawnCorners(object)), []));
const inkHull = hullOf(app.state.objects.reduce((all, object) => all.concat(inkPoints(object)), []));
assert.ok(recordHull.right - recordHull.left - (inkHull.right - inkHull.left) > 1 || recordHull.bottom - recordHull.top - (inkHull.bottom - inkHull.top) > 1,
  "the box around the records must really be the larger one here, or measuring the ink instead would be a distinction without a difference");

const restingStrokes = sides(), restingInk = inkOf(app.state.objects), restingSteps = app.state.history.length;
// The corner taken hold of and pulled nowhere is not a resize: a build that read the pull in one place
// and added one to it would grow the selection on the touch alone, before the hand had moved, and write
// a step of the journal for a gesture that never happened.
pullCorner(0, 0);
sameSides(restingStrokes, "a corner pulled nowhere");
assert.equal(app.state.history.length, restingSteps, "and a pull that asked for no change must not be a step of the journal");
const pulledInk = inkOf(app.state.objects);
assertPulledInk(strokeBoxFrame, handle("nw"), restingInk.reduce((all, points) => all.concat(points), []), pulledInk.reduce((all, points) => all.concat(points), []), 1, 1,
  "a corner pulled nowhere");

// The pull that is not along the diagonal is the one the two axes disagree about, so it is the one that
// tells a two-axis pull from one factor shared by both: 60% of the box's width, straight out along the
// box's own top edge. Every point of both strokes must land where that stretch puts it, and it must be
// the same one stretch for the whole selection - which is what the container is for. A brush is a length
// with no axis to lean along only while nothing is stretched unevenly, so the brush is left out of what
// is measured here and the points themselves are what is held to the pixel.
const flatFrame = canvas.selectionFrame(), flatPin = handle("nw");
const flatRecords = app.state.objects.map((object) => JSON.stringify(object.points));
assert.equal(containerCount(), 1, "the container was made when the corner was taken hold of, and it is the thing a pull on two members is written on");
pullCorner(0.6 * flatFrame.width, 0);
const flatAfter = canvas.selectionFrame();
assert.equal(containerCount(), 1, "and pulling it makes no second one: the stretch goes onto the container that is already there");
app.state.objects.forEach((object, index) => {
  assert.equal(JSON.stringify(object.points), flatRecords[index], "member " + index + "'s own points must be left exactly as they were");
});
assert.equal(flatAfter.angle, 0, "the box is still upright, since the container was made upright");
assert.ok(Math.abs(flatAfter.width - flatFrame.width * 1.6) < 1e-9 && Math.abs(flatAfter.height - flatFrame.height) < 1e-9,
  "and it has taken exactly the pull the finger asked for - 60% wider along the box's own width, and its height untouched - which is a promise no member-by-member scaling can keep");
inkOf(app.state.objects).forEach((points, index) => {
  assertPulledInk(flatFrame, flatPin, restingInk[index], points, 1.6, 1, "a flat pull on two strokes at different angles, stroke " + index);
});
assert.ok(Math.abs(inkOf(app.state.objects)[0][0].x - restingInk[0][0].x) > 1, "which must be a change, or the assertions above would pass on a pull that did nothing at all");
assert.equal(app.state.history.length, restingSteps + 1, "and the pull must be a step of the journal");

// Both axes at once, which is what four corners are for: the pull is read as one number per axis and
// both must arrive, with the side the finger asked about stretched and the other one stretched too.
twoDiagonalStrokes();
const crossFrame = canvas.selectionFrame(), crossPin = handle("nw"), crossInk = inkOf(app.state.objects);
pullCorner(0.6 * crossFrame.width, 0.4 * crossFrame.height);
inkOf(app.state.objects).forEach((points, index) => {
  assertPulledInk(crossFrame, crossPin, crossInk[index], points, 1.6, 1.4, "a two-axis pull on two strokes at different angles, stroke " + index);
});

// The same gesture on two members drawn at one angle is the two-axis pull it has always been: the
// width takes the whole of the pull along its own axis and the height does not move, because these
// members really do have the box's axes between them.
scene([
  picture({ id: "a", x: 200, y: 260, width: 200, height: 140 }),
  picture({ id: "b", x: 520, y: 300, width: 120, height: 180 })
], ["a", "b"]);
turnAboutFrame(90);
const sharedDrawn = app.state.objects.map(drawnSize);
const sharedFrame = canvas.selectionFrame();
pullCorner(0.6 * sharedFrame.width, 0);
app.state.objects.forEach((object, index) => {
  const now = drawnSize(object);
  assert.ok(Math.abs(now.width - sharedDrawn[index].width * 1.6) < 1e-9 && Math.abs(now.height - sharedDrawn[index].height) < 1e-9,
    "member " + index + " of two drawn at one angle must be drawn 1.6 times as wide along the box's own axis and no taller at all - which is what a box of four corners is for - and its record is not where that is written");
});

// 16. The box rides the finger while the finger is down. What the box is drawn as is the box the drag
//     took hold of, spun about its own centre by the turn the finger has made so far - and that is a
//     promise about the box, not about the drawing: the tight box around a turned selection is not the
//     turn of the tight box around it once the members are drawn at angles that are not the same, so a
//     box re-fitted on every move would grow and shrink and slide about while the circle - which the
//     finger is holding - went with it. And the box keeps the angle it was already drawn at, because
//     the finger took hold of a corner of the box it could see.
function turnMidway(degrees) {
  const frame = canvas.selectionFrame(), grip = handle("rotate");
  assert.ok(grip, "a selection must offer the turn circle");
  const centre = { x: frame.x, y: frame.y };
  const radius = Math.hypot(grip.x - centre.x, grip.y - centre.y);
  const start = Math.atan2(grip.y - centre.y, grip.x - centre.x);
  const ahead = degrees * Math.PI / 180;
  const target = { x: centre.x + Math.cos(start + ahead) * radius, y: centre.y + Math.sin(start + ahead) * radius };
  const corners = ["nw", "ne", "sw", "se"].map((key) => ({ key: key, x: handle(key).x, y: handle(key).y }));
  fire("down", grip.x, grip.y);
  fire("move", target.x, target.y);
  return { frame: frame, centre: centre, ahead: ahead, target: target, corners: corners };
}
function heldByHand(mid, label) {
  const held = canvas.selectionFrame();
  assert.ok(Math.abs(held.width - mid.frame.width) < 1e-9 && Math.abs(held.height - mid.frame.height) < 1e-9,
    label + ": the box must be the same size all through the turn, since a turn is rigid and the box is the one the finger took hold of - a box re-fitted around the drawing would change size as the drawing turned");
  assert.ok(Math.abs(held.x - mid.centre.x) < 1e-9 && Math.abs(held.y - mid.centre.y) < 1e-9,
    label + ": and must stay centred on the centre the turn is being given about, so its corners do not drift away from the hand");
  assert.ok(Math.abs(held.angle - (mid.frame.angle + mid.ahead)) < 1e-9,
    label + ": and must be the box the finger took hold of, spun by the turn made so far on top of the angle it was already drawn at");
  mid.corners.forEach((corner) => {
    const now = handle(corner.key), carried = turnAbout(corner, mid.centre, mid.ahead);
    assert.ok(Math.abs(now.x - carried.x) < 1e-9 && Math.abs(now.y - carried.y) < 1e-9,
      label + ": the " + corner.key + " corner must be the corner taken hold of, carried round by the turn made so far");
  });
  const grip = handle("rotate");
  assert.ok(Math.abs(grip.x - mid.target.x) < 1e-9 && Math.abs(grip.y - mid.target.y) < 1e-9,
    label + ": and the circle must still be under the finger, which is the whole reason the box is not re-fitted");
  fire("up", mid.target.x, mid.target.y);
}
// Two members drawn at angles that are not the same, turned: a box that re-fitted itself on every
// move would be seen changing size and sliding while the finger held its circle, which is the whole
// thing the finger-down box exists to prevent.
scene([
  picture({ id: "a", x: 200, y: 260, width: 200, height: 140, rotation: Math.PI / 6 }),
  picture({ id: "b", x: 520, y: 300, width: 120, height: 180, rotation: -Math.PI / 9 })
], ["a", "b"]);
turnAboutFrame(90);
assert.ok(Math.abs(canvas.selectionFrame().angle - Math.PI / 2) < 1e-9, "after a quarter turn the box is the container's rectangle, turned by the quarter the selection was turned through");
heldByHand(turnMidway(20), "members drawn at different angles");
assert.ok(Math.abs(canvas.selectionFrame().angle - (Math.PI / 2 + 20 * Math.PI / 180)) < 1e-9,
  "and once the finger is up the box is the container's rectangle again, at the angle the turn left it at, since what is selected has not changed - only how it is turned has");
// Then members drawn at one angle, whose box is already turned: a box that turned from upright would
// be right about the drawing and wrong about the hand, which is holding a corner of the box it saw.
scene([picture({ id: "a", x: 100, y: 120, width: 200, height: 160 }), picture({ id: "b", x: 380, y: 300, width: 120, height: 120 })], ["a", "b"]);
turnBy(90);
assert.ok(Math.abs(canvas.selectionFrame().angle - Math.PI / 2) < 1e-9, "a quarter turn of two members at one angle must leave a box turned by that quarter, or there is no angle for the drag below to keep");
heldByHand(turnMidway(20), "members drawn at one angle");

// 17. A turn that is not a quarter is where a box that re-fitted itself would part company with the
//     box the hand is holding. At a right angle the two agree - the upright bounds of a rectangle
//     turned by a quarter are the quarter turn of its own bounds, which is exactly why a quarter turn
//     hides the difference - and at any other angle a rectangle re-measured to face the canvas hangs
//     out past what is drawn, or crowds it, on both axes. The box here is the container's own
//     rectangle, so it is the box the user took hold of at whatever angle they turned it to, and what
//     is asserted is that every corner of what is drawn still lies on it. Members at different angles,
//     because that is when the drawn bounds of a member are not the member either.
scene([
  picture({ id: "a", x: 200, y: 260, width: 200, height: 140, rotation: Math.PI / 6 }),
  picture({ id: "b", x: 520, y: 300, width: 120, height: 180, rotation: -Math.PI / 9 })
], ["a", "b"]);
turnAboutFrame(37);
assert.ok(Math.abs(canvas.selectionFrame().angle - 37 * Math.PI / 180) < 1e-9,
  "turned by an angle that is not a quarter, the box is at that angle: it is the rectangle the user was holding, and a turn of the hand turns it");
assertFramedBy(app.state.objects, canvas.selectionFrame(), "the box around two members at different angles, turned by an angle that is not a quarter");

// 18. A selection's handles must not take touches that belong to another object. The circle is the
//     widest target on the box and it sits off the box, so its reach covers a band a finger wide the
//     whole way round - and handles are answered before the touch is, so a touch inside that band was
//     spent on the circle and the object under the finger was never reached. On a phone, where the only
//     way to take up two objects is to drag from one across both, that is the second object being
//     unpickable: nothing on screen explains it, because the target that refuses it is invisible. The
//     band must therefore belong to the drawing - any object at all, this selection or not - and the
//     circle must pay for that only where it is standing on nothing.
const upperPicture = picture({ id: "up", x: 200, y: 120, width: 240, height: 180 });
const lowerPicture = picture({ id: "low", x: 240, y: 290, width: 240, height: 180 });
function twoPictures(selected) { return scene([upperPicture, lowerPicture], selected || ["up"]); }
function tapAt(x, y) { fire("down", x, y); fire("up", x, y); }
twoPictures();
const upperFrame = canvas.selectionFrame(), upperGrip = handle("rotate");
const lowerCentre = { x: lowerPicture.x + lowerPicture.width / 2, y: lowerPicture.y + lowerPicture.height / 2 };
const reachToLower = Math.hypot(upperGrip.x - lowerCentre.x, upperGrip.y - lowerCentre.y);
assert.ok(reachToLower <= upperGrip.reach,
  "the second picture must really sit inside the circle's reach - " + reachToLower.toFixed(1) + " of " + upperGrip.reach + " - or the band would never be asked for this touch and the guard below would be untested");
assert.ok(reachToLower > upperGrip.radius,
  "and off the circle's own ink, which is what the guard gives away: a touch on the drawn circle belongs to the circle, so a case inside the ink would not be testing the band either");
assert.ok(Math.abs(lowerCentre.x - upperFrame.x) > upperFrame.width / 2 || Math.abs(lowerCentre.y - upperFrame.y) > upperFrame.height / 2,
  "and it must lie outside the box, or the older refusal of the box's own sliver would already have covered this one and nothing about the band would be being tested");
tapAt(lowerCentre.x, lowerCentre.y);
assert.equal(app.state.selectedIds.join(","), "low", "so the touch must select the picture under the finger rather than turn the one above it");
assert.equal(app.state.objects[0].rotation, undefined, "with the picture above left exactly where it was, since a turn nobody asked for is the worst of the two refusals");
// The same touch held and dragged is how two objects are taken up at once: from an object that is not
// yet in the selection, across them both. That path is the image-under-the-drag one, and it is the one
// the band was silently eating.
twoPictures();
fire("down", lowerCentre.x, lowerCentre.y);
fire("move", lowerCentre.x - 30, lowerCentre.y - 30);
fire("move", 20, 20);
fire("up", 20, 20);
assert.equal(app.state.selectedIds.join(","), "up,low", "and a drag from one object across both must still take up both, which is the only way a phone can select two things at once");
assert.equal(app.state.objects[0].rotation, undefined, "with neither of them turned by the gesture that selected them");
// And the circle must still answer where it is standing on nothing, or the guard would have answered
// one refusal with another.
twoPictures();
const freeGrip = handle("rotate");
fire("down", freeGrip.x, freeGrip.y);
fire("move", freeGrip.x + 60, freeGrip.y);
fire("up", freeGrip.x + 60, freeGrip.y);
assert.ok(app.state.objects[0].rotation !== undefined, "a touch on the circle with nothing under it must still turn the selection, or the band has been taken from the circle rather than given back to the drawing");

// And a member that has a rectangle of its own - a picture - is fitted in its own axes rather than
// stretched along them: the pull is read where the member is stored, so the rectangle written down is
// the tight one around the pull's image of the old one. The width the finger asked for then arrives
// exactly, which is the whole of what the corner promises, and the centre lands exactly on the pull's
// image of the old centre, which is what keeps the arrangement between the members. The axis the
// finger did not ask about takes some slack - a rectangle turned away from the pull cannot hold the
// pull's image of itself without growing on that side too - and that slack is the price of the record
// still being a rectangle. Reading the stored sides by the pull's own factors instead gives a width
// that does not follow the finger at all, which is what a corner that has stopped answering looks like.
function mixedPictures() {
  return scene([
    picture({ id: "a", x: 200, y: 260, width: 200, height: 140, rotation: Math.PI / 6 }),
    picture({ id: "b", x: 520, y: 300, width: 120, height: 180, rotation: -Math.PI / 9 })
  ], ["a", "b"]);
}
mixedPictures();
const pictureFrame = canvas.selectionFrame(), picturePin = handle("nw");
const pictureCentres = app.state.objects.map((object) => { const box = drawing.bounds(object); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; });
const pictureAngles = app.state.objects.map((object) => drawing.rotationOf(object));
pullCorner(0.6 * pictureFrame.width, 0);
const widenedFrame = canvas.selectionFrame();
assert.ok(Math.abs(widenedFrame.width / pictureFrame.width - 1.6) < 1e-9,
  "the box must grow by exactly the factor the finger asked for along the axis it asked about, or the corner has stopped answering");
assert.equal(widenedFrame.angle, 0, "and stay upright, since the members are still drawn at angles that are not the same");
app.state.objects.forEach((object, index) => {
  const box = drawing.bounds(object), centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const want = { x: picturePin.x + (pictureCentres[index].x - picturePin.x) * 1.6, y: pictureCentres[index].y };
  assert.ok(Math.abs(centre.x - want.x) < 1e-9 && Math.abs(centre.y - want.y) < 1e-9,
    "member " + index + " must be drawn exactly where the pull puts it, which is what keeps the arrangement between the members untwisted even though a rectangle cannot hold a stretch exactly");
  assert.ok(Math.abs(drawing.rotationOf(object) - pictureAngles[index]) < 1e-12, "and keep the angle it was drawn at");
});
assert.ok(widenedFrame.height < pictureFrame.height * 1.4,
  "while the axis the finger did not ask about may take some slack, it must stay far short of the pull's own factor - this is where a member stretched along its own axes instead of the box's shows up");

// The box's own edge is the other place the circle must not answer. A stroke does not fill the box
// around it - a diagonal fills two corners and leaves the rest - and the circle hangs 56 below the
// bottom edge with a reach of 60, so the bottom edge sits inside the circle's aim. A touch there
// belongs to the selection: it is inside the box, so it drags, and a build that let the circle answer
// would turn the stroke instead of moving it at the one place on the box a hand naturally lands.
const diagonalStroke = pencil({ id: "d", points: [{ x: 200, y: 100 }, { x: 400, y: 300 }] });
scene([diagonalStroke], ["d"]);
const loneFrame = canvas.selectionFrame();
const boxEdge = { x: loneFrame.x, y: loneFrame.y + loneFrame.height / 2 };
const edgeGrip = handle("rotate");
assert.ok(Math.hypot(edgeGrip.x - boxEdge.x, edgeGrip.y - boxEdge.y) <= edgeGrip.reach,
  "the circle's aim must really cover the box's bottom edge, or this reading is about some other place on the canvas");
const inkBefore = diagonalStroke.points.map((point) => ({ x: point.x, y: point.y }));
fire("down", boxEdge.x, boxEdge.y);
fire("move", boxEdge.x + 40, boxEdge.y);
fire("up", boxEdge.x + 40, boxEdge.y);
assert.equal(app.state.objects[0].rotation, undefined, "so a touch on the box's own bottom edge must drag the object rather than start a turn, however close the circle has come");
assert.ok(Math.abs(app.state.objects[0].points[0].x - (inkBefore[0].x + 40)) < 1e-6 && Math.abs(app.state.objects[0].points[0].y - inkBefore[0].y) < 1e-6,
  "and the object must really have moved by the drag, or the refusal above would read the same on a gesture that did nothing");

// 19. A container that exists only because several things are selected goes away the moment the
//     selection is not theirs - the finger lifted onto empty canvas, or onto something else - and
//     taking it away moves nothing: what it was drawn through is folded into each member, so each
//     member keeps exactly the picture it was being shown. That is the whole of what a temporary
//     container is, and it is why a selection can be turned and stretched without one number of the
//     objects in it being rewritten: what the user is holding is a container, and when they let go of
//     it the members keep what they were shown. The fold is not an action, so it is not a step of the
//     journal either - nothing on screen changed.
scene([
  picture({ id: "a", x: 120, y: 140, width: 180, height: 130, rotation: Math.PI / 7 }),
  picture({ id: "b", x: 330, y: 300, width: 140, height: 170 })
], ["a", "b"]);
const memberOwnBefore = app.state.objects.map((object) => JSON.stringify([object.rotation, object.linear, object.rotationPivot]));
turnAboutFrame(90);
const foldFrame = canvas.selectionFrame();
pullCorner(0.5 * foldFrame.width, -0.3 * foldFrame.height);
const foldBefore = app.state.objects.map((object) => ({ box: drawing.bounds(object), ink: inkPoints(object), placed: drawing.placedMap(object) }));
const foldSteps = app.state.history.length;
assert.equal(containerCount(), 1, "the selection must really be in a container, or there is nothing for the selection change below to take away");
assert.equal(app.state.objects.map((object) => JSON.stringify([object.rotation, object.linear, object.rotationPivot])).join("|"), memberOwnBefore.join("|"),
  "the turn and the pull must be written on the container and on nothing else: not one placement of a member is touched by either");
tapAt(730, 730);
assert.equal(containerCount(), 0, "letting go onto empty canvas must take the temporary container away");
assert.equal(app.state.objects.filter((object) => object.groupId).length, 0, "and leave behind no member naming it");
foldBefore.forEach((before, index) => {
  const map = drawing.levelMap(app.state.objects[index]);
  assert.ok(Math.abs(map[0] - before.placed[0]) < 1e-9 && Math.abs(map[1] - before.placed[1]) < 1e-9 && Math.abs(map[2] - before.placed[2]) < 1e-9 &&
    Math.abs(map[3] - before.placed[3]) < 1e-9 && Math.abs(map[4] - before.placed[4]) < 1e-9 && Math.abs(map[5] - before.placed[5]) < 1e-9,
    "member " + index + "'s own placement must now be exactly what it was drawn through, which is the whole of what dissolving a container is");
  const box = drawing.bounds(app.state.objects[index]);
  assert.ok(Math.abs(box.x - before.box.x) < 1e-9 && Math.abs(box.y - before.box.y) < 1e-9 &&
    Math.abs(box.width - before.box.width) < 1e-9 && Math.abs(box.height - before.box.height) < 1e-9,
    "and it must be drawn exactly where it was: folding a container into its members is not a move, and not a resize either");
  inkPoints(app.state.objects[index]).forEach((point, which) => {
    assert.ok(Math.abs(point.x - before.ink[which].x) < 1e-9 && Math.abs(point.y - before.ink[which].y) < 1e-9,
      "down to the corner: point " + which + " of member " + index + " must be the point it was, to the last bit");
  });
});
assert.equal(app.state.history.length, foldSteps, "and letting go must not be a step of the journal: nothing on screen changed");
// The same again, but the selection moves onto something else rather than onto nothing. A container is
// not a group: picking up one of its members picks up that member, which is also what takes the
// container away.
scene([
  picture({ id: "a", x: 120, y: 140, width: 180, height: 130 }),
  picture({ id: "b", x: 330, y: 300, width: 140, height: 170 }),
  picture({ id: "c", x: 600, y: 480, width: 100, height: 100 })
], ["a", "b"]);
turnAboutFrame(90);
const aloneBefore = drawing.bounds(app.state.objects[0]);
assert.equal(canvas.selectionFrame().angle, Math.PI / 2, "the two must really have been turned, or there is nothing below for the selection change to fold away");
const aCentre = drawing.bounds(app.state.objects[0]);
tapAt(aCentre.x + aCentre.width / 2, aCentre.y + aCentre.height / 2);
assert.equal(containerCount(), 0, "picking up one member must take the container away, since it was not a group");
assert.equal(app.state.selectedIds.length, 1, "and must leave that one member selected rather than the two that were in the container");
const aloneAfter = drawing.bounds(app.state.objects[0]);
assert.ok(Math.abs(aloneAfter.x - aloneBefore.x) < 1e-9 && Math.abs(aloneAfter.y - aloneBefore.y) < 1e-9 &&
  Math.abs(aloneAfter.width - aloneBefore.width) < 1e-9 && Math.abs(aloneAfter.height - aloneBefore.height) < 1e-9,
  "and it must be drawn exactly where it was: a member left alone is not thrown back to where it was drawn before the container was made");

// 20. 成组 turns the container the selection is already in into a real one: the same container, with the
//     rectangle and the angle it already has, and it stops being taken away when the selection
//     changes. Transforming a group is then transforming the group object itself - its rectangle is
//     what the handles ride and its placement is what the pull writes to - and not one number of the
//     members inside it moves. 解散组 is the other half: the group object is deleted and folded into
//     its members, so the group is gone, its angle and its size with it, and the picture has not moved
//     by a pixel.
scene([
  picture({ id: "a", x: 120, y: 140, width: 180, height: 130, rotation: Math.PI / 7 }),
  picture({ id: "b", x: 330, y: 300, width: 140, height: 170 })
], ["a", "b"]);
turnAboutFrame(90);
const beforeGroup = containerOf(app.state.objects[0]);
const groupRect = { x: beforeGroup.rect.x, y: beforeGroup.rect.y, width: beforeGroup.rect.width, height: beforeGroup.rect.height };
const groupMap = beforeGroup.m.slice();
const groupBox = canvas.selectionFrame();
assert.equal(beforeGroup.formal, false, "a container made by selecting and transforming is a temporary one until the user groups it");
canvas.groupSelected();
const grouped = containerOf(app.state.objects[0]);
assert.equal(grouped.formal, true, "成组 must make the container a real one");
assert.deepEqual({ x: grouped.rect.x, y: grouped.rect.y, width: grouped.rect.width, height: grouped.rect.height }, groupRect,
  "and must not re-measure it: the group keeps the rectangle it was holding, which is the box the user was looking at");
assert.deepEqual(grouped.m.map(round), groupMap.map(round), "nor re-aim it: the angle it was turned to is the angle it keeps, since a group that straightened itself up on being made would be a group that moved");
assert.equal(containerCount(), 1, "and grouping must not make a second container");
const groupRecord = app.state.objects.map((object) => JSON.stringify([object.x, object.y, object.width, object.height, object.rotation, object.linear]));
const groupMemberBox = drawing.bounds(app.state.objects[0]);
tapAt(730, 730);
assert.equal(containerCount(), 1, "a group must survive the selection being dropped, which is the whole difference between a group and a selection");
assert.equal(app.state.objects.filter((object) => object.groupId).length, 2, "with its members still naming it");
assert.equal(canvas.selectionFrame(), null, "and with nothing selected there is no box at all");
tapAt(groupMemberBox.x + groupMemberBox.width / 2, groupMemberBox.y + groupMemberBox.height / 2);
assert.equal(app.state.selectedIds.length, 2, "picking up one member of a group must pick up the whole group");
const recalled = canvas.selectionFrame();
assert.ok(Math.abs(recalled.angle - groupBox.angle) < 1e-9 && Math.abs(recalled.width - groupBox.width) < 1e-9 && Math.abs(recalled.height - groupBox.height) < 1e-9,
  "and the box it comes back with must be the box it was put away with - its own rectangle at its own angle - rather than one re-made to face the canvas");
pullCorner(0.4 * recalled.width, -0.2 * recalled.height);
assert.equal(app.state.objects.map((object) => JSON.stringify([object.x, object.y, object.width, object.height, object.rotation, object.linear])).join("|"), groupRecord.join("|"),
  "transforming a group must not touch one number of the members inside it: the group is the thing being transformed, and the things in it are not");
const pulledGroupFrame = canvas.selectionFrame();
assert.ok(Math.abs(pulledGroupFrame.width - recalled.width * 1.4) < 1e-9 && Math.abs(pulledGroupFrame.height - recalled.height * 0.8) < 1e-9,
  "while the group's own rectangle must take the pull on both axes - and an uneven pull at that, which is a thing no rectangle of one member could hold");
// 解散组: the group object goes, its placement goes with it, and the members take it onto themselves.
const ungroupBox = canvas.selectionFrame(), ungroupInk = app.state.objects.map(inkPoints);
const ungroupRecords = app.state.objects.map((object) => JSON.stringify([object.x, object.y, object.width, object.height]));
canvas.ungroupSelected();
assert.equal(containerCount(), 0, "解散组 must leave the group itself gone, not merely straightened out");
assert.equal(app.state.objects.filter((object) => object.groupId).length, 0, "with nothing left naming it");
app.state.objects.forEach((object, index) => {
  assert.equal(JSON.stringify([object.x, object.y, object.width, object.height]), ungroupRecords[index],
    "member " + index + "'s geometry must not be rewritten by the dissolving: what it is drawn as is carried by its placement");
  inkPoints(object).forEach((point, which) => {
    assert.ok(Math.abs(point.x - ungroupInk[index][which].x) < 1e-9 && Math.abs(point.y - ungroupInk[index][which].y) < 1e-9,
      "and member " + index + " must be drawn exactly where it was - corner " + which + " included - so the picture does not move by a pixel");
  });
});
assert.equal(app.state.selectedIds.length, 2, "and the members must stay selected, so the user can carry on with what they were holding");

// 21. A copy of a group is a group. The container is copied with its members, under a new name, so the
//     copy is drawn at the angle and the size of the thing it was copied from instead of being a set of
//     members naming a container that does not exist.
scene([
  picture({ id: "a", x: 120, y: 140, width: 180, height: 130 }),
  picture({ id: "b", x: 330, y: 300, width: 140, height: 170 })
], ["a", "b"]);
turnAboutFrame(90);
canvas.groupSelected();
const originFrame = canvas.selectionFrame(), originRect = containerOf(app.state.objects[0]).rect;
canvas.duplicateSelected();
assert.equal(containerCount(), 2, "the copy must bring a container of its own, or its members would name one that is not there");
const copyFrame = canvas.selectionFrame();
assert.ok(Math.abs(copyFrame.angle - originFrame.angle) < 1e-9 && Math.abs(copyFrame.width - originFrame.width) < 1e-9 && Math.abs(copyFrame.height - originFrame.height) < 1e-9,
  "and the copy must be drawn at the angle and the size of the thing it was copied from");
assert.equal(app.state.objects.filter((object) => object.groupId === app.state.objects[2].groupId).length, 2, "with both of its members in it");
assert.ok(Math.abs(containerOf(app.state.objects[2]).rect.width - originRect.width) < 1e-9, "and the same rectangle, copied rather than shared");
assert.equal(app.state.objects[0].groupId === app.state.objects[2].groupId, false, "the two containers must have names of their own, or moving the copy would move the original");
assert.equal(app.state.objects[0].groupId, app.state.objects[1].groupId, "and the original must still be the original");

// 22. A group that has been transformed can still be carried, and carrying it carries the group. The
//     displacement goes onto the container's placement, on the *outside* - where a point of the
//     drawing lands where the finger put it whatever angle the container has been turned to - and not
//     one number of the members inside moves. Writing the members' own geometry instead is what the
//     owner saw: the boxes did not move at all and the objects wandered off inside them, because the
//     drawn picture is the record *through* the container's placement, so moving the record moves the
//     picture by the container's idea of that direction. A group turned a quarter is where that shows
//     up worst - a finger going straight down would carry it sideways - so that is the case measured,
//     and the ink is measured rather than the records, because it is what the hand sees.
scene([
  picture({ id: "a", x: 120, y: 140, width: 180, height: 130, rotation: Math.PI / 7 }),
  picture({ id: "b", x: 330, y: 300, width: 140, height: 170 })
], ["a", "b"]);
turnAboutFrame(90);
canvas.groupSelected();
const moveBefore = app.state.objects.map(memberNumbers);
const moveFrame = canvas.selectionFrame(), moveNode = containerOf(app.state.objects[0]);
const moveRect = { x: moveNode.rect.x, y: moveNode.rect.y, width: moveNode.rect.width, height: moveNode.rect.height };
const moveWays = moveNode.m.slice(), moveInk = app.state.objects.map(inkPoints), moveSteps = app.state.history.length;
assert.equal(moveNode.formal, true, "the group must really be a group, or this is a reading about a plain selection");
dragBox(40, 70);
const movedFrame = canvas.selectionFrame(), movedNode = containerOf(app.state.objects[0]);
assert.equal(movedNode.formal, true, "a group must still be a group after being carried");
assert.equal(containerCount(), 1, "and must still be one container");
assert.equal(app.state.history.length, moveSteps + 1, "carrying a group is one step of the journal");
assert.ok(Math.abs(movedFrame.x - (moveFrame.x + 40)) < 1e-9 && Math.abs(movedFrame.y - (moveFrame.y + 70)) < 1e-9,
  "the box must go with the group - it went " + round(movedFrame.x - moveFrame.x) + "," + round(movedFrame.y - moveFrame.y) + " for a finger that asked for 40,70, which is the box being left behind at the place the drag began");
assert.ok(Math.abs(movedFrame.width - moveFrame.width) < 1e-9 && Math.abs(movedFrame.height - moveFrame.height) < 1e-9 && Math.abs(movedFrame.angle - moveFrame.angle) < 1e-9,
  "with its size and its angle untouched: carrying is not a turn and not a pull");
app.state.objects.forEach((object, index) => {
  inkPoints(object).forEach((point, which) => {
    assert.ok(Math.abs(point.x - (moveInk[index][which].x + 40)) < 1e-9 && Math.abs(point.y - (moveInk[index][which].y + 70)) < 1e-9,
      "member " + index + " must be drawn exactly 40,70 from where it was, corner " + which + " included - which is what the finger asked for and what a record moved under a container's placement does not give");
  });
});
assertMembersUnchanged(app.state.objects, moveBefore, "and not one number of either member may move: the group is the thing being carried");
assert.deepEqual({ x: movedNode.rect.x, y: movedNode.rect.y, width: movedNode.rect.width, height: movedNode.rect.height }, moveRect,
  "nor may the container's rectangle be rewritten, since it is written in the container's own frame and the finger is not");
assert.ok(Math.abs(movedNode.m[0] - moveWays[0]) < 1e-9 && Math.abs(movedNode.m[3] - moveWays[3]) < 1e-9,
  "and the container must not have been turned or stretched on the way: only the two numbers that are where it is");
assertFramedBy(app.state.objects, movedFrame, "the box around a group that has been carried");
// Once is not enough: a drag written against the placement the drag began with cannot accumulate, so
// two drags in a row land exactly where their sum says and a third that undoes them lands back.
dragBox(-15, -25);
const secondFrame = canvas.selectionFrame();
assert.ok(Math.abs(secondFrame.x - (moveFrame.x + 25)) < 1e-9 && Math.abs(secondFrame.y - (moveFrame.y + 45)) < 1e-9,
  "two drags in a row must land at their sum: a move folded onto the last one instead of onto the one it began with would drift");
dragBox(-25, -45);
const backFrame = canvas.selectionFrame();
assert.ok(Math.abs(backFrame.x - moveFrame.x) < 1e-9 && Math.abs(backFrame.y - moveFrame.y) < 1e-9 && Math.abs(backFrame.width - moveFrame.width) < 1e-9,
  "and carrying a group back by exactly what it was carried costs nothing, the way turning it back by exactly what it was turned does");
assertMembersUnchanged(app.state.objects, moveBefore, "which is also true of every number of the members, after three drags rather than one");
// A drag that starts on a member of the group is the other way in - the one a phone has, since the
// finger naturally lands on the thing rather than on the space between the things - and it must take
// the whole group and move it the same way.
const memberBox = drawing.bounds(app.state.objects[1]);
const memberInk = inkPoints(app.state.objects[1]), pickBefore = app.state.objects.map(memberNumbers);
dragFrom({ x: memberBox.x + memberBox.width / 2, y: memberBox.y + memberBox.height / 2 }, -30, 18);
assert.equal(app.state.selectedIds.length, 2, "a drag from a member of a group must take the whole group");
assert.ok(Math.abs(canvas.selectionFrame().x - (backFrame.x - 30)) < 1e-9 && Math.abs(canvas.selectionFrame().y - (backFrame.y + 18)) < 1e-9,
  "and must carry it by the finger's own numbers, exactly as a drag from the empty middle of the box does");
assert.ok(Math.abs((inkPoints(app.state.objects[1])[0].x - memberInk[0].x) + 30) < 1e-9,
  "which is a member that really moved, by the drag and not by its own layer");
assertMembersUnchanged(app.state.objects, pickBefore, "with no member written to on the way: one number for the group is one movement");
// A drag made in several moves instead of one lands where a single move lands, because every move is
// written against the placement the drag began with. A container folded onto its own last frame would
// creep - four quarters of a drag would come out a quarter of it - and a real finger moves in tens of
// frames, so the creep would be the whole gesture.
const stepFrame = canvas.selectionFrame(), stepBefore = app.state.objects.map(memberNumbers);
fire("down", stepFrame.x, stepFrame.y);
[0.25, 0.5, 0.75, 1].forEach((fraction) => { fire("move", stepFrame.x + 80 * fraction, stepFrame.y + 40 * fraction); });
fire("up", stepFrame.x + 80, stepFrame.y + 40);
assert.ok(Math.abs(canvas.selectionFrame().x - (stepFrame.x + 80)) < 1e-9 && Math.abs(canvas.selectionFrame().y - (stepFrame.y + 40)) < 1e-9,
  "a drag of four moves must land at the finger's last place and not at a quarter of it");
assertMembersUnchanged(app.state.objects, stepBefore, "with the members left alone across every frame of it");

// 22b. The same for a selection that has been transformed and not yet grouped: a temporary container is
//      a container under the same rules, and it is the commoner case of the two - two things turned and
//      then carried somewhere. It is also the case an implementation that wrote the members would get
//      *right* while the container was upright and wrong the moment it was turned, so the turn comes
//      first - and then a pull on top of the turn, because that is the pair the owner reports: several
//      objects turned, stretched, and then moved, with the box standing still and the objects leaving it.
scene([
  picture({ id: "a", x: 150, y: 160, width: 160, height: 120 }),
  picture({ id: "b", x: 380, y: 320, width: 160, height: 120 })
], ["a", "b"]);
turnAboutFrame(35);
canvas.scaleSelected(1.6);
const tempBefore = app.state.objects.map(memberNumbers);
const tempFrame = canvas.selectionFrame();
assert.equal(containerCount(), 1, "a selection that has been turned and pulled must be in a temporary container, or there is nothing below for the drag to move");
assert.ok(Math.abs(drawing.placement.axesOf(containerOf(app.state.objects[0]).m)[0] - 1.6) < 1e-9,
  "with the pull written on it, which is what makes the members disagree about nothing at all while the box they are in is 1.6 times the size it was");
dragBox(52, -36);
assert.ok(Math.abs(canvas.selectionFrame().x - (tempFrame.x + 52)) < 1e-9 && Math.abs(canvas.selectionFrame().y - (tempFrame.y - 36)) < 1e-9,
  "a turned and pulled selection must travel by the finger's own numbers too");
assert.ok(Math.abs(canvas.selectionFrame().width - tempFrame.width) < 1e-9 && Math.abs(canvas.selectionFrame().angle - tempFrame.angle) < 1e-9,
  "carried without being turned or resized again");
assertMembersUnchanged(app.state.objects, tempBefore, "with the selection's own members left exactly as they were - carrying a group is not a reason to rewrite what is inside it");
// And letting go of it takes the container away with the carry folded in: the members keep the place
// they were shown at, and the shift goes with the turn into the one pivot that stands for them both.
const carriedFrame = canvas.selectionFrame(), carriedInk = app.state.objects.map(inkPoints);
tapAt(730, 730);
assert.equal(containerCount(), 0, "letting go onto empty canvas must take the temporary container away");
assert.equal(canvas.selectionFrame(), null, "and with it the box");
app.state.objects.forEach((object, index) => {
  inkPoints(object).forEach((point, which) => {
    assert.ok(Math.abs(point.x - carriedInk[index][which].x) < 1e-9 && Math.abs(point.y - carriedInk[index][which].y) < 1e-9,
      "member " + index + " must still be drawn exactly where it was carried to - a carry that was folded in as a distance rather than as a placement would throw it somewhere else entirely");
  });
});

// 22c. A polyline is picked up through a box cached for it, and carrying a group does not write to the
//      members - so those boxes are not touched by anything the drag does and have to be put aside by
//      hand. Left stale they go on answering for the place the group used to be, which reads as a
//      group that cannot be picked up again once it has been moved while remaining pickable where it
//      no longer is. Both halves are asserted, because either one alone passes for the wrong reason.
scene([
  pencil({ id: "s1", points: [{ x: 150, y: 150 }, { x: 300, y: 210 }] }),
  pencil({ id: "s2", points: [{ x: 180, y: 320 }, { x: 340, y: 380 }] })
], ["s1", "s2"]);
turnAboutFrame(90);
canvas.groupSelected();
const strokeWas = canvas.selectionFrame();
const strokeInk = app.state.objects.map(inkPoints);
const wasBox = drawing.bounds(app.state.objects[0]);
tapAt(wasBox.x + wasBox.width / 2, wasBox.y + wasBox.height / 2);
assert.equal(app.state.selectedIds.length, 2, "a tap on a polyline of a group must pick up the group - which is also what fills the cache this section is about");
assert.equal(canvas.selectionFrame().angle, strokeWas.angle, "the group must have been turned, or a stale box and a fresh one would be the same box");
dragBox(0, 120);
assert.ok(Math.abs(canvas.selectionFrame().y - (strokeWas.y + 120)) < 1e-9, "the group of polylines must be carried like any other");
assertFramedBy(app.state.objects, canvas.selectionFrame(), "the box around a group of polylines that has been carried");
// Where a polyline's own box is now, and where the cache would still claim it is: the two are far
// enough apart that a box left behind could not be mistaken for the right one.
const nowBox = drawing.bounds(app.state.objects[0]);
assert.ok(nowBox.y - wasBox.y > 60, "the polyline's own box must have come a long way from where it was, or the two readings below would agree by accident");
const pickedAt = (box) => { tapAt(box.x + box.width / 2, box.y + box.height / 2); return app.state.selectedIds.slice().sort().join(","); };
assert.equal(pickedAt(nowBox), "s1,s2", "the group must be pickable where it is now - the box it is picked up through has to have gone with it");
assert.equal(pickedAt(wasBox), "", "and must not be pickable where it was, which is what a box left behind would answer for");

// 23. Two fingers on a transformed group scale it and carry it, and they do it through the container:
//     the members are left exactly as they are, so the whole arrangement grows about the point between
//     the fingers - a point of the drawing rather than a corner of the box - and travels by however far
//     that point moved. A pinch has one number to give and not two, so both of the container's axes must
//     take the same one. Measured on the ink, because the ink is what the hand sees, and with the point
//     between the fingers off the centre of the box and moving, so that the scale and the carry are
//     asserted at once - a pinch that only ever scaled about the box's own centre would pass otherwise.
scene([
  picture({ id: "a", x: 120, y: 140, width: 180, height: 130, rotation: Math.PI / 7 }),
  picture({ id: "b", x: 330, y: 300, width: 140, height: 170 })
], ["a", "b"]);
turnAboutFrame(37);
canvas.groupSelected();
const pinchBefore = app.state.objects.map(memberNumbers);
const pinchFrame = canvas.selectionFrame(), pinchInk = app.state.objects.map(inkPoints), pinchSteps = app.state.history.length;
const fingers = { a0: boxPoint(-70, 10), b0: boxPoint(50, -40), a1: boxPoint(-140, -20), b1: boxPoint(130, 40) };
const pinchFrom = midpointOf(fingers.a0, fingers.b0), pinchTo = midpointOf(fingers.a1, fingers.b1);
const pinchFactor = Math.hypot(fingers.b1.x - fingers.a1.x, fingers.b1.y - fingers.a1.y) / Math.hypot(fingers.b0.x - fingers.a0.x, fingers.b0.y - fingers.a0.y);
assert.ok(pinchFactor > 1.4 && pinchFactor < 2.6,
  "the fingers must really be asking for a scale of some size - " + round(pinchFactor) + " - or nothing below is about scaling at all");
assert.ok(Math.hypot(pinchTo.x - pinchFrom.x, pinchTo.y - pinchFrom.y) > 20,
  "and must really have carried their midpoint, or the second half of what a pinch does would be untested");
pinchFingers(fingers.a0, fingers.b0, fingers.a1, fingers.b1);
const pinchedFrame = canvas.selectionFrame(), pinchedNode = containerOf(app.state.objects[0]);
assert.equal(app.state.history.length, pinchSteps + 1, "a pinch is one step of the journal");
assert.equal(containerCount(), 1, "and must leave the group in one container");
assertMembersUnchanged(app.state.objects, pinchBefore, "not one number of either member may move: a pinch scales the group, and the things in a group are not what is being scaled");
app.state.objects.forEach((object, index) => {
  inkPoints(object).forEach((point, which) => {
    const want = { x: pinchTo.x + (pinchInk[index][which].x - pinchFrom.x) * pinchFactor, y: pinchTo.y + (pinchInk[index][which].y - pinchFrom.y) * pinchFactor };
    assert.ok(Math.abs(point.x - want.x) < 1e-9 && Math.abs(point.y - want.y) < 1e-9,
      "member " + index + " corner " + which + " must land exactly where growing about the point between the fingers and then carrying that point put it - it landed at " + round(point.x) + "," + round(point.y) + " rather than " + round(want.x) + "," + round(want.y));
  });
});
assert.ok(Math.abs(pinchedFrame.width / pinchFrame.width - pinchFactor) < 1e-9 && Math.abs(pinchedFrame.height / pinchFrame.height - pinchFactor) < 1e-9,
  "and the box must grow by exactly the same factor on both axes at once - " + round(pinchedFrame.width / pinchFrame.width) + " and " + round(pinchedFrame.height / pinchFrame.height) + " for a finger asking for " + round(pinchFactor) + " - or the fingers have been given two numbers to give instead of one");
assert.ok(Math.abs(pinchedFrame.angle - pinchFrame.angle) < 1e-9, "with the group left at the angle it was turned to");
const pinchedAxes = drawing.placement.axesOf(pinchedNode.m);
assert.ok(Math.abs(pinchedAxes[0] - pinchedAxes[1]) < 1e-9, "and the container's own two axes still the same length, which is what one number for two axes means");
assertFramedBy(app.state.objects, pinchedFrame, "the box around a group that has been pinched");
// The same gesture with the fingers held the same distance apart is pure travel: reading the pair rather
// than each finger is what makes moving both a move, and it has to be as exact as the drag on the box.
const travelBefore = app.state.objects.map(memberNumbers);
const travelFrame = canvas.selectionFrame(), travelInk = app.state.objects.map(inkPoints);
const travelStart = boxPoint(-60, 30), travelAlso = boxPoint(60, -30);
pinchFingers(travelStart, travelAlso, { x: travelStart.x + 33, y: travelStart.y - 21 }, { x: travelAlso.x + 33, y: travelAlso.y - 21 });
const travelledFrame = canvas.selectionFrame();
assert.ok(Math.abs(travelledFrame.x - (travelFrame.x + 33)) < 1e-9 && Math.abs(travelledFrame.y - (travelFrame.y - 21)) < 1e-9,
  "two fingers moved together are a move: the box must travel by the finger's own numbers");
assert.ok(Math.abs(travelledFrame.width - travelFrame.width) < 1e-9 && Math.abs(travelledFrame.height - travelFrame.height) < 1e-9,
  "and keep its size, since the fingers kept the distance between them");
app.state.objects.forEach((object, index) => {
  inkPoints(object).forEach((point, which) => {
    assert.ok(Math.abs(point.x - (travelInk[index][which].x + 33)) < 1e-9 && Math.abs(point.y - (travelInk[index][which].y - 21)) < 1e-9,
      "with the ink carried by exactly that much - corner " + which + " of member " + index + " included");
  });
});
assertMembersUnchanged(app.state.objects, travelBefore, "and no member written to by the carry");
// A pair that is not both inside the box is not a pinch: the second finger is not a second finger to the
// drawing, and it must not quietly take hold of a selection the first one was only going to tap.
const outsideFrame = canvas.selectionFrame(), outsideNode = containerOf(app.state.objects[0]);
const outsideRecords = app.state.objects.map(memberNumbers), outsideWays = outsideNode.m.slice();
pinchFingers(boxPoint(-40, 0), { x: outsideFrame.x + outsideFrame.width, y: outsideFrame.y + outsideFrame.height + 200 },
  boxPoint(-90, 0), { x: outsideFrame.x + outsideFrame.width + 90, y: outsideFrame.y + outsideFrame.height + 200 });
assert.deepEqual(containerOf(app.state.objects[0]).m.map(round), outsideWays.map(round),
  "a finger down outside the box must not pinch: the pair is answered only when both are inside it");
assertMembersUnchanged(app.state.objects, outsideRecords, "nor must the drawing have moved some other way instead");


// 24. 不分顺序、反复操作: once a container is there, the box and what is inside it must stay in step
//     through any sequence of gestures - turning, pulling a corner, carrying, pinching - in any order,
//     as many times as the user cares to repeat them. Each step is checked on the two things that can
//     come apart: the box must still be exactly the box around what is drawn, and no member may have
//     been written to since the container appeared. The order below is deliberately mixed - carry
//     first, then turn, then pinch, then pull, then carry again - because a container that is right in
//     one order and wrong in another is exactly what a bug of this shape looks like.
scene([
  picture({ id: "a", x: 140, y: 150, width: 170, height: 120, rotation: Math.PI / 5 }),
  picture({ id: "b", x: 400, y: 330, width: 130, height: 160 })
], ["a", "b"]);
turnAboutFrame(28);
assert.equal(containerCount(), 1, "the mixed sequence must be run inside a container, or it is not about a container at all");
const sequenceRecords = app.state.objects.map(memberNumbers);
const mismatches = [];
function inStep(label) {
  assertFramedBy(app.state.objects, canvas.selectionFrame(), label);
  if (app.state.objects.map(memberNumbers).join("|") !== sequenceRecords.join("|")) mismatches.push(label);
}
inStep("the container as the sequence begins");
dragBox(-38, 46); inStep("after carrying it first");
turnAboutFrame(-52); inStep("then turning it");
const seqFingers = { a0: boxPoint(-80, 25), b0: boxPoint(60, -45), a1: boxPoint(-150, 10), b1: boxPoint(120, -70) };
pinchFingers(seqFingers.a0, seqFingers.b0, seqFingers.a1, seqFingers.b1); inStep("then pinching it");
const seqFrame = canvas.selectionFrame();
pullCorner(0.35 * seqFrame.width, -0.25 * seqFrame.height); inStep("then pulling a corner of it");
dragBox(24, 61); inStep("and carrying it again at the end");
turnAboutFrame(17); inStep("and turning it once more");
assert.equal(mismatches.join("; ") || "", "", "not one number of either member may move at any point of the sequence: " + mismatches.join("; "));
// What the sequence must not do is *shear* the container. A pinch gives one number for both axes and a
// corner pull deliberately gives two, so the axes may end up different lengths - that is a rectangle
// turned and sized, and a rectangle is what a box can ride. A shear is the one shape a rectangle cannot
// hold, and it is what composing a scale on the wrong side of the placement produces, so this is the
// assertion that says the sequence stayed in the family of shapes the model is built from.
const sequenceMap = containerOf(app.state.objects[0]).m;
assert.ok(drawing.placement.isSquare(sequenceMap),
  "no order of turning, pulling, carrying and pinching may shear the container: its two axes must still be square to each other");
assert.ok(Math.abs(drawing.placement.axesOf(sequenceMap)[0] - drawing.placement.axesOf(sequenceMap)[1]) > 1e-6,
  "while the uneven corner pull must really have reached the container, or the shear assertion above would be about a container nothing had happened to");
assert.equal(containerCount(), 1, "with one container all the way through, never a second one and never one too few");


// 25. Group and Ungroup are about a group - never about the box a selection happens to be wearing.
//     A selection of several things that has been turned, scaled, pulled, carried or pinched is
//     inside a temporary container like any other, and a temporary container is not a group, so the
//     Group button has to stay live right through the transform and go dead only once the selection
//     really is one group. Ungroup is the mirror of it: live only when what is selected is genuinely
//     grouped, so it must not come alive merely because a transform left a container behind. This is
//     the owner's report, read on the pair of predicates the two buttons are armed with - and the
//     mutator is asked as well, because a rule that lives only on a disabled attribute is a rule the
//     next change to the drawing can walk straight past.
scene([
  picture({ id: "a", x: 140, y: 150, width: 170, height: 120, rotation: Math.PI / 5 }),
  picture({ id: "b", x: 400, y: 330, width: 130, height: 160 })
], ["a", "b"]);
const canGroup = () => canvas.canGroupSelected(), canUngroup = () => canvas.canUngroupSelected();
assert.equal(containerCount(), 0, "the section must begin with two things merely selected, or the first reading below is about a container");
assert.equal(canGroup(), true, "two things selected and no group anywhere: Group must be live");
assert.equal(canUngroup(), false, "and Ungroup dead, since there is no grouping to take away");
turnAboutFrame(31);
assert.equal(containerCount(), 1, "turning the selection must leave it in a container");
assert.equal(containerOf(app.state.objects[0]).formal, false, "and a temporary one - which is the whole of what these two buttons have to be blind to");
assert.equal(canGroup(), true, "turning a selection is not grouping it: Group must still be live, or the user cannot group what they have just turned");
assert.equal(canUngroup(), false, "and Ungroup must still be dead, since a temporary container is not a group to take apart");
canvas.scaleSelected(1.4);
assert.equal(canGroup(), true, "nor is scaling, however the selection was scaled");
assert.equal(canUngroup(), false, "and a scale is not a grouping either");
dragBox(-26, 38);
assert.equal(canGroup(), true, "nor carrying: the button must survive every step of the transform");
assert.equal(canUngroup(), false, "with Ungroup still waiting for an actual group");
const liveFrame = canvas.selectionFrame();
pullCorner(0.3 * liveFrame.width, 0.2 * liveFrame.height);
assert.equal(canGroup(), true, "a pulled corner is still not a group");
assert.equal(canUngroup(), false, "and must not arm Ungroup");
pinchFingers(boxPoint(-45, 20), boxPoint(45, -20), boxPoint(-80, 35), boxPoint(80, -35));
assert.equal(containerCount(), 1, "the pinch must have been answered by the same container all along");
assert.equal(canGroup(), true, "and two fingers are not a group either: after a turn, a scale, a pull, a carry and a pinch, Group must still be live");
assert.equal(canUngroup(), false, "while Ungroup has had nothing to do the whole way through");
// The mutator refuses as well. Left ungated, Ungroup would fold the temporary container into its
// members - throwing away a transform the user is in the middle of - which is the same mistake seen
// from the other side, and it is why the predicate is asked here rather than only at the button.
canvas.ungroupSelected();
assert.equal(containerCount(), 1, "Ungroup must leave a container that exists only because several things are selected: there is no group in it to take apart");
assert.equal(containerOf(app.state.objects[0]).formal, false, "and must not make one of it on the way past");
assert.equal(canGroup(), true, "with Group no worse off for the attempt");
// Now they really are a group, and the two swap over.
canvas.groupSelected();
assert.equal(containerCount(), 1, "grouping must still be the same container made real rather than a second one");
assert.equal(canGroup(), false, "once the selection is one group there is nothing left for Group to do, so it goes dead");
assert.equal(canUngroup(), true, "and Ungroup takes over, which is the pairing the owner asked for");
turnAboutFrame(-22);
dragBox(17, -13);
assert.equal(canGroup(), false, "a group that has been transformed is still a group: Group must stay dead through it");
assert.equal(canUngroup(), true, "with Ungroup still live, since a group is exactly what Ungroup is for");
canvas.ungroupSelected();
assert.equal(containerCount(), 0, "and Ungroup must leave the group itself gone");
assert.equal(canGroup(), true, "handing the selection back as several things again, with Group live once more");
assert.equal(canUngroup(), false, "and Ungroup dead again");
// One thing selected, and nothing selected: neither button has anything to do.
scene([picture({ id: "a", x: 140, y: 150, width: 170, height: 120 })], ["a"]);
assert.equal(canGroup(), false, "one thing is not a group: Group has nothing to group it with");
assert.equal(canUngroup(), false, "nor is there anything grouped to take apart");
scene([picture({ id: "a", x: 140, y: 150, width: 170, height: 120 })], []);
assert.equal(canGroup(), false, "and with nothing selected both must be dead");
assert.equal(canUngroup(), false, "both of them");
// Two groups held at once. The selection is inside no one container then, so Group has something to
// do and Ungroup has two groups it can take apart. Reading "already grouped" off the members' names -
// which is what armed the buttons before - would have answered yes here as well, and left the user
// holding two groups with no way to read either of the answers the buttons stand for.
scene([
  picture({ id: "a", x: 120, y: 130, width: 120, height: 110 }),
  picture({ id: "b", x: 280, y: 130, width: 120, height: 110 }),
  picture({ id: "c", x: 440, y: 420, width: 120, height: 110 }),
  picture({ id: "d", x: 600, y: 420, width: 120, height: 110 })
], ["a", "b"]);
canvas.groupSelected();
app.state.selectedIds = ["c", "d"]; app.state.selectedId = "d";
canvas.groupSelected();
assert.equal(containerCount(), 2, "the scene must really hold two groups, or the reading below is about one");
app.state.selectedIds = ["a", "b", "c", "d"]; app.state.selectedId = "d";
assert.equal(canGroup(), true, "two groups selected at once is not one group: Group still has a group to make of them");
assert.equal(canUngroup(), true, "and Ungroup has two groups it can take apart");


console.log("rotation.test.mjs: ok (handle set and sizes, turned box, turn about the held centre, magnet, anchored corner resize, group turn that moves no geometry, resize of a turned group, turn-aware tap, round trip, two-axis corner resize, single-axis pull, mixed-angle group turn, pulled centre, lone member of a turned group, pull that is two axes at any angle, box held by the finger, box tight at an angle that is not a quarter, second object pickable beside a selected one, box edge still draggable, temporary container folded away, group kept and dissolved, group copied, group carried by the finger, temporary container carried, polyline cache invalidated by a carry, group pinched by two fingers, any order repeated, group and ungroup armed by the group)");
