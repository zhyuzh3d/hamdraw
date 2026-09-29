(function (app) {
  "use strict";

  var state = app.state;
  var canvas, context, contentCanvas, contentContext, selectionCanvas, selectionContext, maskCanvas, maskContext, maskContentCanvas, maskContentContext, frameTask, selectionTask;
  var drawingObject = null;
  var dragging = null;
  var resizing = null;
  var rotating = null;
  var pinching = null;
  var selectionGesture = null;
  var selectionMarquee = null;
  var activePointers = {}, inputRect = null;
  var imageCache = app.runtime.createLru({ maxEntries: 16, maxWeight: 48 * 1024 * 1024, weight: function (image) { return Math.max(1, Number(image.naturalWidth) * Number(image.naturalHeight) * 4); } }), imageLoads = new Map(), imageRefresh = new Set(), resultLayerCache = new WeakMap();
  var boundsCache = new WeakMap(), contentDirty = true, lastRenderMeta = "", lastBackgroundStyle = "", lastOpacityStyle = "";
  var performance = { frames: 0, contentRebuilds: 0, objectsDrawn: 0 };
  var WIDTH = 768;
  var HANDLE_DRAW_RADIUS = 16;
  var HANDLE_HIT_RADIUS = 36;
  var ROTATE_HANDLE_DRAW_RADIUS = 27;
  var ROTATE_HANDLE_HIT_RADIUS = 60;
  //: How far the circle hangs below the box. It was the two hit radii plus the drawn radius -
  //: 112 - and the owner has halved it, to bring the circle in near the bottom edge where a
  //: thumb already is. Half of the old sum is closer to the edge than the circle's own reach,
  //: so the circle's aim now crosses back over the edge by a sliver; `hitHandle` refuses that
  //: sliver rather than let the bottom of a selected object start a turn.
  var ROTATE_HANDLE_GAP = (HANDLE_HIT_RADIUS + ROTATE_HANDLE_HIT_RADIUS + HANDLE_DRAW_RADIUS) / 2;
  //: Within this much of upright, a turn lands on upright exactly. Without it a drag can
  //: never bring a picture back to level - it leaves a residue like 0.7 degrees that
  //: nothing can undo by hand, and every later box carries the skew.
  var ROTATE_SNAP_ANGLE = Math.PI / 45;
  var MIN_IMAGE_SIZE = 48;
  var MAX_IMAGE_SIZE = WIDTH * 3;
  var MIN_STROKE_SIZE = 3;
  var GESTURE_THRESHOLD = 12;
  // The journal always holds the current state plus one entry per undoable
  // action, so "120 undo steps" is 121 stored states. A finished generation is
  // one step, which is what makes 120 consecutive generations 120 steps back.
  var HISTORY_MAX_UNDO_STEPS = 120;
  var HISTORY_MAX_ENTRIES = HISTORY_MAX_UNDO_STEPS + 1;
  var HISTORY_MAX_WEIGHT = 12 * 1024 * 1024;
  // Older results live only in this journal and are never written to Haminn data,
  // so their encoded size is bounded here instead: the ceiling fits 120 typical
  // 512 px results, while a pathological run cannot exhaust the WebView heap.
  // Characters are counted per entry, which over-counts an image two entries
  // share and errs on the safe side.
  var HISTORY_MAX_RESULT_CHARS = 96 * 1024 * 1024;

  function resultColorFilter(settings) {
    settings = settings || state;
    if (settings.resultAdjustmentsEnabled === false) return "none";
    return "brightness(" + Math.max(20, Number(settings.resultBrightness)) + "%) contrast(" + Math.max(20, Number(settings.resultContrast)) + "%) saturate(" + Math.max(0, Number(settings.resultSaturation)) + "%) hue-rotate(" + Number(settings.resultHue) + "deg)";
  }
  function sharpenAmount(settings) { settings = settings || state; return settings.resultAdjustmentsEnabled === false ? 0 : Math.max(0, Math.min(100, Number(settings.resultClarity) || 0)) / 100 * 0.8; }
  function syncSharpenFilter(settings) {
    var matrix = document.getElementById("hamdraw-sharpen-matrix"); if (!matrix) return;
    var amount = sharpenAmount(settings), center = 1 + amount * 4;
    matrix.setAttribute("kernelMatrix", "0 " + (-amount) + " 0 " + (-amount) + " " + center + " " + (-amount) + " 0 " + (-amount) + " 0");
  }
  function resultFilter(settings) {
    settings = settings || state;
    if (settings.resultAdjustmentsEnabled === false) return "none";
    return (sharpenAmount(settings) > 0 ? "url(#hamdraw-sharpen) " : "") + resultColorFilter(settings);
  }
  function resultGlowFilter(settings) {
    settings = settings || state;
    var glow = settings.resultAdjustmentsEnabled === false ? 0 : Number(settings.resultGlow) || 0;
    return resultColorFilter(settings) + " blur(" + (1 + glow * 0.1) + "px) brightness(" + (108 + glow * 0.45) + "%) saturate(" + (105 + glow * 0.35) + "%)";
  }
  function sharpenCanvas(target, settings) {
    var amount = sharpenAmount(settings); if (!amount) return;
    var targetContext = target.getContext("2d"), width = target.width, height = target.height, source;
    try { source = targetContext.getImageData(0, 0, width, height); } catch (_) { return; }
    var input = source.data, output = new Uint8ClampedArray(input), stride = width * 4;
    for (var y = 1; y < height - 1; y += 1) {
      for (var x = 1; x < width - 1; x += 1) {
        var offset = y * stride + x * 4;
        for (var channel = 0; channel < 3; channel += 1) {
          output[offset + channel] = input[offset + channel] * (1 + amount * 4) - amount * (input[offset - 4 + channel] + input[offset + 4 + channel] + input[offset - stride + channel] + input[offset + stride + channel]);
        }
      }
    }
    source.data.set(output); targetContext.putImageData(source, 0, 0);
  }
  function drawResult(ctx, image, width, height, contained, settings) {
    settings = settings || state;
    var alpha = ctx.globalAlpha;
    function paint(targetContext) { if (contained) drawContained(targetContext, image, width, height); else targetContext.drawImage(image, 0, 0, width, height); }
    var key = [width, height, contained ? 1 : 0, settings.resultAdjustmentsEnabled === false ? 0 : 1, settings.resultBrightness, settings.resultContrast, settings.resultSaturation, settings.resultHue, settings.resultClarity].join("|");
    var cachedLayer = resultLayerCache.get(image), layer = cachedLayer && cachedLayer.key === key ? cachedLayer.canvas : null;
    if (!layer) {
      layer = document.createElement("canvas"); layer.width = width; layer.height = height;
      var layerContext = layer.getContext("2d"); layerContext.filter = resultColorFilter(settings); paint(layerContext); sharpenCanvas(layer, settings);
      resultLayerCache.set(image, { key: key, canvas: layer });
    }
    ctx.drawImage(layer, 0, 0);
    var glow = settings.resultAdjustmentsEnabled === false ? 0 : Number(settings.resultGlow) || 0;
    if (glow > 0) {
      ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = alpha * Math.min(0.62, glow / 150); ctx.filter = resultGlowFilter(settings); paint(ctx); ctx.restore();
    }
  }

  function init() {
    canvas = document.getElementById("draft-canvas");
    context = canvas.getContext("2d");
    selectionCanvas = document.getElementById("selection-canvas");
    selectionContext = selectionCanvas.getContext("2d");
    contentCanvas = document.createElement("canvas"); contentCanvas.width = WIDTH; contentCanvas.height = WIDTH; contentContext = contentCanvas.getContext("2d");
    maskCanvas = document.getElementById("mask-canvas");
    maskContext = maskCanvas ? maskCanvas.getContext("2d") : null;
    maskContentCanvas = document.createElement("canvas"); maskContentCanvas.width = WIDTH; maskContentCanvas.height = WIDTH; maskContentContext = maskContentCanvas.getContext("2d");
    frameTask = app.runtime.createFrameTask(paintFrame);
    selectionTask = app.runtime.createFrameTask(function (ids) { app.events.emit("selection", ids); });
    bindInput();
    render();
    resetHistory();
  }
  function bindInput() {
    if (window.PointerEvent) {
      canvas.addEventListener("pointerdown", start);
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);
    } else {
      canvas.addEventListener("mousedown", start);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", end);
      canvas.addEventListener("touchstart", start, { passive: false });
      canvas.addEventListener("touchmove", move, { passive: false });
      canvas.addEventListener("touchend", end, { passive: false });
    }
  }
  function setInteractionActive(active) { if (!active) inputRect = null; app.events.emit("canvas:interaction", Boolean(active)); }
  function pointFromSource(source) {
    var rect = inputRect || canvas.getBoundingClientRect();
    return { x: (source.clientX - rect.left) * WIDTH / rect.width, y: (source.clientY - rect.top) * WIDTH / rect.height };
  }
  function point(event) { return pointFromSource(event.touches && event.touches[0] || event.changedTouches && event.changedTouches[0] || event); }
  function touchPair(event) {
    if (!event.touches || event.touches.length < 2) return null;
    return [pointFromSource(event.touches[0]), pointFromSource(event.touches[1])];
  }
  function start(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (state.tool !== "select" && event.isPrimary === false) return;
    inputRect = canvas.getBoundingClientRect(); setInteractionActive(true);
    event.preventDefault();
    if (event.pointerId !== undefined && canvas.setPointerCapture && event.isTrusted) canvas.setPointerCapture(event.pointerId);
    var p = point(event);
    if (state.tool === "select") {
      if (event.pointerId !== undefined) activePointers[event.pointerId] = p;
      var pair = event.pointerId === undefined ? touchPair(event) : pointerPair();
      var current = selectedObjects();
      if (pair && current.length && insideSelection(pair[0], current, HANDLE_HIT_RADIUS) && insideSelection(pair[1], current, HANDLE_HIT_RADIUS)) {
        selectionGesture = null; selectionMarquee = null; beginPinch(current, pair); scheduleRender(false); return;
      }
      if (event.pointerId !== undefined && Object.keys(activePointers).length > 1) { selectionGesture = null; return; }
      var handle = current.length ? hitHandle(p, current) : null;
      if (handle) {
        var turning = handle.key === "rotate";
        resizing = turning ? null : beginResize(current, handle, event.pointerId);
        rotating = turning ? beginRotate(current, p, event.pointerId) : null;
        dragging = null; selectionGesture = null;
        canvas.style.cursor = turning ? "grabbing" : handle.key === "nw" || handle.key === "se" ? "nwse-resize" : "nesw-resize";
        scheduleRender(false); return;
      }
      var hit = hitTest(p), ids = selectionIds(), moveIds = [], hitIds = hit ? objectSelectionIds(hit) : [];
      var modified = Boolean(event.shiftKey || event.ctrlKey || event.metaKey);
      if (hit) {
        if (ids.indexOf(hit.id) >= 0 && ids.length > 1) moveIds = ids.slice();
        else if (modified && ids.indexOf(hit.id) < 0) moveIds = ids.concat(hitIds);
        else moveIds = hitIds;
      } else if (current.length && insideSelection(p, current, 0)) moveIds = ids.slice();
      var hitAlreadySelected = hitIds.length && hitIds.every(function (id) { return ids.indexOf(id) >= 0; });
      selectionGesture = { start: p, hit: hit, initialIds: ids, moveIds: moveIds, modified: modified, pointerId: event.pointerId,
        marqueeOnDrag: Boolean(hit && hit.type === "image" && !hitAlreadySelected) };
      dragging = null; selectionMarquee = null;
      return;
    }
    setSelection([]);
    drawingObject = {
      id: app.utils.id("stroke"),
      type: "stroke",
      tool: state.tool,
      color: state.tool === "mask" ? "#e5484d" : state.color,
      width: state.tool === "pencil" ? Math.max(1, Math.round(state.size / 3)) : state.tool === "eraser" ? Math.max(8, state.size * 1.6) : state.size,
      opacity: state.tool === "mask" ? 0.55 : state.tool === "eraser" ? 1 : state.opacity,
      points: [p]
    };
    state.objects.push(drawingObject);
    scheduleRender(false);
  }
  function move(event) {
    if (event.pointerId !== undefined && activePointers[event.pointerId]) activePointers[event.pointerId] = point(event);
    if (pinching) {
      var pair = event.pointerId === undefined ? touchPair(event) : pointerPair();
      if (pair) { event.preventDefault(); applyPinch(pair); scheduleRender(true); }
      return;
    }
    if (selectionGesture) {
      if (selectionGesture.pointerId !== undefined && event.pointerId !== selectionGesture.pointerId) return;
      var gesturePoint = point(event);
      if (distance(selectionGesture.start, gesturePoint) < GESTURE_THRESHOLD) return;
      event.preventDefault();
      if (selectionGesture.moveIds.length && !selectionGesture.marqueeOnDrag) {
        setSelection(selectionGesture.moveIds);
        //: The layers a drag writes to, taken once as the drag begins - after the selection is
        //: committed, because committing it is what decides which containers are still there. Read
        //: here rather than per move so that every move writes against one reading of the drawing,
        //: which is the discipline every other gesture in this file follows.
        var moved = selectedObjects();
        dragging = { objects: moved, parts: dragParts(moved), origin: { x: selectionGesture.start.x, y: selectionGesture.start.y },
          x: selectionGesture.start.x, y: selectionGesture.start.y, moved: false, pointerId: selectionGesture.pointerId };
        selectionGesture = null; emitSelection(); canvas.style.cursor = "grabbing";
        moveDraggingTo(gesturePoint); scheduleRender(true);
      } else {
        selectionMarquee = { start: selectionGesture.start, current: gesturePoint, initialIds: selectionGesture.initialIds, modified: selectionGesture.modified, pointerId: selectionGesture.pointerId };
        selectionGesture = null; canvas.style.cursor = "crosshair";
        updateMarqueeSelection(); scheduleRender(false); emitSelection();
      }
      return;
    }
    if (selectionMarquee) {
      if (selectionMarquee.pointerId !== undefined && event.pointerId !== selectionMarquee.pointerId) return;
      event.preventDefault(); selectionMarquee.current = point(event); updateMarqueeSelection(); scheduleRender(false); emitSelection(); return;
    }
    if (!drawingObject && !dragging && !resizing && !rotating) return;
    event.preventDefault();
    var p = point(event);
    if (drawingObject) {
      var points = drawingObject.points, last = points[points.length - 1];
      if (distance(last, p) >= 1.5) { points.push(p); invalidateBounds(drawingObject); }
      scheduleRender(false);
      return;
    }
    if (resizing) {
      if (resizing.pointerId !== undefined && event.pointerId !== resizing.pointerId) return;
      resizeTo(p); scheduleRender(true); return;
    }
    if (rotating) {
      if (rotating.pointerId !== undefined && event.pointerId !== rotating.pointerId) return;
      rotateTo(p); scheduleRender(true); return;
    }
    if (dragging.pointerId !== undefined && event.pointerId !== dragging.pointerId) return;
    moveDraggingTo(p); scheduleRender(true);
  }
  function end(event) {
    if (event && event.pointerId !== undefined) delete activePointers[event.pointerId];
    if (pinching) {
      if (event && event.preventDefault) event.preventDefault();
      var pinchChanged = pinching.changed; pinching = null; dragging = null; resizing = null; rotating = null; activePointers = {};
      canvas.style.cursor = "grab";
      if (pinchChanged) commit();
      setInteractionActive(false);
      return;
    }
    if (event && event.preventDefault && (drawingObject || dragging || resizing || rotating || selectionGesture || selectionMarquee)) event.preventDefault();
    if (resizing && resizing.pointerId !== undefined && event && event.pointerId !== undefined && event.pointerId !== resizing.pointerId) return;
    if (rotating && rotating.pointerId !== undefined && event && event.pointerId !== undefined && event.pointerId !== rotating.pointerId) return;
    if (dragging && dragging.pointerId !== undefined && event && event.pointerId !== undefined && event.pointerId !== dragging.pointerId) return;
    if (selectionMarquee && selectionMarquee.pointerId !== undefined && event && event.pointerId !== undefined && event.pointerId !== selectionMarquee.pointerId) return;
    if (selectionGesture && selectionGesture.pointerId !== undefined && event && event.pointerId !== undefined && event.pointerId !== selectionGesture.pointerId) return;
    if (selectionMarquee) {
      selectionMarquee = null; selectionGesture = null; canvas.style.cursor = "grab"; scheduleRender(false); emitSelection(); setInteractionActive(false); return;
    }
    if (selectionGesture) {
      var gesture = selectionGesture; selectionGesture = null;
      if (event && /cancel$/.test(event.type)) setSelection(gesture.initialIds);
      else if (gesture.hit) {
        if (gesture.modified) {
          var gestureHitIds = objectSelectionIds(gesture.hit), alreadyIncluded = gestureHitIds.every(function (id) { return gesture.initialIds.indexOf(id) >= 0; });
          var toggled = gesture.initialIds.filter(function (id) { return gestureHitIds.indexOf(id) < 0; });
          if (!alreadyIncluded) toggled = toggled.concat(gestureHitIds);
          setSelection(toggled);
        } else setSelection(objectSelectionIds(gesture.hit));
      } else setSelection([]);
      canvas.style.cursor = "grab"; scheduleRender(false); emitSelection(); setInteractionActive(false); return;
    }
    var changed = Boolean(drawingObject || dragging && dragging.moved || resizing && resizing.changed || rotating && rotating.changed);
    var finishedDrawing = Boolean(drawingObject); drawingObject = null;
    dragging = null;
    resizing = null;
    rotating = null;
    if (state.tool === "select") canvas.style.cursor = "grab";
    if (finishedDrawing) render();
    else if (frameTask && frameTask.pending()) frameTask.flush();
    if (changed) commit();
    setInteractionActive(false);
  }
  //: The layers a move writes to. Each part of a selection travels by its own outer layer: a member
  //: that is drawn through a container is moved by moving the container - the member itself is left
  //: exactly as it is - and a member that is in no container has no outer layer but its own record,
  //: and is moved there. Moving a member's own geometry instead would move the picture by the
  //: container's idea of that direction, which is a different direction as soon as the container has
  //: been turned: a group turned a quarter would travel sideways under a finger going down. It would
  //: also leave the container's rectangle - the box the user is holding - behind at the place the
  //: drag began. One part per container, because two members of one container are one thing to move.
  function dragParts(objects) {
    var parts = [], seen = {};
    objects.forEach(function (object) {
      var node = object.groupId ? app.drawing.groupNode(object.groupId) : null;
      if (!node) { parts.push({ object: object }); return; }
      if (seen[object.groupId]) return;
      seen[object.groupId] = true;
      parts.push({ container: { id: object.groupId, m: node.m.slice() } });
    });
    return parts;
  }
  function moveDraggingTo(p) {
    var dx = p.x - dragging.x, dy = p.y - dragging.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.25) return;
    dragging.parts.forEach(function (part) {
      if (!part.container) { translate(part.object, dx, dy); return; }
      var node = app.drawing.groupNode(part.container.id);
      if (!node) return;
      //: Written against the placement the drag began with, so a long drag cannot accumulate rounding
      //: and two drags in a row cannot drift. The shift goes on the *outside*, where a point of the
      //: drawing lands where the finger put it whatever the container is turned or stretched to.
      node.m = app.drawing.placement.compose([1, 0, 0, 1, p.x - dragging.origin.x, p.y - dragging.origin.y], part.container.m);
      //: Not one number of a member moved, so the boxes cached for them are now the boxes they were
      //: before the drag: a polyline is picked up through its cache, and one left stale would go on
      //: answering for the place it used to be.
      state.objects.forEach(function (object) { if (object.groupId === part.container.id) invalidateBounds(object); });
    });
    dragging.x = p.x; dragging.y = p.y; dragging.moved = true;
  }
  function translate(object, dx, dy) {
    //: A member that carries a placement of its own keeps its geometry where it is and moves the
    //: placement: the drawn picture is the geometry *through* the placement, so moving the geometry
    //: would move the picture by the placement's own idea of that direction - which is a different
    //: direction as soon as anything is turned.
    if (object.linear) {
      var offset = object.offset || {};
      object.offset = { x: (Number(offset.x) || 0) + dx, y: (Number(offset.y) || 0) + dy };
      invalidateBounds(object);
      return;
    }
    if (object.type === "stroke") object.points.forEach(function (p) { p.x += dx; p.y += dy; });
    else { object.x += dx; object.y += dy; }
    //: The centres a selection was turned about are points in the same plane, so they are carried
    //: along - both of them: the one the member itself was turned about, and the one its container
    //: was. Left behind, the box would stop agreeing with the objects the moment a turned selection
    //: was dragged instead of turned again.
    var pivot = app.drawing.rotationPivotOf(object);
    if (pivot) object.rotationPivot = { x: pivot.x + dx, y: pivot.y + dy };
    var group = app.drawing.groupPivotOf(object);
    if (group) object.groupPivot = { x: group.x + dx, y: group.y + dy };
    invalidateBounds(object);
  }
  function distance(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  //: Turns an offset. Everything a turned picture needs - where its corners went, which
  //: of its pixels a tap landed on, where a scaled box has to sit - is this one operation
  //: applied to the right offset.
  function turnPoint(angle, x, y) {
    var cos = Math.cos(angle), sin = Math.sin(angle);
    return { x: x * cos - y * sin, y: x * sin + y * cos };
  }
  function rotateAbout(value, origin, angle) {
    var turned = turnPoint(angle, value.x - origin.x, value.y - origin.y);
    return { x: origin.x + turned.x, y: origin.y + turned.y };
  }
  function imageCentre(object) { return { x: object.x + object.width / 2, y: object.y + object.height / 2 }; }
  //: How an object is drawn, as the one matrix the canvas takes: its own placement and then its
  //: container's. `origin` is where the caller's coordinate system currently sits, so the placement
  //: can be written in it - a picture is painted from its own centre, a polyline straight onto the
  //: canvas, and both are asking the same question. Writing the whole of it as one matrix is what
  //: lets a container be more than a turn: a placement has no centre it must be about, so applying
  //: one is a single call rather than a turn per level, and the two levels cannot disagree.
  function applySpin(ctx, object, origin) {
    var map = app.drawing.placedMap(object);
    if (app.drawing.placement.isIdentity(map)) return false;
    var ox = origin ? origin.x : 0, oy = origin ? origin.y : 0;
    var at = app.drawing.placement.apply(map, ox, oy);
    ctx.transform(map[0], map[1], map[2], map[3], at.x - ox, at.y - oy);
    return true;
  }
  function pointerPair() {
    var ids = Object.keys(activePointers);
    return ids.length >= 2 ? [activePointers[ids[0]], activePointers[ids[1]]] : null;
  }
  function selectionIds() {
    var ids = Array.isArray(state.selectedIds) ? state.selectedIds.slice() : [];
    if (!ids.length && state.selectedId) ids.push(state.selectedId);
    var existing = new Set(), unique = [];
    state.objects.forEach(function (object) { existing.add(object.id); });
    ids.forEach(function (id) { if (id && existing.has(id) && unique.indexOf(id) < 0) unique.push(id); });
    return unique;
  }
  function setSelection(ids) {
    var expanded = [];
    (ids || []).forEach(function (id) {
      var object = state.objects.find(function (item) { return item.id === id; });
      if (!object) return;
      objectSelectionIds(object).forEach(function (memberId) { if (expanded.indexOf(memberId) < 0) expanded.push(memberId); });
    });
    //: Every selection change comes through here, so this is the one place the containers a document
    //: is holding are answered for: a container that existed only because several things were
    //: selected is folded into its members the moment the selection is not theirs, and a container
    //: left with fewer than two members - because one was deleted - goes the same way. Both are
    //: settled before anything reads the table again, so nothing downstream ever meets a container
    //: whose membership is not the thing it is looking at.
    releaseTemporaryContainers(expanded);
    pruneContainers();
    state.selectedIds = expanded;
    state.selectedId = state.selectedIds.length ? state.selectedIds[state.selectedIds.length - 1] : "";
  }
  //: Only a group the user made holds together when one of its members is picked. A container that
  //: exists because several things happened to be selected is not a group yet: picking one of its
  //: members picks that member - which is also what takes the container away again, leaving both
  //: where they are drawn.
  function objectSelectionIds(object) {
    if (!object || !object.groupId) return object ? [object.id] : [];
    var node = app.drawing.groupNode(object.groupId);
    if (!node || !node.formal) return [object.id];
    return state.objects.filter(function (item) { return item.groupId === object.groupId; }).map(function (item) { return item.id; });
  }
  function emitSelection() { if (selectionTask) selectionTask.request(selectionIds()); }
  function selectedObjects() {
    var ids = new Set(selectionIds());
    return state.objects.filter(function (object) { return ids.has(object.id); });
  }
  function normalizedRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }
  function boxesIntersect(a, b) {
    return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
  }
  function pointInsideRect(p, rect) {
    return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
  }
  function direction(a, b, c) { return (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x); }
  function linesIntersect(a, b, c, d) {
    if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return false;
    var abC = direction(a, b, c), abD = direction(a, b, d), cdA = direction(c, d, a), cdB = direction(c, d, b);
    return ((abC <= 0 && abD >= 0) || (abC >= 0 && abD <= 0)) && ((cdA <= 0 && cdB >= 0) || (cdA >= 0 && cdB <= 0));
  }
  function segmentIntersectsRect(a, b, rect) {
    if (pointInsideRect(a, rect) || pointInsideRect(b, rect)) return true;
    var topLeft = { x: rect.x, y: rect.y }, topRight = { x: rect.x + rect.width, y: rect.y };
    var bottomLeft = { x: rect.x, y: rect.y + rect.height }, bottomRight = { x: rect.x + rect.width, y: rect.y + rect.height };
    return linesIntersect(a, b, topLeft, topRight) || linesIntersect(a, b, topRight, bottomRight) || linesIntersect(a, b, bottomRight, bottomLeft) || linesIntersect(a, b, bottomLeft, topLeft);
  }
  function objectIntersectsRect(object, rect) {
    if (!boxesIntersect(bounds(object), rect)) return false;
    if (object.type === "image") return true;
    var padding = object.width / 2 + 5;
    var expanded = { x: rect.x - padding, y: rect.y - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 };
    if (object.points.length === 1) return pointInsideRect(object.points[0], expanded);
    for (var index = 1; index < object.points.length; index += 1) {
      if (segmentIntersectsRect(object.points[index - 1], object.points[index], expanded)) return true;
    }
    return false;
  }
  function updateMarqueeSelection() {
    var rect = normalizedRect(selectionMarquee.start, selectionMarquee.current);
    var matched = [], seen = new Set();
    state.objects.forEach(function (object) {
      if (!objectIntersectsRect(object, rect)) return;
      objectSelectionIds(object).forEach(function (id) { if (!seen.has(id)) { seen.add(id); matched.push(id); } });
    });
    if (selectionMarquee.modified) matched = selectionMarquee.initialIds.concat(matched);
    setSelection(matched);
  }
  function selectionBounds(objects) {
    return app.drawing.selectionBounds(objects, bounds);
  }
  function insideSelection(p, objects, padding) {
    var box = selectionBounds(objects); if (!box) return false;
    return p.x >= box.x - padding && p.x <= box.x + box.width + padding && p.y >= box.y - padding && p.y <= box.y + box.height + padding;
  }
  //: The tightest rectangle that holds what the members are drawn as, measured in the axes `back`
  //: takes a drawn point into - the world axes when a selection has no container yet, and a
  //: container's own axes when the box being built is the container's. What is measured is the ink:
  //: a picture's four corners, a polyline's points, each padded by however far its brush reaches.
  //: Measuring a polyline by its record's box instead would be the same set of points only while the
  //: box is turned by nothing, and a box measured around a record that is merely the extent of a
  //: polyline stands off the drawing wherever the polyline is off its own diagonal - which is the
  //: box the owner reported: larger than the objects, not matching their edges.
  function inkBox(objects, back) {
    var box = null;
    objects.forEach(function (object) {
      var reach = outlineReach(object);
      outlinePoints(object).forEach(function (point) {
        var local = back ? app.drawing.placement.apply(back, point.x, point.y) : point;
        var left = local.x - reach, right = local.x + reach, top = local.y - reach, bottom = local.y + reach;
        if (!box) { box = { left: left, top: top, right: right, bottom: bottom }; return; }
        if (left < box.left) box.left = left;
        if (right > box.right) box.right = right;
        if (top < box.top) box.top = top;
        if (bottom > box.bottom) box.bottom = bottom;
      });
    });
    return box || { left: 0, top: 0, right: 1, bottom: 1 };
  }
  function boxOfEdges(edges) {
    return { x: edges.left, y: edges.top, width: Math.max(1, edges.right - edges.left), height: Math.max(1, edges.bottom - edges.top) };
  }
  //: What a member is drawn as, as points a box can be measured around: the ink, through the
  //: member's own placement and then its container's.
  function outlinePoints(object) {
    var raw = object.type === "image"
      ? [[object.x, object.y], [object.x + object.width, object.y], [object.x, object.y + object.height], [object.x + object.width, object.y + object.height]]
      : (object.points || []).map(function (point) { return [point.x, point.y]; });
    var map = app.drawing.placedMap(object);
    return raw.map(function (corner) { return app.drawing.placement.apply(map, corner[0], corner[1]); });
  }
  //: How far the ink of a member reaches past its points: a brush is round, so this is a length with
  //: no axis to lean along and it is the same in every direction. Read off the record the way the
  //: canvas has always read a stroke's extent, so a box around a lone stroke still stands exactly
  //: where it always stood. A picture's record *is* its outline, so it adds nothing.
  function outlineReach(object) {
    return object.type === "image" ? 0 : Number(object.width) / 2 + 5;
  }
  //: The containers a document is holding, created on demand: a container is a thing a selection is
  //: put into, so the table belongs to the drawing rather than to any one object.
  function groupTable() { if (!state.groups) state.groups = {}; return state.groups; }
  //: Containers that exist only because several things are selected are taken away the moment the
  //: selection is not theirs any more. That is the whole of what a temporary container is: a
  //: container like any other while it lives, and - as soon as something else is selected, or
  //: nothing is - folded into its members and gone. The next selection gets one of its own, created
  //: upright, so the box around a selection is as new as the selection is.
  function releaseTemporaryContainers(selected) {
    var table = groupTable();
    Object.keys(table).forEach(function (id) {
      if (table[id].formal) return;
      var members = state.objects.filter(function (object) { return object.groupId === id; });
      var same = members.length === selected.length && members.every(function (object) { return selected.indexOf(object.id) >= 0; });
      if (!same) melt(id);
    });
  }
  //: A container holds a group, and a group of one is not a group. Losing a member - the usual way
  //: is deleting one - takes the container away rather than leaving it to be rediscovered as a
  //: container with a single member in it, which would be a container nothing can be done with:
  //: too few members to transform as a group, and still naming its placement on the one that is
  //: left. The last member takes the placement onto itself, so the picture does not move.
  function pruneContainers() {
    var table = groupTable();
    Object.keys(table).forEach(function (id) {
      var members = state.objects.filter(function (object) { return object.groupId === id; });
      if (members.length >= 2) return;
      if (!members.length) { delete table[id]; return; }
      melt(id);
    });
  }
  //: A frame: the box the objects had before the angle was applied - which turning never touches -
  //: carried round by that angle about the centre they were turned around. The centre is written
  //: as the drawn centre, so every corner the handles promise is a corner of what is really drawn.
  function frameOf(box, angle, pivot) {
    var centre = app.drawing.boxCentre(box);
    var drawn = angle ? rotateAbout(centre, pivot, angle) : centre;
    return { x: drawn.x, y: drawn.y, width: box.width, height: box.height, angle: angle };
  }
  //: A lone object is framed by its own box carried round by its whole angle: its own about its own
  //: centre, and then its container's about the container's. The two are one turn about one centre -
  //: the same identity `absorbTurn` folds them together with - so the box is the record's own box, at
  //: the angle the picture is drawn at, about the centre it is drawn about, and every corner the
  //: handles promise is a corner of the shape. Reading the container's angle alone labelled the box
  //: with half the turn, and measuring the box around the member's leaned rectangle first handed back
  //: a box wider than the picture - both are the same mistake: the two levels are one angle in the
  //: drawing, so they are one angle here too.
  //: A rectangle placed: its own width and height, at the angle and size of the placement that
  //: carries it, written about the point its own centre lands on. This is the whole of "where is the
  //: box", for an object and for a container alike - a container's box is its own rectangle carried
  //: by its own placement, and never a rectangle measured off whatever happens to be inside it.
  function frameOfBox(box, map) {
    var axes = app.drawing.placement.axesOf(map);
    var centre = app.drawing.placement.apply(map, box.x + box.width / 2, box.y + box.height / 2);
    return { x: centre.x, y: centre.y, width: Math.max(1, box.width * axes[0]), height: Math.max(1, box.height * axes[1]),
      angle: app.drawing.placement.angleOf(map) };
  }
  //: A lone object is framed by its own box carried round by its whole placement, so the box is at
  //: the angle and size the picture is drawn at, about the centre it is drawn about, and every corner
  //: the handles promise is a corner of the shape. Where the placement is a turn and a size - which
  //: is everything except a member that has been handed an uneven container scale - that is the
  //: record's box turned and stretched. An uneven scale on a turned record shears it and no rectangle
  //: can hold a sheared one, so the box is then the tightest rectangle of the record's own axes that
  //: holds what is drawn: the frame is an approximation there, and the drawing is exact.
  function loneFrame(object) {
    var box = app.drawing.localBounds(object), map = app.drawing.placedMap(object);
    if (app.drawing.placement.isSquare(map)) return frameOfBox(box, map);
    return frameOfBox(boxOfEdges(inkBox([object], app.drawing.placement.invert(map))), map);
  }
  //: The box the handles ride. A lone object is boxed by its own record carried round its own
  //: placement, which is the shape itself. Several members are boxed by the container they are in:
  //: the container's own rectangle, at the container's own angle and size, so a group comes back
  //: looking like the group that was put away instead of being rebuilt to face the same way as the
  //: canvas. A selection that has not been transformed yet is in no container yet - the container it
  //: is about to be given is created upright - so its box is the tight upright rectangle around what
  //: is drawn, and turning it turns that rectangle. Either way the box is a fact about what is
  //: selected and the thing that holds it, never a memory of how the selection was arrived at.
  function selectionFrame(selection) {
    var objects = Array.isArray(selection) ? selection : selection ? [selection] : [];
    if (!objects.length) return null;
    if (objects.length === 1) return loneFrame(objects[0]);
    //: While a finger is turning the selection the box rides the turn instead, so the circle stays
    //: under the hand. A box that re-fitted itself on every move would slide out from under it,
    //: because the tight box around a turned drawing is not the turn of the tight box around it.
    //: The box is the one the drag took hold of, spun about its own centre - which is the centre the
    //: turn is given about - so it starts exactly where it was and ends where the drawing ends.
    if (rotating && rotating.box) return frameOf(rotating.box, rotating.turned, app.drawing.boxCentre(rotating.box));
    var node = app.drawing.sharedContainer(objects);
    if (node) return frameOfBox(node.rect, node.m);
    return frameOfBox(boxOfEdges(inkBox(objects, null)), app.drawing.placement.identity);
  }
  function framePoint(frame, localX, localY) {
    var turned = turnPoint(frame.angle, localX, localY);
    return { x: frame.x + turned.x, y: frame.y + turned.y };
  }
  function selectionHandles(objects) {
    var frame = selectionFrame(objects);
    if (!frame) return [];
    var halfWidth = frame.width / 2, halfHeight = frame.height / 2;
    var corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    var handles = ["nw", "ne", "sw", "se"].map(function (key, index) {
      var point = framePoint(frame, corners[index][0] * halfWidth, corners[index][1] * halfHeight);
      return { key: key, x: point.x, y: point.y, radius: HANDLE_DRAW_RADIUS, reach: HANDLE_HIT_RADIUS };
    });
    //: The circle is appended last because this order is also the order the targets are
    //: tested in: wherever the two are nearest, the corner is the one that answers, so
    //: the corners always keep the reach they have always had.
    var grip = framePoint(frame, 0, halfHeight + ROTATE_HANDLE_GAP);
    handles.push({ key: "rotate", x: grip.x, y: grip.y, radius: ROTATE_HANDLE_DRAW_RADIUS, reach: ROTATE_HANDLE_HIT_RADIUS });
    return handles;
  }
  //: A point read in the box's own axes, which is how the box answers "was this touch on me".
  function insideFrame(p, frame) {
    if (!frame) return false;
    var local = turnPoint(-frame.angle, p.x - frame.x, p.y - frame.y);
    return Math.abs(local.x) <= frame.width / 2 && Math.abs(local.y) <= frame.height / 2;
  }
  function hitHandle(p, objects) {
    var frame = selectionFrame(objects), handles = selectionHandles(objects);
    for (var index = 0; index < handles.length; index += 1) {
      var gap = distance(p, handles[index]);
      //: The circle is the only target that answers outside its own ink - and its reach is long enough
      //: to cover a band a finger wide all the way round the box - so it is the only one that needs
      //: places it must not answer. Those places are the drawing: the box itself, and anything drawn
      //: that is not this selection once the finger is off the circle's own ink. A touch on an object
      //: belongs to the object, bottom edge included, and an object sitting beside or below a selected
      //: one is the second thing a hand reaches for. Left to answer there, the circle silently swallows
      //: those touches and the next object cannot be picked up at all - the reach is invisible, so
      //: nothing on screen explains the refusal. What it never gives away is its own ink: a finger on
      //: the circle that is drawn is aiming at the circle, whatever happens to lie underneath it, and
      //: without that a selection overlapping another object could not be turned at all.
      if (handles[index].key === "rotate" && (insideFrame(p, frame) || (gap > handles[index].radius && hitTest(p)))) continue;
      if (gap <= handles[index].reach) return handles[index];
    }
    return null;
  }
  //: Scale limits, per axis. A corner drag moves the two axes separately, so each answers for
  //: itself: a selection that has run out of room sideways must still be able to grow taller.
  //: What runs out of room is the size on the canvas, not the size in the record: a member already
  //: drawn bigger than its record says - by its own placement, or by a container that has been
  //: scaled - has that much less room to grow, whether the factors act on the member or on its
  //: container.
  function transformLimits(objects) {
    var limits = { minimumX: 0.02, maximumX: 100, minimumY: 0.02, maximumY: 100 };
    objects.forEach(function (object) {
      var box = app.drawing.localBounds(object);
      var drawn = app.drawing.placement.axesOf(app.drawing.placedMap(object));
      var width = Math.max(1, box.width * drawn[0]), height = Math.max(1, box.height * drawn[1]);
      var floor = object.type === "image" ? MIN_IMAGE_SIZE : MIN_STROKE_SIZE;
      limits.minimumX = Math.max(limits.minimumX, floor / width);
      limits.minimumY = Math.max(limits.minimumY, floor / height);
      limits.maximumX = Math.min(limits.maximumX, MAX_IMAGE_SIZE / width);
      limits.maximumY = Math.min(limits.maximumY, MAX_IMAGE_SIZE / height);
    });
    //: A pinch and the toolbar's buttons scale both axes together, so they take the tighter half
    //: of each pair: whatever one axis may not do, neither may a uniform scale.
    limits.minimum = Math.max(limits.minimumX, limits.minimumY);
    limits.maximum = Math.min(limits.maximumX, limits.maximumY);
    return limits;
  }
  function snapshotObjects(objects) { return app.drawing.cloneObjects(objects); }
  //: Scaling one object: its own record's geometry, along its own two axes, about a point of the
  //: record. The placement is left where it is, because the picture is the record *through* the
  //: placement - so growing the record along its own axes grows the picture along the axes it is
  //: drawn in, which for a selection of one is exactly the box the handles are riding. A record
  //: stretched this way is not an approximation of the stretched picture: it *is* it. The anchor is
  //: read back through the placement first, so the corner the hand is holding stays under the hand.
  function scaleLone(object, original, factorX, factorY, anchor) {
    var map = app.drawing.levelMap(original);
    var back = app.drawing.placement.invert(map);
    var local = back ? app.drawing.placement.apply(back, anchor.x, anchor.y) : anchor;
    if (object.type === "stroke") {
      object.points = (original.points || []).map(function (point) {
        return { x: local.x + (point.x - local.x) * factorX, y: local.y + (point.y - local.y) * factorY };
      });
      //: A brush width is a length, and a length has no axis to be stretched along, so it takes the
      //: factor both axes share: the root of their product, which is the plain factor when they agree.
      object.width = original.width * Math.sqrt(factorX * factorY);
    } else {
      object.x = local.x + (original.x - local.x) * factorX;
      object.y = local.y + (original.y - local.y) * factorY;
      object.width = Math.max(1, original.width * factorX);
      object.height = Math.max(1, original.height * factorY);
    }
    //: The placement is written back as it stood when the drag began. A turn spelled as an angle with
    //: no centre is a turn about the record's *own* centre, and the record has just changed size - so
    //: leaving it implicit would walk the centre the picture turns about to the new centre of the
    //: record, and the picture would swing away from the corner the hand is holding. The angle is
    //: already on the record and stays exactly the number it is; what was missing is the centre, which
    //: is the point the turn leaves where it is. A record that names a centre already, or that spells
    //: its placement as a matrix, says the whole of it and is left alone.
    var fixed = app.drawing.placement.holdsStill(map);
    if (object.rotation !== undefined && !object.rotationPivot && !object.linear && fixed) object.rotationPivot = fixed;
    invalidateBounds(object);
  }
  //: Scaling a container: along the container's own two axes, about a point of the drawing. The
  //: members are not touched at all - so an uneven pull stretches the group and everything in it
  //: together, exactly as it stretched the box the user was holding, instead of stretching each
  //: member along the member's own axes by its own amount - which is what twisted the arrangement.
  function scaleContainer(node, factorX, factorY, anchor, from) {
    node.m = app.drawing.placement.scaleInAxes(from || node.m, factorX, factorY, anchor);
  }
  //: A placement written onto a record. A placement that is a plain turn is written as a turn - the
  //: record every object has always had, an angle and the centre it is about - so an ordinary object
  //: keeps the record it always had and nothing downstream has to know about matrices. A placement
  //: that is nothing but a shift has no centre to be about, so the shift goes into the geometry
  //: instead: both readings draw the same picture, and only the record differs.
  function writeLevel(object, total) {
    delete object.linear; delete object.offset; delete object.rotation; delete object.rotationPivot;
    //: Whatever container the record was drawn through has just been folded into this placement, so
    //: the record must stop naming one, or it would be drawn through it a second time.
    delete object.groupRotation; delete object.groupPivot;
    invalidateBounds(object);
    if (app.drawing.placement.isIdentity(total)) return;
    var axes = app.drawing.placement.axesOf(total);
    if (app.drawing.placement.isSquare(total) && Math.abs(axes[0] - 1) < 1e-9 && Math.abs(axes[1] - 1) < 1e-9) {
      var fixed = app.drawing.placement.holdsStill(total);
      if (fixed) { object.rotation = app.drawing.normalizeAngle(app.drawing.placement.angleOf(total)); object.rotationPivot = fixed; return; }
      translate(object, total[4], total[5]);
      return;
    }
    object.linear = [total[0], total[1], total[2], total[3]];
    object.offset = { x: total[4], y: total[5] };
  }
  //: One member taking a placement onto itself, keeping exactly what it draws. This is the whole of
  //: what dissolving a container is, and it is why nothing moves: the member's own placement becomes
  //: the composition of the two it was drawn through.
  function absorb(object, map) { writeLevel(object, app.drawing.placement.compose(map, app.drawing.levelMap(object))); }
  //: The container a selection is inside, made if it is not there yet. Nothing moves when it is made:
  //: a container is created upright, holding exactly the rectangle around what the selection is
  //: drawn as, which is the box the user can see. `formal` decides how long it lives - a group the
  //: user made stays, and a container that exists only because several things are selected is taken
  //: away again as soon as the selection is.
  //: The name every member of a selection agrees on, or nothing when they do not all agree: a
  //: selection is inside a container only when the whole of it is, and two members that arrived from
  //: different containers are inside neither.
  function commonGroupId(objects) {
    var id = objects.length ? objects[0].groupId : "";
    if (!id) return "";
    for (var index = 1; index < objects.length; index += 1) { if (objects[index].groupId !== id) return ""; }
    return id;
  }
  function containerFor(objects, formal) {
    var id = commonGroupId(objects);
    var existing = id ? app.drawing.groupNode(id) : null;
    if (existing) return existing;
    //: A selection that is not all in one container starts from a fresh one, so the containers the
    //: members did arrive with are folded into them first. That moves nothing - each member keeps
    //: exactly what it is drawn as - and it is what makes one box around the whole selection possible
    //: at all when the members came from containers of their own: a container holding two members of
    //: another container would be two containers naming the same member.
    objects.forEach(function (object) { if (object.groupId) melt(object.groupId); });
    id = app.utils.id("container");
    objects.forEach(function (object) { object.groupId = id; });
    var node = { m: app.drawing.placement.identity, rect: boxOfEdges(inkBox(objects, null)), formal: Boolean(formal) };
    groupTable()[id] = node;
    return node;
  }
  //: The container a multi-member transform writes to, made if it is not there yet. A selection of
  //: more than one member is a temporary container like any other: from the first turn or pull it is
  //: the thing being transformed, which is what leaves the members' own placements untouched and
  //: lets an uneven pull stretch the whole arrangement instead of each member along axes of its own.
  function transformContainer(objects) { return objects.length > 1 ? containerFor(objects, false) : null; }
  //: A container folded into each of its members and then deleted: the group is gone, its angle and
  //: its size with it, and the picture has not moved by a pixel. Nothing of the container is left on
  //: the members either - no name, no turn, no centre - so what is left is exactly the objects, each
  //: carrying where it is drawn as one placement of its own. A member naming a group with no node
  //: behind it is a record written before containers were nodes: the group lives on the member then,
  //: and it is folded in from there.
  function melt(groupId) {
    var node = app.drawing.groupNode(groupId);
    state.objects.forEach(function (object) {
      if (object.groupId !== groupId) return;
      var map = node && node.m ? node.m : app.drawing.containerMap(object);
      if (map) absorb(object, map); else writeLevel(object, app.drawing.levelMap(object));
      delete object.groupId;
    });
    delete groupTable()[groupId];
  }
  //: The corner a resize holds still is a corner of the box the user is holding, and it is a point of
  //: the drawing, so it stays under the hand whether the factors land on a container or on one
  //: object. The drag is read in the box's own axes; `beginResize` records the box as the drag began
  //: with so that every move of the gesture writes against that one reading rather than compounding
  //: against the last - a long drag cannot accumulate rounding and two drags in a row cannot drift.
  function beginResize(objects, handle, pointerId) {
    var node = transformContainer(objects);
    var frame = selectionFrame(objects), limits = transformLimits(objects);
    var localX = (handle.key.indexOf("w") >= 0 ? 1 : -1) * frame.width / 2;
    var localY = (handle.key.indexOf("n") >= 0 ? 1 : -1) * frame.height / 2;
    var corner = framePoint(frame, localX, localY);
    return { objects: objects, originals: snapshotObjects(objects), limits: limits, pointerId: pointerId, changed: false,
      angle: frame.angle, localX: localX, localY: localY, held: corner, anchor: corner,
      container: node ? { id: objects[0].groupId, m: node.m.slice() } : null };
  }
  //: A corner drag is one gesture per axis: how much wider the pull asks for, and how much taller -
  //: so a box can be made long and thin, which is what a frame with four independent corners is for.
  //: Each is a one-dimensional drag of the held corner away from the corner opposite it, measured
  //: against the diagonal the two span: the corner under the finger then follows the finger on both
  //: axes at once, and the two run out of room separately, so a pull that has hit the floor sideways
  //: still lengthens the other axis instead of freezing the gesture. Every selection takes this pull,
  //: whatever angles its members are drawn at, and it is not this gesture's business to withdraw it.
  function resizeTo(p) {
    var transform = resizing, limits = transform.limits;
    var local = turnPoint(-transform.angle, p.x - transform.held.x, p.y - transform.held.y);
    var factorX = local.x / (-2 * transform.localX);
    var factorY = local.y / (-2 * transform.localY);
    factorX = Math.max(limits.minimumX, Math.min(limits.maximumX, factorX));
    factorY = Math.max(limits.minimumY, Math.min(limits.maximumY, factorY));
    if (transform.container) scaleContainer(app.drawing.groupNode(transform.container.id), factorX, factorY, transform.anchor, transform.container.m);
    else transform.objects.forEach(function (object, index) { scaleLone(object, transform.originals[index], factorX, factorY, transform.anchor); });
    transform.changed = Math.abs(factorX - 1) > 0.002 || Math.abs(factorY - 1) > 0.002;
  }
  //: One turn of the whole selection, about the centre of the box the user is holding. Several
  //: members turn their container: the turn goes onto the container and every member is left exactly
  //: as it was - so two members turned against each other turn together without either adopting the
  //: other's angle, and each keeps its own when the group is broken up again. One member turns
  //: itself, as it always has. The box is remembered as the drag's own: while the finger is down the
  //: box rides the turn rather than being re-fitted on every move, so the circle keeps the place on
  //: the box the finger took hold of.
  function beginRotate(objects, p, pointerId) {
    var frame = selectionFrame(objects);
    var centre = { x: frame.x, y: frame.y };
    var node = transformContainer(objects);
    return { objects: objects, originals: snapshotObjects(objects), centre: centre, angle: frame.angle, turned: frame.angle,
      box: { x: centre.x - frame.width / 2, y: centre.y - frame.height / 2, width: frame.width, height: frame.height },
      container: node ? { id: objects[0].groupId, m: node.m.slice() } : null,
      from: Math.atan2(p.y - centre.y, p.x - centre.x), pointerId: pointerId, changed: false };
  }
  function rotateTo(p) {
    var transform = rotating;
    //: The pointer's angle is read as the short way round. On its own the difference of two
    //: atan2 readings jumps by a full turn as the finger crosses the far side of the circle -
    //: which is exactly where the grip sits once the selection has been turned a quarter -
    //: and the selection would spin the long way for a nudge of a few degrees.
    var delta = app.drawing.normalizeAngle(Math.atan2(p.y - transform.centre.y, p.x - transform.centre.x) - transform.from);
    var turned = transform.angle + delta;
    var upright = Math.round(turned / (Math.PI / 2)) * (Math.PI / 2);
    if (Math.abs(turned - upright) <= ROTATE_SNAP_ANGLE) turned = upright;
    delta = turned - transform.angle;
    transform.turned = turned;
    if (transform.container) {
      //: The turn is written against the placement the drag began with, so a long drag cannot
      //: accumulate rounding and two drags in a row cannot drift.
      var node = app.drawing.groupNode(transform.container.id);
      node.m = app.drawing.placement.compose(app.drawing.placement.fromRotation(delta, transform.centre), transform.container.m);
    } else {
      transform.objects.forEach(function (object, index) {
        writeLevel(object, app.drawing.placement.compose(app.drawing.placement.fromRotation(delta, transform.centre), app.drawing.levelMap(transform.originals[index])));
      });
    }
    transform.changed = Math.abs(delta) > 0.002;
  }
  //: A pinch has one number to give, not two, so it scales both axes by it - about the point between
  //: the fingers, which is a point of the drawing rather than a corner of the box - and then carries
  //: the selection along with the fingers. Several members scale their container; one object scales
  //: its own record, which is the same thing seen from the only thing there is to scale.
  function beginPinch(objects, pair) {
    var center = midpoint(pair[0], pair[1]);
    var node = transformContainer(objects);
    var limits = transformLimits(objects);
    pinching = { objects: objects, originals: snapshotObjects(objects), distance: Math.max(1, distance(pair[0], pair[1])), center: center,
      minimum: limits.minimum, maximum: limits.maximum,
      container: node ? { id: objects[0].groupId, m: node.m.slice() } : null, changed: false };
    dragging = null; resizing = null; selectionGesture = null; selectionMarquee = null;
  }
  function applyPinch(pair) {
    var transform = pinching, center = midpoint(pair[0], pair[1]);
    var factor = distance(pair[0], pair[1]) / transform.distance;
    factor = Math.max(transform.minimum, Math.min(transform.maximum, factor));
    var dx = center.x - transform.center.x, dy = center.y - transform.center.y;
    if (transform.container) {
      var node = app.drawing.groupNode(transform.container.id);
      node.m = app.drawing.placement.compose(app.drawing.placement.fromScale(factor, factor, transform.center), transform.container.m);
      node.m = app.drawing.placement.compose([1, 0, 0, 1, dx, dy], node.m);
    } else {
      transform.objects.forEach(function (object, index) {
        scaleLone(object, transform.originals[index], factor, factor, transform.center);
        translate(object, dx, dy);
      });
    }
    transform.changed = Math.abs(factor - 1) > 0.002 || distance(center, transform.center) > 0.5;
  }
  function segmentDistance(pointValue, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    if (!dx && !dy) return distance(pointValue, a);
    var t = ((pointValue.x - a.x) * dx + (pointValue.y - a.y) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return distance(pointValue, { x: a.x + t * dx, y: a.y + t * dy });
  }
  //: A tap is read where the object is stored, not where it is drawn: the placement it is drawn
  //: through is undone - the container's first, since that is what was applied last - and what is
  //: left is the record the test has always been written against. Without this the empty corner
  //: beside a turned picture, or a whole group turned on its side, would answer a tap it is not
  //: under.
  function rawPoint(object, p) {
    var back = app.drawing.placement.invert(app.drawing.placedMap(object));
    return back ? app.drawing.placement.apply(back, p.x, p.y) : p;
  }
  //: The bounds test above a tap only narrows the search: a turned picture is no longer
  //: the rectangle its record spells out, so the tap itself is read in the picture's own
  //: frame. Without this, the empty triangle beside a turned picture would select it.
  function imageContains(object, p) {
    var local = rawPoint(object, p);
    return local.x >= object.x && local.x <= object.x + object.width && local.y >= object.y && local.y <= object.y + object.height;
  }
  function strokeContains(object, p) {
    var local = rawPoint(object, p);
    if (object.points.length === 1) return distance(local, object.points[0]) <= object.width / 2 + 12;
    for (var index = 1; index < object.points.length; index += 1) {
      if (segmentDistance(local, object.points[index - 1], object.points[index]) <= object.width / 2 + 12) return true;
    }
    return false;
  }
  function hitTest(p) {
    for (var index = state.objects.length - 1; index >= 0; index -= 1) {
      var object = state.objects[index];
      var box = bounds(object), padding = object.type === "image" ? 0 : 12;
      if (p.x < box.x - padding || p.x > box.x + box.width + padding || p.y < box.y - padding || p.y > box.y + box.height + padding) continue;
      if (object.type === "image") { if (imageContains(object, p)) return object; }
      else if (strokeContains(object, p)) return object;
    }
    return null;
  }
  function bounds(object) {
    if (object.type === "image") return app.drawing.bounds(object);
    var cached = boundsCache.get(object);
    if (cached) return cached;
    cached = app.drawing.bounds(object); boundsCache.set(object, cached); return cached;
  }
  function invalidateBounds(object) { if (object && object.type === "stroke") boundsCache.delete(object); }
  function drawStroke(ctx, object, maskPreview) {
    if (!object.points.length) return;
    ctx.save();
    //: A polyline has no angle of its own to record, so the one an object carries is painted
    //: here: the points stay where they were drawn and the canvas is turned around the centre
    //: they were turned about. That is also what lets `bounds` answer for it with the same angle.
    applySpin(ctx, object);
    ctx.globalCompositeOperation = object.tool === "eraser" ? "destination-out" : "source-over";
    ctx.globalAlpha = object.opacity;
    ctx.strokeStyle = object.tool === "mask" && maskPreview ? "#e5484d" : object.color;
    ctx.lineWidth = object.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(object.points[0].x, object.points[0].y);
    for (var index = 1; index < object.points.length; index += 1) ctx.lineTo(object.points[index].x, object.points[index].y);
    if (object.points.length === 1) ctx.lineTo(object.points[0].x + 0.1, object.points[0].y + 0.1);
    ctx.stroke();
    ctx.restore();
  }
  function loadImage(src, refreshCanvas) {
    if (!src) return Promise.resolve(null);
    var cached = imageCache.get(src);
    if (cached && cached.complete && cached.naturalWidth) return Promise.resolve(cached);
    if (refreshCanvas !== false) imageRefresh.add(src);
    if (imageLoads.has(src)) return imageLoads.get(src);
    var promise = new Promise(function (resolve) {
      var image = new Image();
      image.onload = function () {
        imageCache.set(src, image); imageLoads.delete(src); resolve(image);
        if (imageRefresh.has(src)) scheduleRender(true);
        imageRefresh.delete(src);
      };
      image.onerror = function () { imageLoads.delete(src); imageRefresh.delete(src); resolve(null); };
      image.src = src;
    });
    imageLoads.set(src, promise); return promise;
  }
  function drawContained(ctx, image, width, height) {
    var scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    var w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  }
  // The opposite trade to drawContained: a frame that must reach its own edges crops the
  // surplus instead of leaving it as background. Gallery cards use it so a card never shows
  // a pale band beside the picture, whatever aspect the rendered image came back in.
  function drawCovered(ctx, image, width, height) {
    var scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
    var w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  }
  function drawImageObject(ctx, object) {
    var source = object.src || object.url;
    var image = object._imageSource === source && object._image && object._image.complete ? object._image : imageCache.get(source);
    if (image && image.complete && image.naturalWidth) {
      object._image = image; object._imageSource = source;
      drawPicture(ctx, object, image);
    } else loadImage(source, true).then(function (loaded) {
      if (loaded && (object.src || object.url) === source) { object._image = loaded; object._imageSource = source; }
    });
  }
  //: A picture's four numbers always describe an upright rectangle; the angles are what carry it
  //: round - its own, and its container's over that. Every path that paints one - the live canvas,
  //: the composite that is handed to the model, the gallery thumbnail - comes through here, so none
  //: of them can quietly paint it upright while its box says otherwise.
  function drawPicture(ctx, object, image) {
    if (app.drawing.placement.isIdentity(app.drawing.placedMap(object))) { ctx.drawImage(image, object.x, object.y, object.width, object.height); return; }
    var centre = imageCentre(object);
    ctx.save();
    ctx.translate(centre.x, centre.y);
    applySpin(ctx, object, centre);
    ctx.drawImage(image, -object.width / 2, -object.height / 2, object.width, object.height);
    ctx.restore();
  }
  function scheduleRender(changed) {
    if (changed) contentDirty = true;
    if (frameTask) frameTask.request();
  }
  function rebuildContent() {
    contentContext.clearRect(0, 0, WIDTH, WIDTH);
    maskContentContext.clearRect(0, 0, WIDTH, WIDTH);
    state.objects.forEach(function (object) {
      if (object === drawingObject) return;
      if (isMaskStroke(object)) { drawStroke(maskContentContext, object, true); return; }
      if (object.type === "stroke") drawStroke(contentContext, object, true);
      else drawImageObject(contentContext, object);
      performance.objectsDrawn += 1;
    });
    contentDirty = false; performance.contentRebuilds += 1;
  }
  function paintFrame() {
    if (!context) return;
    performance.frames += 1;
    if (contentDirty) rebuildContent();
    context.clearRect(0, 0, WIDTH, WIDTH);
    selectionContext.clearRect(0, 0, WIDTH, WIDTH);
    context.drawImage(contentCanvas, 0, 0);
    if (maskContext) {
      maskContext.clearRect(0, 0, WIDTH, WIDTH);
      if (state.maskMode && state.maskVisible !== false) {
        maskContext.drawImage(maskContentCanvas, 0, 0);
        if (isMaskStroke(drawingObject)) drawStroke(maskContext, drawingObject, true);
      }
    }
    if (drawingObject && !isMaskStroke(drawingObject)) drawStroke(context, drawingObject, true);
    var selected = selectedObjects();
    if (selected.length && !selectionMarquee) {
      var frame = selectionFrame(selected);
      selectionContext.save();
      selectionContext.strokeStyle = "#ee4f85";
      selectionContext.lineWidth = 2;
      selectionContext.setLineDash([9, 7]);
      // Drawn in the frame's own axes, so a turned picture is boxed by the turned
      // rectangle and an upright selection gets exactly the rectangle it always had.
      selectionContext.translate(frame.x, frame.y);
      selectionContext.rotate(frame.angle);
      selectionContext.strokeRect(-frame.width / 2, -frame.height / 2, frame.width, frame.height);
      selectionContext.restore();
      selectionHandles(selected).forEach(paintHandle);
    }
    if (selectionMarquee) {
      var marqueeBox = normalizedRect(selectionMarquee.start, selectionMarquee.current);
      selectionContext.save();
      selectionContext.fillStyle = "rgba(238,79,133,.12)"; selectionContext.fillRect(marqueeBox.x, marqueeBox.y, marqueeBox.width, marqueeBox.height);
      selectionContext.strokeStyle = "#e75483"; selectionContext.lineWidth = 2; selectionContext.setLineDash([10, 7]);
      selectionContext.strokeRect(marqueeBox.x, marqueeBox.y, marqueeBox.width, marqueeBox.height);
      selectionContext.restore();
    }
    var opacity = "1";
    if (state.maskMode) opacity = "0";
    else if (state.overlayGenerate) opacity = String(Math.max(0, Math.min(1, Number(state.layerOpacity == null ? 1 : state.layerOpacity))));
    var background = document.getElementById("stage-background");
    if (lastBackgroundStyle !== state.background) { background.style.background = state.background; lastBackgroundStyle = state.background; }
    if (lastOpacityStyle !== opacity) { canvas.style.opacity = opacity; lastOpacityStyle = opacity; }
    var meta = state.objects.length + "|" + state.background + "|" + opacity;
    if (meta !== lastRenderMeta) { lastRenderMeta = meta; app.events.emit("canvas:rendered", { objects: state.objects.length }); }
  }
  function paintHandle(handle) {
    var grip = handle.key === "rotate";
    selectionContext.save();
    selectionContext.beginPath();
    selectionContext.arc(handle.x, handle.y, handle.radius, 0, Math.PI * 2);
    selectionContext.fillStyle = "#ffffff"; selectionContext.fill();
    selectionContext.lineWidth = 4; selectionContext.strokeStyle = "#e75483"; selectionContext.stroke();
    selectionContext.restore();
    if (grip) paintRotateGlyph(handle.x, handle.y);
  }
  //: An arc with a head, drawn in the circle's own axes so the head stays tangent to the
  //: arc however the selection is turned. This is what separates the one handle that
  //: turns from the four that scale.
  function paintRotateGlyph(x, y) {
    var radius = 12, start = Math.PI * 0.6, end = Math.PI * 1.95;
    selectionContext.save();
    selectionContext.translate(x, y);
    selectionContext.strokeStyle = "#e75483"; selectionContext.fillStyle = "#e75483";
    selectionContext.lineWidth = 3.6; selectionContext.lineCap = "round"; selectionContext.lineJoin = "round";
    selectionContext.beginPath();
    selectionContext.arc(0, 0, radius, start, end);
    selectionContext.stroke();
    selectionContext.translate(Math.cos(end) * radius, Math.sin(end) * radius);
    selectionContext.rotate(end);
    selectionContext.beginPath();
    selectionContext.moveTo(0, 6.75); selectionContext.lineTo(-6.3, -2.25); selectionContext.lineTo(6.3, -2.25);
    selectionContext.closePath(); selectionContext.fill();
    selectionContext.restore();
  }
  function render() {
    if (!context) return;
    contentDirty = true;
    if (frameTask) frameTask.cancel();
    paintFrame();
  }
  function refresh() {
    if (!context) return;
    if (frameTask) frameTask.cancel();
    paintFrame();
  }
  function selectedObject() {
    return state.objects.find(function (object) { return object.id === state.selectedId; }) || null;
  }
  function snapshot() {
    var objects = app.drawing.cloneObjects(state.objects);
    var result = state.result || null;
    // The result travels by reference: each generation replaces it as a whole, and
    // cloning it would copy a multi-hundred-kilobyte data URL into every entry.
    // The containers travel with the objects: a member only names its group, so an
    // entry that kept one without the other would bring a turned group back upright.
    return { objects: objects, groups: app.drawing.cloneGroups(state.groups), background: state.background, result: result,
      _weight: app.drawing.estimateWeight(objects), _resultChars: result && result.src ? String(result.src).length : 0 };
  }
  function cloneSnapshot(value) {
    var objects = value && value.objects || [];
    return { objects: app.drawing.cloneObjects(objects), groups: app.drawing.cloneGroups(value && value.groups),
      background: value && value.background || "#ffffff", result: value && value.result || null,
      _weight: value && value._weight || app.drawing.estimateWeight(objects), _resultChars: value && value._resultChars || 0 };
  }
  function trimHistory() {
    while (state.history.length > HISTORY_MAX_ENTRIES) state.history.shift();
    var weight = 0, resultChars = 0;
    state.history.forEach(function (item) { weight += item._weight || 0; resultChars += item._resultChars || 0; });
    function dropOldest() {
      var removed = state.history.shift();
      weight -= removed._weight || 0; resultChars -= removed._resultChars || 0;
    }
    while (state.history.length > 2 && weight > HISTORY_MAX_WEIGHT) dropOldest();
    while (state.history.length > 2 && resultChars > HISTORY_MAX_RESULT_CHARS) dropOldest();
  }
  function restore(value, options) {
    var data = typeof value === "string" ? app.utils.parseJson(value, { objects: [], background: "#ffffff" }) : cloneSnapshot(value);
    var previousResult = state.result;
    state.objects = app.drawing.cloneObjects(data.objects || []);
    state.groups = app.drawing.cloneGroups(data.groups);
    state.background = data.background || "#ffffff";
    // Only the current result keeps its files on disk: an image that sat in history
    // had its chunks reclaimed the moment a newer one was saved. Carrying that stale
    // reference back would be written into the artwork and break its image on the
    // next load, so the reference is dropped and the next save persists it again.
    // The shell is rebuilt rather than edited because journal entries share the
    // result object and must never be mutated here.
    state.result = data.result ? { src: data.result.src, logicalFileId: data.result.logicalFileId || "",
      slot: data.result.slot, prompt: data.result.prompt, createdAt: data.result.createdAt } : null;
    setSelection([]);
    state.objects.forEach(function (object) { if (object.type === "image") loadImage(object.src || object.url, true); });
    render();
    app.events.emit("history", { undo: state.history.length > 1, redo: state.future.length > 0 });
    emitSelection();
    if (state.result !== previousResult) app.events.emit("result:changed");
    app.services.store.scheduleCanvasSave();
    // Stepping a result back must not immediately ask the model for another one:
    // the automatic pass would overwrite the image the user just recovered.
    if (!options || options.schedule !== false) app.services.imageEngine.schedule();
  }
  function resetHistory() { drawingObject = null; dragging = null; resizing = null; rotating = null; pinching = null; selectionGesture = null; selectionMarquee = null; activePointers = {}; boundsCache = new WeakMap(); state.groups = {}; state.history = [snapshot()]; state.future = []; app.events.emit("history", { undo: false, redo: false }); }
  function commit() { commitEntry("canvas"); app.services.imageEngine.schedule(); }
  // A finished generation is artwork data, so it joins the journal as a step of
  // its own: one Undo goes back to the previous image. The kind tag keeps undo
  // from re-running the engine, which would overwrite the recovered image at once.
  function commitResult() { commitEntry("result"); }
  function commitEntry(kind) {
    var next = snapshot();
    next._kind = kind;
    state.history.push(next); trimHistory();
    state.future = [];
    app.events.emit("history", { undo: state.history.length > 1, redo: false });
    emitSelection();
    app.services.store.scheduleCanvasSave();
  }
  function undo() {
    if (state.history.length <= 1) return;
    var undone = state.history.pop();
    state.future.push(undone);
    restore(state.history[state.history.length - 1], { schedule: undone._kind !== "result" });
  }
  function redo() {
    if (!state.future.length) return;
    var value = state.future.pop();
    state.history.push(value);
    restore(value, { schedule: value._kind !== "result" });
  }
  function removeSelected() {
    var ids = selectionIds(); if (!ids.length) return;
    state.objects = state.objects.filter(function (object) { return ids.indexOf(object.id) < 0; });
    setSelection([]);
    render(); commit();
  }
  function clear() {
    if (!state.objects.length) return;
    state.objects = [];
    setSelection([]);
    render(); commit();
  }
  // Whether the arrows should be live. This is deliberately the same question moveLayer
  // answers internally, so a group can never show an enabled arrow that then does nothing,
  // and the answer flips on its own once the selection reaches the front or the back.
  function canMoveLayer(direction) {
    var ids = new Set(selectionIds());
    if (!ids.size) return false;
    return state.objects.some(function (object, index) {
      if (!ids.has(object.id)) return false;
      var neighbour = index + (direction > 0 ? 1 : -1);
      return neighbour >= 0 && neighbour < state.objects.length && !ids.has(state.objects[neighbour].id);
    });
  }
  // Layer order *is* the order of `state.objects`: each entry paints over the ones before
  // it. A group is only several objects sharing a groupId, and tapping any member selects
  // all of them, so "one layer" has to mean one step of the whole selection rather than one
  // step of a single object. Every selected object therefore passes exactly one unselected
  // neighbour and never another selected one, so the block advances as a unit while keeping
  // its own internal order. Scanning towards the direction of travel is what makes that
  // hold: an entry swapped backwards is never revisited by the same pass.
  function moveLayer(direction) {
    var ids = new Set(selectionIds());
    if (!ids.size) return;
    var moved = false, index, lifted;
    if (direction > 0) {
      for (index = state.objects.length - 2; index >= 0; index -= 1) {
        if (!ids.has(state.objects[index].id) || ids.has(state.objects[index + 1].id)) continue;
        lifted = state.objects.splice(index, 1)[0];
        state.objects.splice(index + 1, 0, lifted);
        moved = true;
      }
    } else {
      for (index = 1; index < state.objects.length; index += 1) {
        if (!ids.has(state.objects[index].id) || ids.has(state.objects[index - 1].id)) continue;
        lifted = state.objects.splice(index, 1)[0];
        state.objects.splice(index - 1, 0, lifted);
        moved = true;
      }
    }
    if (!moved) return;
    render(); commit();
  }
  //: The toolbar's buttons give one factor for both axes, about the middle of the box the handles are
  //: riding: several members scale their container, one object scales its own record.
  function scaleSelected(factor) {
    var objects = selectedObjects(); if (!objects.length) return;
    var limits = transformLimits(objects); if (factor < limits.minimum || factor > limits.maximum) return;
    var node = transformContainer(objects);
    var frame = selectionFrame(objects), centre = { x: frame.x, y: frame.y };
    if (node) scaleContainer(node, factor, factor, centre);
    else {
      var originals = snapshotObjects(objects);
      objects.forEach(function (object, index) { scaleLone(object, originals[index], factor, factor, centre); });
    }
    render(); commit();
  }
  //: Group and Ungroup are about a group, never about the box a selection happens to be wearing. Both
  //: buttons ask this, and the answer turns on one thing only: whether the container the selection is
  //: inside is a real one. A selection that has merely been turned, pulled, carried or pinched is
  //: inside a temporary container like any other, and a temporary container is not a group - so Group
  //: stays live right through a transform, and goes dead exactly when the selection is already one
  //: group, which is the only thing Group could still be asked to do. Reading the container's own flag
  //: rather than asking again what makes a group is what keeps the two from being taken for each
  //: other, and it is what keeps a transform from reaching a button that has nothing to do with it.
  function canGroupSelected() {
    var objects = selectedObjects();
    if (objects.length < 2) return false;
    var node = app.drawing.sharedContainer(objects);
    return !(node && node.formal);
  }
  //: The name of the group an object is really in, or nothing. A container that exists only because
  //: several things are selected has no group behind it, and this is where the two are told apart.
  function formalGroupId(object) {
    var node = object && object.groupId ? app.drawing.groupNode(object.groupId) : null;
    return node && node.formal ? object.groupId : "";
  }
  //: Ungroup takes grouping away, so it is live when any of the selection is already in a real
  //: container and dead when the whole of it is merely several things. A selection that spans two
  //: groups is inside no one container, and the two of them dissolve.
  function canUngroupSelected() {
    var objects = selectedObjects();
    for (var index = 0; index < objects.length; index += 1) { if (formalGroupId(objects[index])) return true; }
    return false;
  }
  //: Grouping makes the container the selection is already in into a real one. Nothing moves and
  //: nothing is re-created: the container keeps the angle and the size it has - which for a selection
  //: that has not been transformed yet is upright and exactly the rectangle around it - and it stops
  //: being taken away when the selection changes. That is the whole difference between a group and a
  //: selection, and it is why a group put away comes back looking like itself.
  function groupSelected() {
    var objects = selectedObjects(); if (objects.length < 2) return;
    containerFor(objects, true).formal = true;
    setSelection(objects.map(function (object) { return object.id; }));
    render(); commit();
  }
  //: Ungrouping takes the container away and folds it into its members, so the picture does not move
  //: by a pixel: the group is gone, its angle and its size are gone with it, and what is left is
  //: exactly what it looked like.
  function ungroupSelected() {
    var objects = selectedObjects();
    //: Only a group, and only ever a group: a container that exists because several things are
    //: selected is not something the user made, so Ungroup has nothing to take away and leaves it
    //: where it is. The button is armed from the same predicate, so the two cannot come apart - which
    //: is exactly what happened when a transform was allowed to answer for a button that is not about
    //: transforming at all.
    var ids = objects.map(formalGroupId).filter(function (id) { return Boolean(id); });
    if (!ids.length) return;
    ids.forEach(function (id, index) { if (ids.indexOf(id) === index) melt(id); });
    setSelection(objects.map(function (object) { return object.id; }));
    render(); commit();
  }
  function duplicateSelected() {
    var objects = selectedObjects(); if (!objects.length) return;
    var copiedGroups = {}, table = groupTable();
    var copies = objects.map(function (object) {
      var copy = app.drawing.cloneObject(object); copy.id = app.utils.id(copy.type);
      if (copy.groupId) { copiedGroups[copy.groupId] = copiedGroups[copy.groupId] || app.utils.id("group"); copy.groupId = copiedGroups[copy.groupId]; }
      translate(copy, 22, 22); return copy;
    });
    //: A copy of a group is a group. The container is copied too, under the new name, so the
    //: duplicate holds the angle and the size of the thing it was copied from instead of being a
    //: set of members naming a container that does not exist.
    Object.keys(copiedGroups).forEach(function (id) {
      var node = app.drawing.groupNode(id); if (!node) return;
      table[copiedGroups[id]] = app.drawing.cloneGroups({ node: node }).node;
    });
    copies.forEach(function (copy) { state.objects.push(copy); }); setSelection(copies.map(function (copy) { return copy.id; })); render(); commit();
  }
  async function addImage(file) {
    if (!file || !file.url) return;
    var image = await loadImage(file.url, false);
    if (!image) throw new Error("无法读取所选图片");
    var scale = Math.min(WIDTH * 0.72 / image.naturalWidth, WIDTH * 0.72 / image.naturalHeight, 1);
    var width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    var object = {
      id: app.utils.id("image"), type: "image", url: file.url, src: file.url,
      logicalFileId: file.logicalFileId || "", name: file.name || "image",
      x: (WIDTH - width) / 2, y: (WIDTH - height) / 2, width: width, height: height
    };
    object._image = image; object._imageSource = file.url;
    state.objects.push(object);
    setSelection([object.id]);
    state.tool = "select";
    render(); commit();
    app.events.emit("tool", "select");
  }
  function isMaskStroke(object) { return Boolean(object && object.type === "stroke" && object.tool === "mask"); }
  //: The generation half — what goes to the model and to the file store, the mask,
  //: the budget and the download — lives in app/components/canvas-io.js, because this
  //: file had grown past 1700 lines. It is handed the paint helpers it needs rather
  //: than reaching into this closure, so the two halves cannot call each other's
  //: internals, and its functions are re-exported below unchanged.
  var io = app.components.canvasIo.create({
    state: state,
    WIDTH: WIDTH,
    isMaskStroke: isMaskStroke,
    drawStroke: function () { return drawStroke.apply(null, arguments); },
    drawPicture: function () { return drawPicture.apply(null, arguments); },
    drawResult: function () { return drawResult.apply(null, arguments); },
    drawCovered: function () { return drawCovered.apply(null, arguments); },
    loadImage: function () { return loadImage.apply(null, arguments); },
    setSelection: function () { return setSelection.apply(null, arguments); },
    render: function () { return render.apply(null, arguments); },
    commit: function () { return commit.apply(null, arguments); },
    resetHistory: function () { return resetHistory.apply(null, arguments); }
  });


  app.components.canvas = {
    init: init,
    render: render,
    refresh: refresh,
    commit: commit,
    commitResult: commitResult,
    undo: undo,
    redo: redo,
    removeSelected: removeSelected,
    clear: clear,
    moveLayer: moveLayer,
    canMoveLayer: canMoveLayer,
    scaleSelected: scaleSelected,
    groupSelected: groupSelected,
    ungroupSelected: ungroupSelected,
    canGroupSelected: canGroupSelected,
    canUngroupSelected: canUngroupSelected,
    duplicateSelected: duplicateSelected,
    addImage: addImage,
    snapshotVisible: io.snapshotVisible,
    composeInput: io.composeInput,
    composeVisibleInput: io.composeVisibleInput,
    composeMask: io.composeMask,
    maskFeatherRadius: io.maskFeatherRadius,
    maskChars: io.maskChars,
    exportVisibleCanvas: io.exportVisibleCanvas,
    exportSource: io.exportSource,
    imageDimensions: io.imageDimensions,
    load: io.load,
    thumbnail: io.thumbnail,
    hasMask: io.hasMask,
    contentCount: io.contentCount,
    maskStrokes: io.maskStrokes,
    clearMask: io.clearMask,
    selectionHandles: function () { return selectionHandles(selectedObjects()); },
    selectionFrame: function () { return selectionFrame(selectedObjects()); },
    resultFilter: resultFilter,
    resultGlowFilter: resultGlowFilter,
    drawResult: drawResult,
    syncSharpenFilter: syncSharpenFilter,
    performance: function () { return { frames: performance.frames, contentRebuilds: performance.contentRebuilds, objectsDrawn: performance.objectsDrawn, imageCache: imageCache.stats(), undoLimit: HISTORY_MAX_UNDO_STEPS, historyEntries: state.history.length, futureEntries: state.future.length }; }
  };
})(window.hamdraw);
