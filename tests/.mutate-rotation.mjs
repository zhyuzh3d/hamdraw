import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Prove the tests are holding the behaviour: break the code in one place at a time and make sure the
// suite goes red, at the assertion that is about that place. A mutation that stays green means the
// assertion is decoration, and the fix is a case that catches it, not the removal of the assertion.
//
// The selection model is a pair - a container node holding a placement and a rectangle, and members
// that only name it - so a mutation is picked from each of the places that pairing is decided: where a
// container is made, where a transform is written, where it is copied, where it is folded back into its
// members, and where the box around a selection is read. Two of the mutations break drawing.js instead,
// because the placement library is where the container's scale lives and a mutation that only ever
// reached canvas.js would leave the half of the model that is math untested.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canvasPath = path.join(root, "app/components/canvas.js");
const drawingPath = path.join(root, "app/core/drawing.js");
const sources = { canvas: fs.readFileSync(canvasPath, "utf8"), drawing: fs.readFileSync(drawingPath, "utf8") };
const paths = { canvas: canvasPath, drawing: drawingPath };
const digest = (text) => crypto.createHash("sha256").update(text).digest("hex");
const node = process.execPath;

const mutations = [
  { name: "M30-1 the box measured on the records instead of the ink", file: "canvas",
    from: "    var raw = object.type === \"image\"\n      ? [[object.x, object.y], [object.x + object.width, object.y], [object.x, object.y + object.height], [object.x + object.width, object.y + object.height]]\n      : (object.points || []).map(function (point) { return [point.x, point.y]; });",
    to: "    var raw = (function () { var box = app.drawing.localBounds(object); return [[box.x, box.y], [box.x + box.width, box.y], [box.x, box.y + box.height], [box.x + box.width, box.y + box.height]]; })();",
    with: [{ from: "return object.type === \"image\" ? 0 : Number(object.width) / 2 + 5;", to: "return 0;" }],
    expect: /every side of the box must be touched/ },
  // The brush is the box's own reach, so leaving it out shrinks the box a selection of several is
  // given. The hug itself is pinned by M30-1, whose two steps together are the measurement this one
  // half undoes.
  { name: "M30-2 the brush left out of the box", file: "canvas",
    from: "return object.type === \"image\" ? 0 : Number(object.width) / 2 + 5;", to: "return 0;",
    expect: /the one point a turn leaves where it is/ },
  { name: "M30-3 the turn written on the members instead of the container", file: "canvas",
    from: "      node.m = app.drawing.placement.compose(app.drawing.placement.fromRotation(delta, transform.centre), transform.container.m);",
    to: "      transform.objects.forEach(function (object, index) { writeLevel(object, app.drawing.placement.compose(app.drawing.placement.fromRotation(delta, transform.centre), app.drawing.levelMap(transform.originals[index]))); });",
    expect: /the turn must be written on the container/ },
  // The container's scale applied along the world's axes instead of the container's own. It is the one
  // mistake a uniform pull cannot see - an even scale about a point is the same map whichever side of the
  // placement it is written on - so the assertion that catches it is the uneven pull, where the two axes
  // of the box have to be the two axes of the stretch.
  { name: "M30-4 the container's scale applied along the world's axes", file: "drawing",
    from: "    return compose(m, fromScale(scaleX, scaleY, applyTo(back, anchor.x, anchor.y)));",
    to: "    return compose(fromScale(scaleX, scaleY, anchor), m);",
    expect: /must be drawn 1.6 times as wide along the box's own axis/ },
  // And the same scale taken out of the container's axes the other way: the scale is undone by the
  // placement and the whole thing re-placed, so the scale ends up conjugated by the placement. An even
  // pull then has a linear part of R·sI·R⁻¹ - which is sI, which is no angle at all - so the box stands
  // itself upright and the anchor travels with it. This is the defect that was found by the rewritten
  // tests rather than by inspection.
  { name: "M30-19 the container's scale conjugated by its own placement", file: "drawing",
    from: "    return compose(m, fromScale(scaleX, scaleY, applyTo(back, anchor.x, anchor.y)));",
    to: "    return compose(m, compose(fromScale(scaleX, scaleY, anchor), invert(m)));",
    expect: /the corner opposite the one being pulled must not move at all/ },
  // A container pull that reaches inside as well as transforming the group: the box is right and the
  // members have been rewritten anyway, which is the whole thing "a group is transformed, the things
  // in it are not" forbids.
  { name: "M30-5 a container pull that reaches inside the group", file: "canvas",
    from: "    if (transform.container) scaleContainer(app.drawing.groupNode(transform.container.id), factorX, factorY, transform.anchor, transform.container.m);",
    to: "    if (transform.container) { scaleContainer(app.drawing.groupNode(transform.container.id), factorX, factorY, transform.anchor, transform.container.m); transform.objects.forEach(function (object, index) { scaleLone(object, transform.originals[index], factorX, factorY, transform.anchor); }); }",
    expect: /must keep the four numbers it is stored with/ },
  { name: "M30-6 a multi-member transform that never makes a container", file: "canvas",
    from: "  function transformContainer(objects) { return objects.length > 1 ? containerFor(objects, false) : null; }",
    to: "  function transformContainer(objects) { return null; }",
    expect: /that container must really be there/ },
  { name: "M30-7 melting a container but leaving the node behind", file: "canvas",
    from: "    delete groupTable()[groupId];",
    to: "    void groupId;",
    expect: /the selection ends up in one container, not in three/ },
  { name: "M30-8 melting a container without folding it into its members", file: "canvas",
    from: "      if (map) absorb(object, map); else writeLevel(object, app.drawing.levelMap(object));",
    to: "      void map;",
    expect: /must be drawn where the turn put it, whether or not it arrived carrying a container of its own/ },
  { name: "M30-9 picking one member up takes the whole temporary container", file: "canvas",
    from: "    if (!node || !node.formal) return [object.id];",
    to: "    if (!node) return [object.id];",
    expect: /picking up one member must take the container away/ },
  { name: "M30-10 a group taken away like a selection", file: "canvas",
    from: "      if (table[id].formal) return;",
    to: "      if (false) return;",
    expect: /a group must survive the selection being dropped/ },
  { name: "M30-11 成组 re-measuring the container", file: "canvas",
    from: "    containerFor(objects, true).formal = true;",
    to: "    var node = containerFor(objects, true); node.formal = true; node.rect = boxOfEdges(inkBox(objects, null));",
    expect: /must not re-measure it/ },
  { name: "M30-12 成组 re-aiming the container", file: "canvas",
    from: "    containerFor(objects, true).formal = true;",
    to: "    var node = containerFor(objects, true); node.formal = true; node.m = app.drawing.placement.identity;",
    expect: /nor re-aim it/ },
  { name: "M30-13 a duplicate of a group that brings no container", file: "canvas",
    from: "      table[copiedGroups[id]] = app.drawing.cloneGroups({ node: node }).node;",
    to: "      void node;",
    expect: /the copy must bring a container of its own/ },
  { name: "M30-14 a placement that is a plain turn written as a matrix", file: "canvas",
    from: "      if (fixed) { object.rotation = app.drawing.normalizeAngle(app.drawing.placement.angleOf(total)); object.rotationPivot = fixed; return; }",
    to: "      if (fixed) { object.linear = [total[0], total[1], total[2], total[3]]; object.offset = { x: total[4], y: total[5] }; return; }",
    expect: /a quarter turn must land on sideways exactly/ },
  { name: "M30-15 the circle answers over the object below it", file: "canvas",
    from: "if (handles[index].key === \"rotate\" && (insideFrame(p, frame) || (gap > handles[index].radius && hitTest(p)))) continue;",
    to: "if (handles[index].key === \"rotate\" && insideFrame(p, frame)) continue;",
    expect: /must select the picture under the finger/ },
  { name: "M30-16 the circle gives away its own ink as well", file: "canvas",
    from: "(gap > handles[index].radius && hitTest(p))", to: "hitTest(p)",
    expect: /must still turn the selection/ },
  { name: "M30-17 the circle answers inside the box as well", file: "canvas",
    from: "if (handles[index].key === \"rotate\" && (insideFrame(p, frame) || (gap > handles[index].radius && hitTest(p)))) continue;",
    to: "if (handles[index].key === \"rotate\" && (gap > handles[index].radius && hitTest(p))) continue;",
    expect: /a touch on the box's own bottom edge must drag the object rather than start a turn/ },
  { name: "M30-18 a drag from an object no longer marquees", file: "canvas",
    from: "marqueeOnDrag: Boolean(hit && hit.type === \"image\" && !hitAlreadySelected)", to: "marqueeOnDrag: false",
    expect: /must still take up both/ },
  // Carrying a group. The four below are the owner's report split into the four ways the same code can
  // go wrong: the displacement written on the members instead of on the container (the box left behind
  // and the children walking out of it), the members rewritten as well as the container, the shift
  // composed against the world instead of against the container's own placement, and the drag folded
  // onto its own last frame. The first is the one that was reported; the rest are what the same fix
  // has to hold, and each is caught by a different assertion.
  { name: "M30-20 a carry written on the members instead of the container", file: "canvas",
    from: "      parts.push({ container: { id: object.groupId, m: node.m.slice() } });",
    to: "      parts.push({ object: object });",
    expect: /the box must go with the group/ },
  { name: "M30-21 a carry that reaches the members as well", file: "canvas",
    from: "      node.m = app.drawing.placement.compose([1, 0, 0, 1, p.x - dragging.origin.x, p.y - dragging.origin.y], part.container.m);",
    to: "      node.m = app.drawing.placement.compose([1, 0, 0, 1, p.x - dragging.origin.x, p.y - dragging.origin.y], part.container.m);\n      dragging.objects.forEach(function (object) { translate(object, dx, dy); });",
    expect: /must be drawn exactly 40,70 from where it was/ },
  { name: "M30-22 a carry composed against the world instead of the container", file: "canvas",
    from: "p.x - dragging.origin.x, p.y - dragging.origin.y], part.container.m);",
    to: "p.x - dragging.origin.x, p.y - dragging.origin.y], app.drawing.placement.identity);",
    expect: /with its size and its angle untouched/ },
  { name: "M30-23 a carry folded onto its own last frame", file: "canvas",
    from: "p.x - dragging.origin.x, p.y - dragging.origin.y], part.container.m);",
    to: "dx, dy], part.container.m);",
    expect: /a drag of four moves must land at the finger's last place/ },
  { name: "M30-24 the boxes cached for the members left stale by a carry", file: "canvas",
    from: "      state.objects.forEach(function (object) { if (object.groupId === part.container.id) invalidateBounds(object); });",
    to: "      void 0;",
    expect: /must be pickable where it is now/ },
  // And a pinch. Two fingers on a container are the same pairing as a pull by the same amount on both
  // axes, so the two mistakes that matter are the ones a pinch cannot hide: the scale written on the
  // members rather than on the container, and the container's placement left out of it.
  { name: "M30-25 a pinch that scales the members instead of the container", file: "canvas",
    from: "    var node = transformContainer(objects);\n    var limits = transformLimits(objects);\n    pinching =",
    to: "    var node = null;\n    var limits = transformLimits(objects);\n    pinching =",
    expect: /a pinch scales the group, and the things in a group are not what is being scaled/ },
  { name: "M30-26 a pinch that scales about the fingers but forgets the container", file: "canvas",
    from: "      node.m = app.drawing.placement.compose([1, 0, 0, 1, dx, dy], node.m);",
    to: "      node.m = app.drawing.placement.compose([1, 0, 0, 1, dx, dy], app.drawing.placement.fromScale(factor, factor, transform.center));",
    expect: /must land exactly where growing about the point between the fingers/ },
  { name: "M30-27 a pinch that leaves out the point between the fingers", file: "canvas",
    from: "      node.m = app.drawing.placement.compose([1, 0, 0, 1, dx, dy], node.m);\n    } else {",
    to: "      void dx;\n    } else {",
    expect: /must land exactly where growing about the point between the fingers/ },
  // And the two buttons that are about a group. Every one of these is a way of letting something
  // other than the formal flag decide, which is what the owner saw: the moment a selection was
  // transformed at all, Group went dead and Ungroup came alive, as though a temporary container were
  // a group. The first two are that mistake on the buttons, the third is the same mistake inside the
  // mutator - where it would throw away a transform in progress - and the last two are the two ways
  // of reading the flag that a selection can be got wrong by: counting one thing as several, and
  // taking one group found anywhere in the selection for the whole of it.
  { name: "M31-28 a Group button blind to whether the selection is already one group", file: "canvas",
    from: "    var objects = selectedObjects();\n    if (objects.length < 2) return false;\n    var node = app.drawing.sharedContainer(objects);\n    return !(node && node.formal);",
    to: "    var objects = selectedObjects();\n    if (objects.length < 2) return false;\n    return true;",
    expect: /once the selection is one group there is nothing left for Group to do/ },
  { name: "M31-29 a Group button a transform can switch off", file: "canvas",
    from: "    return !(node && node.formal);",
    to: "    return !node;",
    expect: /turning a selection is not grouping it/ },
  { name: "M31-30 解散组 armed by the member naming a group rather than by the group", file: "canvas",
    from: "    var node = object && object.groupId ? app.drawing.groupNode(object.groupId) : null;\n    return node && node.formal ? object.groupId : \"\";",
    to: "    return object && object.groupId ? object.groupId : \"\";",
    expect: /and Ungroup must still be dead/ },
  { name: "M31-31 解散组 taking a temporary container apart", file: "canvas",
    from: "    var ids = objects.map(formalGroupId).filter(function (id) { return Boolean(id); });",
    to: "    var ids = objects.filter(function (object) { return Boolean(object.groupId); }).map(function (object) { return object.groupId; });",
    expect: /Ungroup must leave a container that exists only because several things are selected/ },
  { name: "M31-32 a Group button that would group one thing with itself", file: "canvas",
    from: "    if (objects.length < 2) return false;",
    to: "    if (objects.length < 1) return false;",
    expect: /one thing is not a group/ },
  { name: "M31-33 a Group button that reads any group in the selection as the whole of it", file: "canvas",
    from: "    var node = app.drawing.sharedContainer(objects);\n    return !(node && node.formal);",
    to: "    var node = app.drawing.sharedContainer(objects);\n    void node;\n    return !objects.some(function (item) { return formalGroupId(item); });",
    expect: /two groups selected at once is not one group/ }
];

let failed = 0;
const dirty = new Set();
function restore() { dirty.forEach((key) => { fs.writeFileSync(paths[key], sources[key]); }); dirty.clear(); }
// A mutation that throws out of this loop would leave the repository holding broken code, which is a
// worse outcome than a failed run: the files go back first, whatever happens to the run.
process.on("exit", restore);
process.on("uncaughtException", (error) => { restore(); console.error(error); process.exit(1); });
try {
mutations.forEach((mutation) => {
  // A mutation is one edit or several that only mean anything together - measuring the ink is one idea
  // and it takes two lines to undo - so each step is checked for its anchor and each must change the text.
  const key = mutation.file || "canvas", baseline = sources[key];
  let mutated = baseline;
  [mutation].concat(mutation.with || []).forEach((step) => {
    assert.equal(mutated.split(step.from).length - 1, 1,
      mutation.name + ": the anchor must appear exactly once, or the mutation is not the one described");
    mutated = mutated.replace(step.from, step.to);
  });
  assert.notEqual(mutated, baseline, mutation.name + ": the mutation must change the file");
  fs.writeFileSync(paths[key], mutated); dirty.add(key);
  let output = "";
  try {
    execFileSync(node, [path.join(root, "tests/rotation.test.mjs")], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    output = String(error.stdout || "") + String(error.stderr || "");
  } finally {
    restore();
  }
  const lines = output.split("\n");
  const at = lines.findIndex((line) => line.trimStart().startsWith("AssertionError"));
  const green = at < 0;
  const said = mutation.expect.test(output);
  if (green || !said) failed += 1;
  console.log((green ? "GREEN (not caught) " : said ? "red               " : "RED, wrong reason ") + mutation.name);
  if (green) {
    console.log("                  no assertion fired at all");
  } else {
    console.log("                  " + lines.slice(at, at + 4).map((line) => line.trim()).filter(Boolean).join(" | ").slice(0, 200));
  }
});
} finally {
  restore();
}
Object.keys(sources).forEach((key) => assert.equal(digest(fs.readFileSync(paths[key], "utf8")), digest(sources[key]), "the file must be byte for byte the one that was here before the mutation"));
console.log("canvas.js + drawing.js restored: " + digest(sources.canvas).slice(0, 16) + " (" + mutations.length + " mutations, " + (mutations.length - failed) + " caught for the right reason)");
