(function (app) {
  "use strict";
  async function run() {
    if (window.location.hash !== "#self-test") return;
    if (!app.platform.haminn.available() && !await app.platform.haminn.awaitReady(2000)) return;
    var runtime = await app.platform.haminn.current().runtime.info();
    if (runtime.launchChannel !== "dev") return;
    var checks = {}, store = app.services.store, canvas = app.components.canvas, editor = app.features.editor, ui = app.components.ui;
    function step(name) { window.__hamdrawSelfTestProgress = name; }
    // A settled state read once, right after the change that causes it, can land
    // before a transition or a style recalc finished and report a spurious
    // failure. Wait for the state to settle with a bounded poll instead, and still
    // assert the value afterwards so a genuinely missing rule stays red.
    async function settled(probe, timeout) {
      var deadline = Date.now() + (timeout || 1200);
      while (!probe() && Date.now() < deadline) await new Promise(function (resolve) { setTimeout(resolve, 40); });
      return probe();
    }
    step("starting");
    await store.flush();
    var stale = store.list().filter(function (item) { return String(item.title || "").indexOf("DEV self-test ") === 0; });
    var currentStale = stale.some(function (item) { return item.id === app.state.workId; });
    for (var staleItem of stale) if (staleItem.id !== app.state.workId) await store.remove(staleItem.id);
    if (currentStale) {
      await store.remove(app.state.workId); editor.resetWork();
      var recoveredItem = store.list()[0];
      if (recoveredItem) { var recovered = await store.hydrate(await store.get(recoveredItem.id)); canvas.load(recovered); editor.syncAll(); }
      await store.flush();
    }
    var original = await store.loadCanvas(), config = app.utils.copy(app.config), originalTool = app.state.tool, tempId = "", originalWorkIds = store.list().map(function (item) { return item.id; });
    try {
      step("drawing"); editor.resetWork(); app.state.autoGenerate = false; app.state.workTitle = "DEV self-test " + Date.now();
      app.state.autoDelayMs = 1320; app.state.resultGlow = 38; app.state.resultClarity = 24; app.state.colorStrength = 0.47; app.state.resultAdjustmentsEnabled = true;
      checks.defaultSeedLocked = app.state.seedLocked === true && Number.isSafeInteger(app.state.seed) && app.state.seed >= 0;
      app.config.quick.endpoint = ""; app.config.quick.protocol = "chp"; app.config.quick.model = ""; app.config.inpaint.endpoint = ""; app.config.upscale.endpoint = "";
      var target = document.getElementById("draft-canvas"), rect = target.getBoundingClientRect();
      var Type = window.PointerEvent || window.MouseEvent;
      function fire(name, x, y, pointerId, isPrimary) {
        target.dispatchEvent(new Type((window.PointerEvent ? "pointer" : "mouse") + name, { bubbles: true, isPrimary: isPrimary !== false, button: 0, pointerId: pointerId || 1, clientX: rect.left + rect.width * x, clientY: rect.top + rect.height * y }));
      }
      function stroke(tool, x, y) { editor.setTool(tool); fire("down", x, y); fire("move", x + 0.15, y + 0.15); fire("up", x + 0.15, y + 0.15); }
      //: The handles are read as a named sequence, not counted. The four corners have to
      //: keep their order - the resize check below indexes the fourth - and the turn
      //: circle has to be there at all, which a bare count cannot tell apart from a
      //: corner that moved.
      function handleKeys() { return canvas.selectionHandles().map(function (handle) { return handle.key; }).join(","); }
      stroke("pencil", .15, .15);
      checks.draw = app.state.objects.length === 1;
      canvas.undo(); checks.undo = app.state.objects.length === 0;
      canvas.redo(); checks.redo = app.state.objects.length === 1;
      editor.setTool("select"); fire("down", .2, .2); fire("up", .2, .2);
      checks.select = Boolean(app.state.selectedId);
      checks.strokeHandles = handleKeys() === "nw,ne,sw,se,rotate";
      canvas.duplicateSelected(); canvas.scaleSelected(1.1); checks.transform = app.state.objects.length === 2;
      var originalStroke = app.state.objects[0], movedStroke = app.state.objects[1];
      var originalStartX = originalStroke.points[0].x, movedStartX = movedStroke.points[0].x;
      fire("down", .24, .24); fire("move", .44, .24); fire("up", .44, .24);
      checks.singleObjectDrag = Math.abs(originalStroke.points[0].x - originalStartX) < 1 && movedStroke.points[0].x > movedStartX + 120;
      fire("down", .2, .2); fire("up", .2, .2);
      checks.tapSelectsOne = app.state.selectedIds.length === 1 && app.state.selectedId === originalStroke.id;
      fire("down", .08, .08); fire("move", .66, .4); fire("up", .66, .4);
      checks.marqueeSelectsMany = app.state.selectedIds.length === 2;
      var groupFirstX = originalStroke.points[0].x, groupSecondX = movedStroke.points[0].x;
      fire("down", .2, .2); fire("move", .26, .25); fire("up", .26, .25);
      checks.groupDrag = originalStroke.points[0].x > groupFirstX + 40 && movedStroke.points[0].x > groupSecondX + 40 && app.state.selectedIds.length === 2;
      app.state.busy = true; app.events.emit("generation:start", { slot: "quality" }); stroke("brush", .4, .4); app.events.emit("generation:idle"); app.state.busy = false;
      checks.drawDuringGeneration = app.state.objects.length === 3;
      app.state.size = 60; stroke("mask", .7, .1);
      var mask = new Image(); mask.src = canvas.composeMask(true);
      await new Promise(function (resolve, reject) { mask.onload = resolve; mask.onerror = reject; });
      var probe = document.createElement("canvas"); probe.width = 768; probe.height = 768;
      var ctx = probe.getContext("2d"); ctx.drawImage(mask, 0, 0);
      checks.maskAlpha = ctx.getImageData(555, 94, 1, 1).data[3] < 20 && ctx.getImageData(20, 20, 1, 1).data[3] === 255;
      stroke("eraser", .7, .1);
      var erasedMask = new Image(); erasedMask.src = canvas.composeMask(true);
      await new Promise(function (resolve, reject) { erasedMask.onload = resolve; erasedMask.onerror = reject; });
      ctx.clearRect(0, 0, 768, 768); ctx.drawImage(erasedMask, 0, 0);
      checks.eraseMask = ctx.getImageData(555, 94, 1, 1).data[3] === 255;
      var tiny = document.createElement("canvas"); tiny.width = 16; tiny.height = 16; var tinyCtx = tiny.getContext("2d"); tinyCtx.fillStyle = "#36a9e8"; tinyCtx.fillRect(0, 0, 16, 16);
      var imageSrc = tiny.toDataURL("image/png");
      await canvas.addImage({ url: imageSrc, name: "self-test.png" });
      var imageObject = app.state.objects.find(function (object) { return object.type === "image"; });
      imageObject.x = 264; imageObject.y = 284; imageObject.width = 240; imageObject.height = 180; canvas.render(); canvas.commit();
      app.state.selectedIds = []; app.state.selectedId = ""; canvas.render();
      var imageBeforeMarquee = { x: imageObject.x, y: imageObject.y };
      fire("down", (imageObject.x + 12) / 768, (imageObject.y + 12) / 768); fire("move", (imageObject.x + imageObject.width + 50) / 768, (imageObject.y + imageObject.height + 50) / 768); fire("up", (imageObject.x + imageObject.width + 50) / 768, (imageObject.y + imageObject.height + 50) / 768);
      checks.imageStartsMarquee = app.state.selectedIds.indexOf(imageObject.id) >= 0 && imageObject.x === imageBeforeMarquee.x && imageObject.y === imageBeforeMarquee.y;
      editor.setTool("select"); app.state.selectedIds = [imageObject.id]; app.state.selectedId = imageObject.id; canvas.render();
      checks.imageHandles = handleKeys() === "nw,ne,sw,se,rotate";
      var handle = canvas.selectionHandles()[3], initialWidth = imageObject.width, initialRatio = imageObject.width / imageObject.height;
      fire("down", handle.x / 768, handle.y / 768); fire("move", (handle.x + 76) / 768, (handle.y + 57) / 768); fire("up", (handle.x + 76) / 768, (handle.y + 57) / 768);
      checks.cornerResize = imageObject.width > initialWidth * 1.2 && Math.abs(imageObject.width / imageObject.height - initialRatio) < 0.01;
      // A corner pull is two drags, not one: pull further across than down and the box must come out
      // longer than it was tall - the ratio is meant to change, which is what four independent
      // corners are for - while the corner opposite stays exactly where the box promised it was.
      var stretchedHandle = canvas.selectionHandles()[3], pinnedBefore = canvas.selectionHandles()[0];
      var stretchedWidth = imageObject.width, stretchedHeight = imageObject.height;
      fire("down", stretchedHandle.x / 768, stretchedHandle.y / 768); fire("move", (stretchedHandle.x + 120) / 768, (stretchedHandle.y + 20) / 768); fire("up", (stretchedHandle.x + 120) / 768, (stretchedHandle.y + 20) / 768);
      var pinnedAfter = canvas.selectionHandles()[0];
      checks.cornerResizeTwoAxes = Math.abs(imageObject.width - (stretchedWidth + 120)) < 1 && Math.abs(imageObject.height - (stretchedHeight + 20)) < 1
        && Math.abs(imageObject.width / imageObject.height - stretchedWidth / stretchedHeight) > 0.05;
      checks.cornerResizeHoldsOpposite = Math.abs(pinnedAfter.x - pinnedBefore.x) < 1 && Math.abs(pinnedAfter.y - pinnedBefore.y) < 1;
      // That pull is a step of the journal of its own, so it is taken back here: the checks below
      // count on the journal standing exactly where the first pull left it, and an extra entry
      // would make the next undo land on the wrong state.
      canvas.undo(); imageObject = app.state.objects.find(function (object) { return object.type === "image"; }); canvas.render();
      var resizedWidth = imageObject.width; canvas.undo(); var undoneImage = app.state.objects.find(function (object) { return object.type === "image"; });
      checks.resizeUndo = Math.abs(undoneImage.width - initialWidth) < 1; canvas.redo(); imageObject = app.state.objects.find(function (object) { return object.type === "image"; });
      checks.resizeRedo = Math.abs(imageObject.width - resizedWidth) < 1;
      app.state.selectedIds = [imageObject.id]; app.state.selectedId = imageObject.id; canvas.render();
      var centerX = (imageObject.x + imageObject.width / 2) / 768, centerY = (imageObject.y + imageObject.height / 2) / 768, pinchWidth = imageObject.width, pinchRatio = imageObject.width / imageObject.height;
      fire("down", centerX - 0.06, centerY, 1, true); fire("down", centerX + 0.06, centerY, 2, false);
      fire("move", centerX - 0.1, centerY - 0.02, 1, true); fire("move", centerX + 0.1, centerY + 0.02, 2, false); fire("up", centerX + 0.1, centerY + 0.02, 2, false);
      // Both axes together is the promise a pinch makes, so the shape it holds is the shape the
      // pinch began with - read here rather than from the picture's first size, since a corner pull
      // is allowed to have changed that in between.
      checks.pinchScale = imageObject.width > pinchWidth * 1.45 && Math.abs(imageObject.width / imageObject.height - pinchRatio) < 0.01;
      // The turn circle is driven through the same synthetic events as everything else, so
      // the whole path runs: the hit test, the snapshot, the per-frame rebuild, the commit.
      // Three drags that differ only in how far they go separate the three promises - a
      // quarter turn lands exactly on sideways, a few degrees of residue is absorbed rather
      // than left behind forever, and a real turn is not.
      app.state.selectedIds = [imageObject.id]; app.state.selectedId = imageObject.id; canvas.render();
      function turnGrip() { return canvas.selectionHandles().filter(function (handle) { return handle.key === "rotate"; })[0]; }
      function cornerGrip(key) { return canvas.selectionHandles().filter(function (handle) { return handle.key === key; })[0]; }
      //: Where a member is really drawn, read the way the canvas paints it - its own placement and
      //: then its container's - and the container a member names, which is where a group's angle and
      //: its size live now that a member only references one.
      function drawnCentre(object) { var box = app.drawing.bounds(object); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; }
      function containerOf(object) { return object && object.groupId ? app.drawing.groupNode(object.groupId) : null; }
      function containerCount() { return Object.keys(app.state.groups || {}).length; }
      function turnBy(degrees) {
        var grip = turnGrip();
        if (!grip) return false;
        var centre = { x: imageObject.x + imageObject.width / 2, y: imageObject.y + imageObject.height / 2 };
        var radius = Math.sqrt(Math.pow(grip.x - centre.x, 2) + Math.pow(grip.y - centre.y, 2));
        var from = Math.atan2(grip.y - centre.y, grip.x - centre.x), to = from + degrees * Math.PI / 180;
        var land = { x: centre.x + Math.cos(to) * radius, y: centre.y + Math.sin(to) * radius };
        fire("down", grip.x / 768, grip.y / 768); fire("move", land.x / 768, land.y / 768); fire("up", land.x / 768, land.y / 768);
        return true;
      }
      var turnCentre = { x: imageObject.x + imageObject.width / 2, y: imageObject.y + imageObject.height / 2 };
      var gripBefore = turnGrip();
      checks.turnHandleBelowBox = Boolean(gripBefore) && gripBefore.y > imageObject.y + imageObject.height && Math.abs(gripBefore.x - turnCentre.x) < 0.5;
      // Half again the circle it was, and a reach to match: a bigger picture that had kept the old
      // target would be the one change nobody could feel.
      checks.turnHandleSize = Boolean(gripBefore) && gripBefore.radius === 27 && gripBefore.reach === 60;
      // The owner's number for where the circle sits, read off the phone's own box rather than off
      // the constant: it hangs 56 below the bottom edge, half of what it hung.
      var gripFrame = canvas.selectionFrame();
      checks.turnHandleGap = Boolean(gripBefore) && Math.abs(gripBefore.y - (gripFrame.y + gripFrame.height / 2) - 56) < 1;
      checks.quarterTurn = turnBy(90) && Math.abs(app.drawing.normalizeAngle(app.drawing.rotationOf(imageObject) - Math.PI / 2)) < 0.002;
      checks.turnSnapsUpright = turnBy(3) && Math.abs(app.drawing.normalizeAngle(app.drawing.rotationOf(imageObject) - Math.PI / 2)) < 0.002;
      checks.turnFollowsPointer = turnBy(-40) && Math.abs(app.drawing.normalizeAngle(app.drawing.rotationOf(imageObject) - Math.PI / 2) + 40 * Math.PI / 180) < 0.01;
      // A turn is a step of the journal of its own, and one turn is one step: the first undo takes
      // back the drag that was just made and leaves the quarter turn standing, and it takes the
      // second to bring the picture level again. Reading it as one undo for both would pass on a
      // build that folded the two drags into one entry.
      canvas.undo(); var lastTurnBack = app.state.objects.find(function (object) { return object.type === "image"; });
      checks.turnUndo = Math.abs(app.drawing.normalizeAngle(app.drawing.rotationOf(lastTurnBack) - Math.PI / 2)) < 0.002;
      canvas.undo(); var levelImage = app.state.objects.find(function (object) { return object.type === "image"; });
      checks.turnUndoToLevel = Math.abs(app.drawing.rotationOf(levelImage)) < 0.002;
      canvas.redo(); canvas.redo(); imageObject = app.state.objects.find(function (object) { return object.type === "image"; });
      checks.turnRedo = Math.abs(app.drawing.normalizeAngle(app.drawing.rotationOf(imageObject) - Math.PI / 2) + 40 * Math.PI / 180) < 0.01;
      // A turn about the centre of the box has to leave the centre where it was, or the
      // picture would walk across the canvas while being turned.
      var turnedBounds = app.drawing.bounds(imageObject);
      checks.turnKeepsCentre = Math.abs(turnedBounds.x + turnedBounds.width / 2 - turnCentre.x) < 1 && Math.abs(turnedBounds.y + turnedBounds.height / 2 - turnCentre.y) < 1;
      //: A lone object turns itself and is in no container at all - which is what makes the next
      //: section's container something that only a selection of several can have.
      checks.turnMakesNoContainer = containerCount() === 0;
      var strokeObject = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      app.state.selectedIds = [strokeObject.id, imageObject.id]; app.state.selectedId = imageObject.id; canvas.render();
      checks.multiSelectionHandles = handleKeys() === "nw,ne,sw,se,rotate";
      // A selection of several is put into a container the first time it is transformed, and what is
      // transformed is the container: one turn about one centre, with not one number of any member's
      // own record touched. The members are left disagreeing on purpose - the picture is at the angle
      // the last drag gave it and the stroke is upright - which is exactly the case that used to make
      // the box give up and re-fit itself, so the box stopped following the selection it was drawing.
      var strokePointBefore = { x: strokeObject.points[0].x, y: strokeObject.points[0].y };
      var groupPictureAngle = app.drawing.rotationOf(imageObject);
      var groupRecordBefore = { x: imageObject.x, y: imageObject.y, width: imageObject.width, height: imageObject.height };
      var groupDrawnBefore = [imageObject, strokeObject].map(drawnCentre);
      checks.noContainerBeforeGroupTurn = containerCount() === 0;
      var groupFrameBefore = canvas.selectionFrame(), groupGrip = turnGrip();
      var groupCentre = { x: groupFrameBefore.x, y: groupFrameBefore.y };
      var groupRadius = Math.sqrt(Math.pow(groupGrip.x - groupCentre.x, 2) + Math.pow(groupGrip.y - groupCentre.y, 2));
      var groupFrom = Math.atan2(groupGrip.y - groupCentre.y, groupGrip.x - groupCentre.x), groupTo = groupFrom + Math.PI / 2;
      var groupLand = { x: groupCentre.x + Math.cos(groupTo) * groupRadius, y: groupCentre.y + Math.sin(groupTo) * groupRadius };
      fire("down", groupGrip.x / 768, groupGrip.y / 768); fire("move", groupLand.x / 768, groupLand.y / 768); fire("up", groupLand.x / 768, groupLand.y / 768);
      var groupStroke = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      var groupPicture = app.state.objects.find(function (object) { return object.type === "image"; });
      var groupNode = containerOf(groupPicture);
      checks.groupTurnSharesContainer = Boolean(groupNode) && containerCount() === 1 && groupStroke.groupId === groupPicture.groupId && app.drawing.groupNode(groupStroke.groupId) === groupNode;
      checks.groupTurnContainerAngle = Boolean(groupNode) && Math.abs(app.drawing.normalizeAngle(app.drawing.placement.angleOf(groupNode.m) - Math.PI / 2)) < 1e-9;
      checks.groupTurnKeepsOwnAngle = Math.abs(app.drawing.rotationOf(groupPicture) - groupPictureAngle) < 1e-12 && groupStroke.rotation === undefined && groupStroke.linear === undefined;
      checks.groupTurnMovesNothing = groupStroke.points[0].x === strokePointBefore.x && groupStroke.points[0].y === strokePointBefore.y
        && groupPicture.x === groupRecordBefore.x && groupPicture.y === groupRecordBefore.y && groupPicture.width === groupRecordBefore.width && groupPicture.height === groupRecordBefore.height;
      // The box is the container's own rectangle carried by the container's own placement - never a
      // rectangle measured afresh around what happens to be inside it, and never a guess at whether
      // the members agree on an angle. A box built from either of those is the box that comes loose
      // from the group the moment the group is turned.
      var groupFrameAfter = canvas.selectionFrame();
      checks.groupBoxIsContainer = Boolean(groupNode) && Math.abs(groupFrameAfter.angle - app.drawing.placement.angleOf(groupNode.m)) < 1e-9
        && Math.abs(groupFrameAfter.width - groupNode.rect.width) < 1e-9 && Math.abs(groupFrameAfter.height - groupNode.rect.height) < 1e-9;
      // The same promise read the other way round, on the two members themselves: each is drawn where
      // the quarter turn put it - its drawn centre carried round the group's centre - so the whole
      // selection moved as one rigid piece rather than each member turning about its own centre.
      var groupDrawnAfter = [groupPicture, groupStroke].map(drawnCentre);
      checks.groupTurnCarriesWhole = groupDrawnAfter.every(function (centre, index) {
        var carriedX = groupCentre.x - (groupDrawnBefore[index].y - groupCentre.y), carriedY = groupCentre.y + (groupDrawnBefore[index].x - groupCentre.x);
        return Math.abs(centre.x - carriedX) < 1 && Math.abs(centre.y - carriedY) < 1;
      });
      // The two buttons the owner asked about, read from the page itself. 成组 and 解散 are about a
      // group, never about the box a selection happens to be wearing: this selection has just been
      // turned, so it is inside a container - and a temporary one, which is not a group - and the two
      // buttons must read exactly as they did before the turn. Before the fix the first transform of a
      // selection switched 成组 off and 解散 on, as though the box were a group. Read after two frames,
      // because the selection the buttons are armed from arrives through a frame task.
      var groupButton = document.getElementById("group-selected"), ungroupButton = document.getElementById("ungroup-selected");
      function buttonsSettled() { return new Promise(function (resolve) { requestAnimationFrame(function () { requestAnimationFrame(resolve); }); }); }
      await buttonsSettled();
      checks.groupButtonsOnTemporaryContainer = containerCount() === 1 && groupNode.formal === false
        && canvas.canGroupSelected() === true && canvas.canUngroupSelected() === false
        && groupButton.disabled === false && ungroupButton.disabled === true;
      // And 解散 on a mere selection has to leave its container standing rather than fold a transform
      // the user is in the middle of into the members - the same mistake read from the other side, and
      // the reason the predicate is asked by the mutator and not only by the button.
      var refuseFrame = canvas.selectionFrame();
      canvas.ungroupSelected();
      checks.ungroupRefusesTemporaryContainer = containerCount() === 1 && Boolean(containerOf(groupPicture)) && containerOf(groupPicture).formal === false
        && app.state.selectedIds.length === 2 && Math.abs(canvas.selectionFrame().angle - refuseFrame.angle) < 1e-12;
      // Taken on its own a member is boxed by its own record carried by its whole placement - its own
      // turn and the container's - so it comes back at the angle it is drawn at and at its own size.
      // Reading the container's angle alone put the box at half the turn.
      app.state.selectedIds = [groupPicture.id]; app.state.selectedId = groupPicture.id; canvas.render();
      var loneTurnedFrame = canvas.selectionFrame();
      checks.groupTurnLoneBox = Boolean(groupNode) && Math.abs(loneTurnedFrame.angle - app.drawing.normalizeAngle(app.drawing.rotationOf(groupPicture) + app.drawing.placement.angleOf(groupNode.m))) < 1e-9
        && Math.abs(loneTurnedFrame.width - groupPicture.width) < 1e-9 && Math.abs(loneTurnedFrame.height - groupPicture.height) < 1e-9;
      app.state.selectedIds = [groupStroke.id, groupPicture.id]; app.state.selectedId = groupPicture.id; canvas.render();
      // A corner pull on that same selection is still the two-axis pull it has always been, and it is
      // one stretch for the whole selection because it is written on the container. The finger travels
      // along the box's own top edge, which on a turned box is not the screen's, and every point of
      // the stroke must land where a stretch of the box's own axes puts it - while the picture's own
      // record is not touched at all, which is what "the container is what is transformed" means.
      var pullFrame = canvas.selectionFrame(), pullPin = cornerGrip("nw"), pullGrabbed = cornerGrip("se");
      var pullPictureBefore = { x: groupPicture.x, y: groupPicture.y, width: groupPicture.width, height: groupPicture.height, rotation: app.drawing.rotationOf(groupPicture) };
      var pullInkBefore = groupStroke.points.map(function (point) { return app.drawing.placement.apply(app.drawing.placedMap(groupStroke), point.x, point.y); });
      var pullReach = 0.6 * pullFrame.width;
      var pullAway = { x: pullGrabbed.x + pullReach * Math.cos(pullFrame.angle), y: pullGrabbed.y + pullReach * Math.sin(pullFrame.angle) };
      fire("down", pullGrabbed.x / 768, pullGrabbed.y / 768); fire("move", pullAway.x / 768, pullAway.y / 768); fire("up", pullAway.x / 768, pullAway.y / 768);
      var pulledPicture = app.state.objects.find(function (object) { return object.type === "image"; });
      var pulledStroke = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      var pullInkAfter = pulledStroke.points.map(function (point) { return app.drawing.placement.apply(app.drawing.placedMap(pulledStroke), point.x, point.y); });
      var pullCos = Math.cos(pullFrame.angle), pullSin = Math.sin(pullFrame.angle);
      checks.mixedGroupPullIsPerAxis = pullInkBefore.every(function (point, index) {
        var sideX = (point.x - pullPin.x) * pullCos + (point.y - pullPin.y) * pullSin, sideY = -(point.x - pullPin.x) * pullSin + (point.y - pullPin.y) * pullCos;
        var want = { x: pullPin.x + sideX * 1.6 * pullCos - sideY * pullSin, y: pullPin.y + sideX * 1.6 * pullSin + sideY * pullCos };
        return Math.abs(pullInkAfter[index].x - want.x) < 1e-6 && Math.abs(pullInkAfter[index].y - want.y) < 1e-6;
      }) && pulledPicture.x === pullPictureBefore.x && pulledPicture.y === pullPictureBefore.y && pulledPicture.width === pullPictureBefore.width
        && pulledPicture.height === pullPictureBefore.height && app.drawing.rotationOf(pulledPicture) === pullPictureBefore.rotation;
      var pulledFrame = canvas.selectionFrame();
      checks.pullIsWrittenOnTheContainer = Math.abs(pulledFrame.width - pullFrame.width * 1.6) < 1e-6 && Math.abs(pulledFrame.height - pullFrame.height) < 1e-6;
      canvas.undo();
      // An undo hands back new records rather than the ones it took away, so every reading after it
      // has to be taken again from the canvas: a reference kept from before the undo would go on
      // describing an object the canvas no longer has, and the checks below it would read a stale one.
      imageObject = app.state.objects.find(function (object) { return object.type === "image"; });
      strokeObject = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      app.state.selectedIds = [strokeObject.id, imageObject.id]; app.state.selectedId = imageObject.id; canvas.render();
      // The container exists only because these two happen to be selected. The moment the selection is
      // not theirs the container is folded into its members and gone - an empty tap is the real path,
      // since it is the selection that answers for the containers - and each member keeps exactly what
      // it drew, which is why nothing on screen moves when it happens.
      var releaseDrawnBefore = [imageObject, strokeObject].map(drawnCentre);
      fire("down", .02, .98); fire("up", .02, .98);
      var releasedPicture = app.state.objects.find(function (object) { return object.type === "image"; });
      var releasedStroke = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      var releaseDrawnAfter = [releasedPicture, releasedStroke].map(drawnCentre);
      checks.temporaryContainerReleased = app.state.selectedIds.length === 0 && containerCount() === 0 && !releasedPicture.groupId && !releasedStroke.groupId
        && releaseDrawnAfter.every(function (centre, index) { return Math.abs(centre.x - releaseDrawnBefore[index].x) < 1e-6 && Math.abs(centre.y - releaseDrawnBefore[index].y) < 1e-6; });
      // And the placement it was drawn through has gone onto the member, in the record an ordinary
      // object has always had: the whole turn is the member's own angle now.
      checks.releaseKeepsTheAngle = Math.abs(app.drawing.normalizeAngle(app.drawing.rotationOf(releasedPicture) - groupPictureAngle - Math.PI / 2)) < 1e-9
        && Math.abs(app.drawing.normalizeAngle(app.drawing.rotationOf(releasedStroke) - Math.PI / 2)) < 1e-9;
      // 成组 turns the container the selection is already in into a real group. The owner's requirement
      // is that the turn of the selection is unchanged by it, so the box must come back exactly as it
      // was - which means grouping must re-aim nothing and re-measure nothing.
      app.state.selectedIds = [releasedStroke.id, releasedPicture.id]; app.state.selectedId = releasedPicture.id; canvas.render();
      var formalFrameBefore = canvas.selectionFrame();
      canvas.groupSelected();
      var groupedPicture = app.state.objects.find(function (object) { return object.type === "image"; });
      var groupedStroke = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      var groupedNode = containerOf(groupedPicture);
      var formalFrameAfter = canvas.selectionFrame();
      checks.groupIsFormal = Boolean(groupedNode) && groupedNode.formal === true && groupedStroke.groupId === groupedPicture.groupId;
      checks.groupKeepsTransform = Math.abs(formalFrameAfter.angle - formalFrameBefore.angle) < 1e-12
        && Math.abs(formalFrameAfter.width - formalFrameBefore.width) < 1e-12 && Math.abs(formalFrameAfter.height - formalFrameBefore.height) < 1e-12;
      // Now they really are a group, so the two swap over: 成组 has nothing left to do and 解散 has.
      await buttonsSettled();
      checks.groupButtonsOnAGroup = canvas.canGroupSelected() === false && canvas.canUngroupSelected() === true
        && groupButton.disabled === true && ungroupButton.disabled === false;
      // Transforming the group transforms the group: the container's placement moves and the two
      // children are not touched at all. That is the difference between a group and a pile of objects,
      // and it is what the owner asked for by name.
      var groupChildrenBefore = [JSON.stringify(groupedPicture), JSON.stringify(groupedStroke)];
      canvas.scaleSelected(1.25);
      var scaledPicture = app.state.objects.find(function (object) { return object.type === "image"; });
      var scaledStroke = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      checks.groupScaleMovesContainerOnly = JSON.stringify(scaledPicture) === groupChildrenBefore[0] && JSON.stringify(scaledStroke) === groupChildrenBefore[1]
        && Math.abs(app.drawing.placement.axesOf(containerOf(scaledPicture).m)[0] - 1.25) < 1e-9;
      canvas.undo();
      groupedPicture = app.state.objects.find(function (object) { return object.type === "image"; });
      groupedStroke = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      app.state.selectedIds = [groupedStroke.id, groupedPicture.id]; app.state.selectedId = groupedPicture.id; canvas.render();
      // A group that has been turned can still be carried, and carrying it carries the group. The
      // owner reported the opposite of this: several objects turned and then moved, with the box left
      // standing where it was and only the members wandering off inside it. The displacement has to go
      // onto the container's own placement, on the *outside* - where a point of the drawing lands where
      // the finger put it whatever the container has been turned to - and no member may be written to.
      // Both the box and the ink are read, because either one alone can be right by accident.
      function drawnCorners(object) { return app.drawing.placement.corners(app.drawing.placedMap(object), app.drawing.localBounds(object)); }
      var carryFrameBefore = canvas.selectionFrame();
      var carryNodeBefore = containerOf(groupedPicture).m.slice();
      var carryChildrenBefore = [JSON.stringify(groupedPicture), JSON.stringify(groupedStroke)];
      var carryDrawnBefore = [groupedPicture, groupedStroke].map(drawnCorners);
      fire("down", carryFrameBefore.x / 768, carryFrameBefore.y / 768);
      fire("move", (carryFrameBefore.x + 44) / 768, (carryFrameBefore.y + 58) / 768);
      fire("up", (carryFrameBefore.x + 44) / 768, (carryFrameBefore.y + 58) / 768);
      var carriedPicture = app.state.objects.find(function (object) { return object.type === "image"; });
      var carriedStroke = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      var carryFrameAfter = canvas.selectionFrame(), carryNodeAfter = containerOf(carriedPicture).m;
      var carryDrawnAfter = [carriedPicture, carriedStroke].map(drawnCorners);
      checks.groupCarryMovesContainer = Math.abs(carryNodeAfter[4] - carryNodeBefore[4] - 44) < 1e-9 && Math.abs(carryNodeAfter[5] - carryNodeBefore[5] - 58) < 1e-9
        && Math.abs(carryNodeAfter[0] - carryNodeBefore[0]) < 1e-9 && Math.abs(carryNodeAfter[3] - carryNodeBefore[3]) < 1e-9;
      checks.groupCarryMovesBox = Math.abs(carryFrameAfter.x - carryFrameBefore.x - 44) < 1e-9 && Math.abs(carryFrameAfter.y - carryFrameBefore.y - 58) < 1e-9
        && Math.abs(carryFrameAfter.angle - carryFrameBefore.angle) < 1e-12 && Math.abs(carryFrameAfter.width - carryFrameBefore.width) < 1e-12
        && Math.abs(carryFrameAfter.height - carryFrameBefore.height) < 1e-12;
      checks.groupCarryMovesInk = carryDrawnAfter.every(function (corners, index) {
        return corners.every(function (point, which) {
          return Math.abs(point.x - carryDrawnBefore[index][which].x - 44) < 1e-9 && Math.abs(point.y - carryDrawnBefore[index][which].y - 58) < 1e-9;
        });
      });
      checks.groupCarryMovesNoChild = JSON.stringify(carriedPicture) === carryChildrenBefore[0] && JSON.stringify(carriedStroke) === carryChildrenBefore[1];
      // Two fingers on that group scale it and carry it, and they do it through the container for the
      // same reason. A pinch has one number to give and not two, so both of the container's axes must
      // take the same one. Both fingers come down *inside* the box - that is what a pair is answered on
      // - so the four points are aimed in the box's own frame, which on a turned box is not the screen's,
      // and the point between them starts off the box's centre and ends somewhere else so that the scale
      // and the carry are both asked for.
      function inBox(localX, localY) {
        var box = canvas.selectionFrame(), cos = Math.cos(box.angle), sin = Math.sin(box.angle);
        return { x: box.x + localX * cos - localY * sin, y: box.y + localX * sin + localY * cos };
      }
      var pinchChildrenBefore = [JSON.stringify(carriedPicture), JSON.stringify(carriedStroke)];
      var pinchFrameBefore = canvas.selectionFrame(), pinchNodeBefore = containerOf(carriedPicture).m.slice();
      var pinchDrawnBefore = [carriedPicture, carriedStroke].map(drawnCorners);
      var fingerA0 = inBox(-70, 15), fingerB0 = inBox(50, -35), fingerA1 = inBox(-130, 5), fingerB1 = inBox(110, -55);
      var fingerFrom = { x: (fingerA0.x + fingerB0.x) / 2, y: (fingerA0.y + fingerB0.y) / 2 };
      var fingerTo = { x: (fingerA1.x + fingerB1.x) / 2, y: (fingerA1.y + fingerB1.y) / 2 };
      var fingerFactor = Math.sqrt(Math.pow(fingerB1.x - fingerA1.x, 2) + Math.pow(fingerB1.y - fingerA1.y, 2))
        / Math.sqrt(Math.pow(fingerB0.x - fingerA0.x, 2) + Math.pow(fingerB0.y - fingerA0.y, 2));
      fire("down", fingerA0.x / 768, fingerA0.y / 768, 1, true); fire("down", fingerB0.x / 768, fingerB0.y / 768, 2, false);
      fire("move", fingerA1.x / 768, fingerA1.y / 768, 1, true); fire("move", fingerB1.x / 768, fingerB1.y / 768, 2, false);
      fire("up", fingerA1.x / 768, fingerA1.y / 768, 1, true); fire("up", fingerB1.x / 768, fingerB1.y / 768, 2, false);
      var pinchedPicture = app.state.objects.find(function (object) { return object.type === "image"; });
      var pinchedStroke = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      var pinchFrameAfter = canvas.selectionFrame(), pinchNodeAfter = containerOf(pinchedPicture).m;
      var pinchDrawnAfter = [pinchedPicture, pinchedStroke].map(drawnCorners);
      checks.groupPinchScalesContainer = Math.abs(app.drawing.placement.axesOf(pinchNodeAfter)[0] - app.drawing.placement.axesOf(pinchNodeBefore)[0] * fingerFactor) < 1e-9
        && Math.abs(pinchFrameAfter.width / pinchFrameBefore.width - fingerFactor) < 1e-9 && Math.abs(pinchFrameAfter.height / pinchFrameBefore.height - fingerFactor) < 1e-9;
      checks.groupPinchOneFactor = Math.abs(app.drawing.placement.axesOf(pinchNodeAfter)[0] - app.drawing.placement.axesOf(pinchNodeAfter)[1]) < 1e-9
        && Math.abs(pinchFrameAfter.angle - pinchFrameBefore.angle) < 1e-9;
      checks.groupPinchMovesInk = pinchDrawnAfter.every(function (corners, index) {
        return corners.every(function (point, which) {
          var was = pinchDrawnBefore[index][which];
          return Math.abs(point.x - (fingerTo.x + (was.x - fingerFrom.x) * fingerFactor)) < 1e-9
            && Math.abs(point.y - (fingerTo.y + (was.y - fingerFrom.y) * fingerFactor)) < 1e-9;
        });
      });
      checks.groupPinchMovesNoChild = JSON.stringify(pinchedPicture) === pinchChildrenBefore[0] && JSON.stringify(pinchedStroke) === pinchChildrenBefore[1];
      // A group is a group again here, and every step above transformed it - so the two buttons have to
      // read exactly as they did when it was made. That is the other half of the owner's rule: a
      // transform must not reach these buttons, and a real group must hold them where they are. The box
      // is compared with the one the group was made with, so this cannot be passing because nothing has
      // happened in between.
      var transformedFrame = canvas.selectionFrame();
      await buttonsSettled();
      checks.groupButtonsBlindToGroup = containerCount() === 1 && Boolean(containerOf(pinchedPicture)) && containerOf(pinchedPicture).formal === true
        && Math.abs(transformedFrame.width - formalFrameBefore.width) > 1
        && canvas.canGroupSelected() === false && canvas.canUngroupSelected() === true
        && groupButton.disabled === true && ungroupButton.disabled === false;
      // 解散 deletes the group itself and lets its members inherit it - it is not "the group's angle
      // has gone" but "the group is gone" - so what is left is exactly what it looked like.
      var dissolveDrawnBefore = [pinchedPicture, pinchedStroke].map(drawnCentre);
      canvas.ungroupSelected();
      var leftPicture = app.state.objects.find(function (object) { return object.type === "image"; });
      var leftStroke = app.state.objects.find(function (object) { return object.type === "stroke" && object.tool === "pencil"; });
      var dissolveDrawnAfter = [leftPicture, leftStroke].map(drawnCentre);
      checks.ungroupDeletesGroup = containerCount() === 0 && !leftPicture.groupId && !leftStroke.groupId
        && dissolveDrawnAfter.every(function (centre, index) { return Math.abs(centre.x - dissolveDrawnBefore[index].x) < 1e-6 && Math.abs(centre.y - dissolveDrawnBefore[index].y) < 1e-6; });
      // 解散 hands the selection back as several things again, so the pair of buttons goes back to
      // 成组 live and 解散 dead - the same reading the selection started with.
      await buttonsSettled();
      checks.groupButtonsAfterDissolve = canvas.canGroupSelected() === true && canvas.canUngroupSelected() === false
        && groupButton.disabled === false && ungroupButton.disabled === true;
      imageObject = leftPicture; strokeObject = leftStroke;
      app.state.selectedIds = [strokeObject.id, imageObject.id]; app.state.selectedId = imageObject.id; canvas.render();
      // The top bar must show the app's own icon rather than a letter standing in for it.
      var brandImage = document.querySelector(".brand-mark img");
      checks.brandIcon = Boolean(brandImage) && /app\/assets\/icon\.webp/.test(brandImage.getAttribute("src"));
      app.components.settings.openColor("selection");
      var selectionOpacity = document.querySelector('[name="colorOpacity"]'); selectionOpacity.value = "61"; document.querySelector("[data-save]").click();
      checks.selectionColorOpacity = strokeObject.opacity === 0.61 && imageObject.opacity === undefined;
      app.state.result = { src: imageSrc, slot: "quick", prompt: "self-test", createdAt: Date.now() };
      editor.syncCanvas();
      var resultOpacity = document.getElementById("result-opacity"); resultOpacity.value = "42"; resultOpacity.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      checks.resultOpacity = Math.abs(app.state.resultOpacity - 0.42) < 0.001 && document.getElementById("result-opacity-value").textContent === "42%" && document.getElementById("result-image").style.opacity === "0.42";
      app.state.resultOpacity = 0.05; app.state.result = { src: imageSrc, slot: "quick", prompt: "self-test", createdAt: Date.now() }; app.events.emit("generation:done", app.state.result); await new Promise(function (resolve) { setTimeout(resolve, 560); });
      checks.resultOpacityFloor = Math.abs(app.state.resultOpacity - 0.2) < 0.001 && document.getElementById("result-image").style.opacity === "0.2";
      document.getElementById("result-visibility").click(); checks.resultVisibility = app.state.resultVisible === false && document.getElementById("result-image").hidden;
      document.getElementById("result-visibility").click();
      // A finished generation is an undoable step: Undo steps the result back to
      // the previous image and Redo brings the newer one back. The render is not
      // part of that journal, so stepping through results must leave it alone.
      step("result-history");
      var secondResult = { src: imageSrc, slot: "quick", prompt: "self-test second", createdAt: Date.now() };
      var previousResultForUndo = app.state.result;
      app.state.result = secondResult; canvas.commitResult();
      app.state.renderResult = { src: imageSrc, logicalFileId: "", slot: "upscale", createdAt: Date.now() }; editor.syncAll();
      canvas.undo();
      // Stepping back rebuilds the result and drops its file reference, so the image
      // is identified by its data, not by object identity.
      checks.resultUndo = Boolean(app.state.result) && app.state.result.src === previousResultForUndo.src && app.state.result.prompt === "self-test";
      checks.resultUndoRef = Boolean(app.state.result) && !app.state.result.asset;
      checks.renderOutsideUndo = Boolean(app.state.renderResult && app.state.renderResult.slot === "upscale");
      canvas.redo();
      checks.resultRedo = Boolean(app.state.result) && app.state.result.src === secondResult.src;
      // A local redraw is a generation like any other, so it lands in the journal the
      // same way: one Undo returns the image the redraw replaced. Driven through
      // generation:done so the editor's own branch decides, not this test.
      step("inpaint-history");
      var beforeInpaint = app.state.result;
      app.state.result = { src: imageSrc, slot: "inpaint", prompt: "self-test inpaint", createdAt: Date.now() };
      app.events.emit("generation:done", app.state.result);
      await new Promise(function (resolve) { setTimeout(resolve, 30); });
      canvas.undo();
      checks.inpaintUndo = Boolean(app.state.result) && app.state.result.src === beforeInpaint.src;
      canvas.redo();
      checks.inpaintRedo = Boolean(app.state.result) && app.state.result.slot === "inpaint";
      canvas.undo();
      var resultVisibleBefore = app.state.resultVisible, toolBefore = app.state.tool === "mask" ? "pencil" : app.state.tool;
      editor.setTool("mask"); editor.syncCanvas();
      // Entering local mode has to say what to do next in the one line the user
      // reads, not leave them to discover the two-step flow by trial.
      checks.maskHint = document.getElementById("status-line").textContent === app.i18n.text("直接屏幕绘制，然后用局部提示词修改绘制的区域", "Draw straight on the screen, then use the local prompt to change the drawn area");
      // The local tool is a switch, not a one-way door: the same button that opens
      // it must put it away and hand the canvas back to the select tool.
      document.querySelector('[data-tool="mask"]').click();
      checks.maskToolTogglesOff = app.state.maskMode === false && app.state.tool === "select";
      editor.setTool("mask"); editor.syncCanvas();
      var maskSlider = document.getElementById("result-opacity"), maskEye = document.getElementById("result-visibility"), maskLabel = document.getElementById("opacity-target-label");
      // Labels are compared through the translator so the checks hold in either language.
      checks.maskControlsRelabelled = app.state.maskMode === true && maskLabel.textContent === app.i18n.text("蒙版层显示（0 或 100）", "Mask layer (0 or 100)") && maskSlider.disabled === false && maskEye.disabled === false;
      maskSlider.value = "0"; maskSlider.dispatchEvent(new Event("input", { bubbles: true }));
      checks.maskHiddenBySlider = app.state.maskVisible === false && maskSlider.value === "0" && app.state.resultVisible === resultVisibleBefore;
      maskEye.click();
      checks.maskShownByEye = app.state.maskVisible === true && maskSlider.value === "100" && app.state.resultVisible === resultVisibleBefore;
      var maskVisibleAfter = app.state.maskVisible;
      editor.setTool(toolBefore || "pencil"); editor.syncCanvas();
      maskEye.click();
      // Back on the result the eye must drive the result again, not the mask.
      checks.maskControlsReleased = app.state.maskMode === false && maskLabel.textContent === app.i18n.text("成图透明度", "Result opacity") && app.state.resultVisible === !resultVisibleBefore && app.state.maskVisible === maskVisibleAfter;
      maskEye.click();
      checks.resultOverElements = Number(getComputedStyle(document.getElementById("result-image")).zIndex) > Number(getComputedStyle(document.getElementById("selection-canvas")).zIndex) && getComputedStyle(document.getElementById("result-image")).pointerEvents === "none" && getComputedStyle(document.getElementById("result-image")).touchAction === "none";
      var stageRect = document.getElementById("stage-frame").getBoundingClientRect();
      checks.resultPointerPassThrough = document.elementFromPoint(stageRect.left + stageRect.width / 2, stageRect.top + stageRect.height / 2) === document.getElementById("draft-canvas");
      checks.selectionOverlay = Number(getComputedStyle(document.getElementById("selection-canvas")).zIndex) > Number(getComputedStyle(document.getElementById("draft-canvas")).zIndex);
      checks.noPreviewBadge = !document.getElementById("stage-badge");
      app.state.prompt = "History and image round trip with a deliberately long English description that exceeds the compact summary width"; editor.syncAll();
      // Pin a value the floor animation cannot produce, so the restore assertion
      // below proves persistence instead of re-reading whatever the animation left.
      app.state.resultOpacity = 0.23; editor.syncCanvas();
      step("saving-assets"); await store.flush(); tempId = app.state.workId;
      var saved = await store.get(tempId);
      checks.noInlineImageData = JSON.stringify(saved).indexOf("data:image") < 0 && saved.result.asset.parts.length > 0;
      checks.historyCreated = store.list().some(function (item) { return item.id === tempId; });
      var count = app.state.objects.length;
      app.services.assets.clearCache();
      step("restoring"); editor.resetWork(); var restored = await store.restoreWork(tempId, false); canvas.load(restored); editor.syncAll();
      checks.filesystemReadback = restored.result.src === imageSrc;
      checks.renderRestore = Boolean(app.state.renderResult && app.state.renderResult.slot === "upscale" && app.state.renderResult.src === imageSrc);
      checks.restore = app.state.prompt.indexOf("History and image round trip") === 0 && app.state.objects.length === count && app.state.result.src === imageSrc;
      checks.fileSettingsRestore = app.state.autoDelayMs === 1320 && app.state.resultOpacity === 0.23 && app.state.layerOpacity === 1 && app.state.resultVisible === true && app.state.resultGlow === 38 && app.state.resultClarity === 24 && app.state.colorStrength === 0.47 && app.state.resultAdjustmentsEnabled === true;
      checks.imageRestore = app.state.objects.some(function (object) { return object.type === "image" && object.src === imageSrc; });
      var workCount = store.list().length;
      await store.flush(); checks.noDuplicateAutosaves = store.list().length === workCount;
      step("gallery"); await app.components.gallery.open();
      checks.historyGallery = Boolean(document.querySelector('[data-work="' + tempId + '"] canvas'));
      var search = document.getElementById("history-search"); search.value = "not-found-" + Date.now(); search.dispatchEvent(new Event("input", { bubbles: true }));
      checks.historySearch = document.querySelectorAll(".art-card").length === 0; ui.close();
      step("settings"); app.components.settings.open("models");
      checks.threeTaskTabs = document.querySelectorAll("[data-slot-tab]").length === 3;
      document.querySelector('[data-slot-tab="upscale"]').click();
      checks.independentModelTabs = Boolean(document.querySelector('[data-model-card="upscale"]'));
      checks.aspectLocked = Boolean(document.querySelector(".aspect-field")) && !document.querySelector('.aspect-field [name="width"]') && !document.querySelector('.aspect-field [name="steps"]');
      document.querySelector('[data-slot-tab="inpaint"]').click();
      checks.localRedrawTab = Boolean(document.querySelector('[data-model-card="inpaint"]'));
      checks.keyMasked = document.querySelector('[name="apiKey"]').type === "password";
      ui.close();
      app.components.settings.open("work");
      checks.workSettings = Boolean(document.querySelectorAll('[name="strength"]').length === 1 && document.querySelector('[name="strength"]').min === "0" && document.querySelector('[name="strength"]').max === "100" && !document.querySelector('[name="referenceStrength"]') && !document.querySelector('[name="colorStrength"]') && document.querySelector('[name="prompt"]').rows === 3 && document.querySelector('[name="negativePrompt"]').rows === 2 && document.querySelector('[name="seed"]') && document.querySelector('[name="seedLocked"]').getAttribute("role") === "switch" && document.querySelector('[name="autoDelayMs"]') && document.querySelector('[name="overlayGenerate"]').getAttribute("role") === "switch" && document.querySelector('[name="overlayGenerate"]').classList.contains("toggle-switch"));
      var workSheet = document.querySelector("#modal-layer .modal-sheet"), workContent = document.getElementById("modal-content"), workActions = document.getElementById("modal-actions");
      checks.workSettingsSheet = workSheet.classList.contains("work-settings-sheet") && !workSheet.classList.contains("centered") && Math.abs(workSheet.getBoundingClientRect().bottom - window.innerHeight) < 2;
      checks.fixedWorkFooter = !workActions.hidden && Boolean(workActions.querySelector("[data-cancel]") && workActions.querySelector("[data-save]")) && !workContent.contains(workActions.querySelector("[data-save]")) && getComputedStyle(workContent).overflowY === "auto" && getComputedStyle(workActions).flexShrink === "0";
      checks.cleanWorkFooter = getComputedStyle(workActions).borderTopWidth === "0px" && getComputedStyle(document.querySelectorAll(".work-settings-content .switch-row")[1]).borderBottomWidth === "0px";
      ui.close();
      document.getElementById("color-adjust").click();
      var adjustPanel = document.getElementById("color-adjust-panel"), brightnessField = document.querySelector('[data-adjust="resultBrightness"]'), previousFilter = document.getElementById("result-image").style.filter;
      checks.colorAdjustments = !adjustPanel.hidden && document.querySelectorAll("[data-adjust]").length === 6 && getComputedStyle(adjustPanel).gridTemplateColumns.split(" ").length === 2;
      document.getElementById("color-adjust-enabled").click();
      checks.colorEffectsDisabled = app.state.resultAdjustmentsEnabled === false && canvas.resultFilter() === "none" && document.getElementById("result-image").style.filter === "none" && document.getElementById("color-adjust-enabled").getAttribute("aria-pressed") === "false";
      document.getElementById("color-adjust-enabled").click();
      checks.colorEffectsEnabled = app.state.resultAdjustmentsEnabled === true && canvas.resultFilter() !== "none" && document.getElementById("color-adjust-enabled").getAttribute("aria-pressed") === "true";
      brightnessField.value = "123"; brightnessField.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      checks.liveColorAdjustments = app.state.resultBrightness === 123 && document.querySelector('[data-adjust-output="resultBrightness"]').textContent === "123%" && document.getElementById("result-image").style.filter !== previousFilter;
      var clarityField = document.querySelector('[data-adjust="resultClarity"]'); clarityField.value = "50"; clarityField.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      checks.realSharpening = canvas.resultFilter().indexOf("url(") >= 0 && document.getElementById("hamdraw-sharpen-matrix").getAttribute("kernelMatrix") !== "0 0 0 0 1 0 0 0 0";
      document.getElementById("color-adjust-default").click();
      for (var saveWait = 0; saveWait < 20 && (app.config.canvas.resultBrightness !== 123 || app.config.canvas.resultClarity !== 50); saveWait += 1) await new Promise(function (resolve) { setTimeout(resolve, 25); });
      checks.adjustmentDefaults = app.config.canvas.resultBrightness === 123 && app.config.canvas.resultClarity === 50;
      document.getElementById("color-adjust-reset").click(); checks.adjustmentReset = app.state.resultBrightness === 100 && app.state.resultClarity === 0;
      checks.roundRanges = getComputedStyle(document.querySelector('[data-adjust="resultGlow"]')).height === "24px";
      document.getElementById("color-adjust-close").click(); checks.inlineAdjustClose = adjustPanel.hidden;
      app.components.settings.openColor("background");
      checks.compactColorPicker = document.querySelectorAll('input[type="color"]').length === 0 && document.querySelectorAll('[name="hue"],[name="saturation"],[name="lightness"]').length === 3 && !document.querySelector('[name="colorOpacity"]') && getComputedStyle(document.querySelector(".color-slider-stack .field")).marginBottom === "5px";
      ui.close();
      app.components.settings.openColor("stroke");
      var pickerOpacity = document.querySelector('[name="colorOpacity"]'); pickerOpacity.value = "37"; pickerOpacity.dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("[data-save]").click();
      checks.colorOpacityToolSync = app.state.opacity === 0.37 && document.getElementById("stroke-opacity").value === "37" && document.getElementById("stroke-opacity-value").textContent === "37%";
      // The image-weight slider is the only control that writes state.strength, so
      // its declared range and the clamp on the value it writes must agree.
      var strengthSlider = document.getElementById("prompt-strength"), strengthBefore = app.state.strength;
      app.state.strength = 0.05; editor.syncAll(); var strengthFloor = strengthSlider.value;
      app.state.strength = 1.5; editor.syncAll(); var strengthCeiling = strengthSlider.value;
      app.state.strength = strengthBefore; editor.syncAll();
      checks.promptStrengthRange = strengthSlider.min === "20" && strengthSlider.max === "100" && strengthFloor === "20" && strengthCeiling === "100" && strengthSlider.value === "80";
      step("layout"); app.config.preferences = { theme: "dark", language: "en" }; app.i18n.theme(); editor.syncAll();
      checks.theme = document.documentElement.dataset.theme === "dark" && getComputedStyle(document.body).backgroundColor === "rgb(23, 25, 29)";
      checks.language = document.documentElement.lang === "en" && document.querySelector('[data-menu="history"] span').textContent === "Your artwork";
      var dialog = ui.open({ title: "Self-test", mode: "center", html: "<button>Test</button>" });
      checks.centerDialog = dialog.parentNode.classList.contains("centered"); ui.close();
      var confirm = ui.confirm({ title: "Self-test", message: "Cancel test" });
      document.getElementById("confirm-cancel").click(); checks.confirm = await confirm === false;
      app.components.settings.open("preferences"); checks.sheet = !document.querySelector("#modal-layer .modal-sheet").classList.contains("centered"); ui.close();
      var frame = document.getElementById("stage-frame").getBoundingClientRect();
      checks.layout = Math.abs(frame.width - frame.height) < 2 && document.documentElement.scrollWidth <= window.innerWidth;
      checks.promptAboveCanvas = document.querySelector(".prompt-panel").getBoundingClientRect().bottom < frame.top;
      var promptSummary = document.getElementById("prompt-display"); promptSummary.scrollLeft = 24;
      checks.singleLinePrompt = promptSummary.tagName === "DIV" && !document.getElementById("prompt-input") && !document.getElementById("prompt-save") && getComputedStyle(promptSummary).whiteSpace === "nowrap" && promptSummary.scrollWidth > promptSummary.clientWidth && promptSummary.scrollLeft > 0;
      checks.borderlessPrompt = getComputedStyle(document.querySelector(".prompt-panel")).borderTopWidth === "0px" && getComputedStyle(document.querySelector(".prompt-panel")).backgroundColor === "rgba(0, 0, 0, 0)";
      checks.resultDisplayControls = Boolean(document.getElementById("result-opacity") && document.getElementById("result-visibility")) && document.querySelectorAll("[data-view]").length === 0;
      checks.compactGenerationControls = document.getElementById("generate-quick").textContent.trim() === "Fast" && document.getElementById("generate-quality").textContent.trim() === "Render" && Boolean(document.querySelector("#export-image .fa-download") && document.querySelector("#seed-lock .fa-dice") && document.querySelector("#snapshot-canvas .fa-camera") && !document.getElementById("generation-strength") && document.getElementById("overlay-toggle").getAttribute("role") === "switch");
      var oldSeed = app.state.seed, quickSeedRuns = 0, originalRun = app.services.imageEngine.run;
      app.services.imageEngine.run = function (slot, automatic) { if (slot === "quick" && automatic === false) quickSeedRuns += 1; };
      document.getElementById("seed-lock").click(); app.services.imageEngine.run = originalRun;
      var seedText = String(app.state.seed), expectedSeedLabel = seedText.length < 5 ? seedText : ".." + seedText.slice(-2);
      checks.seedRollButton = app.state.seed !== oldSeed && app.state.seedLocked === true && quickSeedRuns === 1 && document.getElementById("seed-value").textContent === expectedSeedLabel && !document.getElementById("seed-lock").hasAttribute("aria-pressed");
      checks.generationHelp = document.getElementById("status-line").textContent.indexOf("Roll and lock") >= 0;
      var generationButtons = Array.prototype.slice.call(document.querySelectorAll(".generation-row button")), generationSizes = generationButtons.map(function (button) { var rect = button.getBoundingClientRect(); return Math.round(rect.width) + "x" + Math.round(rect.height); });
      checks.generationButtonOrder = generationButtons.map(function (button) { return button.id; }).join(",") === "auto-toggle,generate-quick,seed-lock,generate-quality,overlay-toggle,snapshot-canvas,export-image";
      checks.equalSquareGenerationButtons = generationSizes.every(function (size) { return size === generationSizes[0] && /^(?:44x44|40x40)$/.test(size); });
      var scheduleCalls = 0, originalSchedule = app.services.imageEngine.schedule, originalOverlayGenerate = app.state.overlayGenerate;
      try {
        app.state.autoGenerate = true; app.services.imageEngine.schedule = function () { if (app.state.autoGenerate) scheduleCalls += 1; };
        document.getElementById("overlay-toggle").click();
        await new Promise(function (resolve) { setTimeout(resolve, 220); });
        checks.overlayGenerationSwitch = app.state.overlayGenerate !== originalOverlayGenerate && document.getElementById("overlay-toggle").getAttribute("aria-checked") === "true" && scheduleCalls === 1;
        checks.overlayResultBelow = Math.abs(app.state.layerOpacity - 0.66) < 0.001 && Number(getComputedStyle(document.getElementById("result-image")).zIndex) < Number(getComputedStyle(document.getElementById("draft-canvas")).zIndex) && document.getElementById("result-opacity").value === "66" && document.getElementById("opacity-target-label").textContent === "Element layer opacity";
      var resultOpacityBeforeOverlaySlider = app.state.resultOpacity;
      var layerOpacityControl = document.getElementById("result-opacity"); layerOpacityControl.value = "42"; layerOpacityControl.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      checks.overlaySliderTargetsElements = Math.abs(app.state.layerOpacity - 0.42) < 0.001 && Math.abs(app.state.resultOpacity - resultOpacityBeforeOverlaySlider) < 0.001 && document.getElementById("draft-canvas").style.opacity === "0.42" && scheduleCalls === 2;
        document.getElementById("overlay-toggle").click();
        await new Promise(function (resolve) { setTimeout(resolve, 220); });
        checks.standardResultAbove = app.state.overlayGenerate === false && Math.abs(app.state.resultOpacity - 0.66) < 0.001 && document.getElementById("draft-canvas").style.opacity === "1" && Number(getComputedStyle(document.getElementById("result-image")).zIndex) > Number(getComputedStyle(document.getElementById("selection-canvas")).zIndex) && document.getElementById("result-opacity").value === "66" && document.getElementById("opacity-target-label").textContent === "Result opacity" && scheduleCalls === 3;
      } finally { app.services.imageEngine.schedule = originalSchedule; app.state.autoGenerate = false; }
      var previousOverlayForVisibility = app.state.overlayGenerate;
      app.state.overlayGenerate = true; app.state.layerOpacity = 0.05; editor.syncCanvas(); editor.setTool("select");
      fire("down", .52, .52); fire("up", .52, .52);
      checks.minimumLayerVisibility = Math.abs(app.state.layerOpacity - 0.2) < 0.001 && document.getElementById("draft-canvas").style.opacity === "0.2" && document.getElementById("result-opacity").value === "20";
      app.state.overlayGenerate = previousOverlayForVisibility; app.state.layerOpacity = 1; editor.syncCanvas();
      var snapshotCount = app.state.objects.length;
      app.state.resultOpacity = 1; app.state.resultVisible = true; app.state.resultBrightness = 50; app.state.resultSaturation = 0; app.state.resultContrast = 100; app.state.resultHue = 0; app.state.resultGlow = 0; app.state.resultClarity = 0; app.state.resultAdjustmentsEnabled = true;
      var snapshotObject = await canvas.snapshotVisible(), snapshotImage = new Image(); snapshotImage.src = snapshotObject.src;
      await new Promise(function (resolve, reject) { snapshotImage.onload = resolve; snapshotImage.onerror = reject; });
      var snapshotProbe = document.createElement("canvas"); snapshotProbe.width = 8; snapshotProbe.height = 8; var snapshotContext = snapshotProbe.getContext("2d"); snapshotContext.drawImage(snapshotImage, 0, 0, 8, 8);
      var snapshotPixel = snapshotContext.getImageData(4, 4, 1, 1).data;
      checks.snapshotEditable = app.state.objects.length === snapshotCount + 1 && snapshotObject.type === "image" && snapshotObject.x === 0 && snapshotObject.y === 0 && snapshotObject.width === 768 && snapshotObject.height === 768 && app.state.selectedId === snapshotObject.id && app.state.tool === "select" && handleKeys() === "nw,ne,sw,se,rotate";
      checks.snapshotVisibleEffects = Math.max(snapshotPixel[0], snapshotPixel[1], snapshotPixel[2]) - Math.min(snapshotPixel[0], snapshotPixel[1], snapshotPixel[2]) < 5 && snapshotPixel[0] < 150;
      // A local redraw has to submit the picture as generated, not the picture as it is
      // graded — the snapshot above is the control: same picture, same moment, same
      // adjustments, and it must keep them. So the reference is compared against a
      // composition taken with the adjustments switched off at the source, while the
      // graded snapshot has to sit far away from that same reference.
      var sampleComposition = async function () {
        var url = await canvas.composeInput({ withResult: true, size: 64, mime: "image/png" });
        var image = new Image(); image.src = url;
        await new Promise(function (resolve, reject) { image.onload = resolve; image.onerror = reject; });
        var probe = document.createElement("canvas"); probe.width = 8; probe.height = 8;
        var probeContext = probe.getContext("2d"); probeContext.drawImage(image, 0, 0, 8, 8);
        return probeContext.getImageData(4, 4, 1, 1).data;
      };
      var referencePixel = await sampleComposition();
      app.state.resultAdjustmentsEnabled = false; editor.syncCanvas();
      var ungradedPixel = await sampleComposition();
      app.state.resultAdjustmentsEnabled = true; editor.syncCanvas();
      var channelGap = function (left, right) {
        return Math.max(Math.abs(left[0] - right[0]), Math.abs(left[1] - right[1]), Math.abs(left[2] - right[2]));
      };
      checks.localReferenceUngraded = channelGap(referencePixel, ungradedPixel) <= 3;
      checks.snapshotStillGraded = channelGap(ungradedPixel, snapshotPixel) >= 40 && channelGap(referencePixel, snapshotPixel) >= 40;
      document.querySelector('[data-tool="brush"]').click();
      checks.directStrokeSliders = Boolean(document.getElementById("brush-size") && document.getElementById("stroke-opacity") && !document.getElementById("brush-more") && !document.getElementById("stroke-opacity-control").hidden);
      checks.toolHelp = document.getElementById("status-line").textContent.indexOf("Paint color areas") >= 0;
      checks.newWorkInMenu = Boolean(document.querySelector('[data-menu="new"]')) && /^(?:Untitled artwork \d+|未命名作品\d+)$/.test(editor.nextUntitledTitle());
      checks.compactWorkHeading = !document.getElementById("new-work") && !document.getElementById("open-history") && Boolean(document.querySelector("#work-settings .fa-gear"));
      app.state.workTitle = "A deliberately very long artwork title that must stay on one line and end with an ellipsis"; editor.syncAll();
      var titleNode = document.getElementById("work-title"), titleStyle = getComputedStyle(titleNode);
      checks.longTitleEllipsis = titleStyle.textOverflow === "ellipsis" && titleStyle.whiteSpace === "nowrap" && titleNode.scrollWidth > titleNode.clientWidth;
      app.state.workTitle = ""; app.state.prompt = "This prompt must never become the artwork title"; editor.syncAll();
      checks.promptNeverBecomesTitle = /^(?:Untitled artwork \d+|未命名作品\d+)$/.test(app.state.workTitle) && document.getElementById("work-title").textContent === app.state.workTitle && document.getElementById("work-title").textContent !== app.state.prompt;
      checks.canvasActionOrder = Array.prototype.map.call(document.querySelectorAll(".canvas-actions button"), function (button) { return button.id; }).join(",") === "canvas-fullscreen,color-adjust,undo,redo,clear-canvas" && Boolean(document.querySelector("#clear-canvas .fa-trash-can"));
      checks.canvasHelp = document.querySelectorAll(".canvas-bar [data-help-zh]").length === 6 && document.getElementById("status-line").textContent.length > 0;
      checks.backgroundLabel = document.getElementById("background-color").textContent.trim() === "BG";
      var fullscreenButton = document.getElementById("canvas-fullscreen"); fullscreenButton.click();
      await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      var fullscreenFrame = document.getElementById("stage-frame").getBoundingClientRect(), fullscreenBarStyle = getComputedStyle(document.querySelector(".canvas-bar")), fullscreenBottomStyle = getComputedStyle(document.getElementById("fullscreen-bottom"));
      checks.fullscreenCanvas = document.body.classList.contains("canvas-fullscreen") && Math.abs(fullscreenFrame.height - window.innerHeight) < 2 && Math.abs(fullscreenFrame.width - fullscreenFrame.height) < 2;
      checks.fullscreenFloatingTools = fullscreenBarStyle.position === "fixed" && fullscreenBottomStyle.position === "fixed" && Number(fullscreenBarStyle.zIndex) > Number(getComputedStyle(document.getElementById("result-image")).zIndex);
      checks.fullscreenGradients = fullscreenBarStyle.backgroundImage.indexOf("linear-gradient") >= 0 && fullscreenBottomStyle.backgroundImage.indexOf("linear-gradient") >= 0;
      var fullscreenDockStyle = getComputedStyle(document.querySelector(".drawing-dock"));
      checks.fullscreenFrostedTools = fullscreenDockStyle.backgroundColor.indexOf("rgba") === 0 && fullscreenDockStyle.backgroundColor !== "rgba(0, 0, 0, 0)";
      var fullscreenButtonStyle = getComputedStyle(fullscreenButton), opacityOutputRect = document.getElementById("result-opacity-value").getBoundingClientRect(), fullscreenButtonRect = fullscreenButton.getBoundingClientRect();
      checks.fullscreenButtonStyle = fullscreenButtonStyle.color === "rgb(255, 255, 255)" && fullscreenButtonStyle.backgroundColor !== "rgba(0, 0, 0, 0)";
      checks.fullscreenControlGap = fullscreenButtonRect.left - opacityOutputRect.right >= 6;
      var toolsToggle = document.getElementById("fullscreen-tools-toggle"), toolsToggleRect = toolsToggle.getBoundingClientRect(), dockRect = document.querySelector(".drawing-dock").getBoundingClientRect();
      checks.fullscreenToolsToggle = getComputedStyle(toolsToggle).display !== "none" && Math.abs(toolsToggleRect.width - 48) < 2 && Math.abs(toolsToggleRect.height - 38) < 2 && Math.abs(toolsToggleRect.bottom - dockRect.top) < 2 && toolsToggle.getAttribute("aria-expanded") === "true";
      toolsToggle.click(); await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      checks.fullscreenToolsCollapsed = document.body.classList.contains("fullscreen-tools-collapsed") && toolsToggle.getAttribute("aria-expanded") === "false" && Boolean(toolsToggle.querySelector(".fa-caret-up")) && getComputedStyle(document.querySelector(".drawing-dock")).display === "none" && getComputedStyle(document.querySelector(".generation-row")).display === "none" && getComputedStyle(toolsToggle).display !== "none" && getComputedStyle(document.getElementById("fullscreen-bottom")).backgroundImage === "none";
      var collapsedToggleRect = toolsToggle.getBoundingClientRect(), collapsedToggleStyle = getComputedStyle(toolsToggle);
      checks.fullscreenToggleFlush = Math.abs(collapsedToggleRect.bottom - window.innerHeight) < 2 && collapsedToggleStyle.borderBottomLeftRadius === "0px" && collapsedToggleStyle.borderBottomRightRadius === "0px" && collapsedToggleStyle.backgroundColor !== "rgba(0, 0, 0, 0)";
      toolsToggle.click(); await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      checks.fullscreenToolsExpanded = !document.body.classList.contains("fullscreen-tools-collapsed") && toolsToggle.getAttribute("aria-expanded") === "true" && Boolean(toolsToggle.querySelector(".fa-caret-down")) && getComputedStyle(document.querySelector(".drawing-dock")).display !== "none";
      app.events.emit("canvas:interaction", true);
      // Interactive mode fades the chrome out over a CSS transition, so wait for
      // it to settle before reading the opacity.
      await settled(function () { return Number(getComputedStyle(document.querySelector(".canvas-bar")).opacity) < 0.05 && Number(getComputedStyle(document.getElementById("fullscreen-bottom")).opacity) < 0.05; }, 1500);
      checks.fullscreenInteractionState = document.body.classList.contains("canvas-interacting");
      checks.fullscreenInteractionHidesTop = Number(getComputedStyle(document.querySelector(".canvas-bar")).opacity) < 0.05;
      checks.fullscreenInteractionHidesBottom = Number(getComputedStyle(document.getElementById("fullscreen-bottom")).opacity) < 0.05;
      app.events.emit("canvas:interaction", false);
      await settled(function () { return Number(getComputedStyle(document.querySelector(".canvas-bar")).opacity) > 0.95 && Number(getComputedStyle(document.getElementById("fullscreen-bottom")).opacity) > 0.95; }, 1000);
      checks.fullscreenInteractionRestoresChrome = !document.body.classList.contains("canvas-interacting") && Number(getComputedStyle(document.querySelector(".canvas-bar")).opacity) > 0.95 && Number(getComputedStyle(document.getElementById("fullscreen-bottom")).opacity) > 0.95;
      fullscreenButton.click(); await new Promise(function (resolve) { requestAnimationFrame(resolve); }); checks.fullscreenExit = !document.body.classList.contains("canvas-fullscreen") && Boolean(document.querySelector("#canvas-fullscreen .fa-expand"));
      app.components.renderPreview.open({ src: imageSrc, logicalFileId: "", slot: "upscale" }); await new Promise(function (resolve) { requestAnimationFrame(resolve); });
      await new Promise(function (resolve) { setTimeout(resolve, 30); });
      var preview = document.getElementById("render-preview"), previewTools = document.querySelector(".render-preview-tools");
      checks.renderPreview = !preview.hidden && getComputedStyle(preview).position === "fixed" && getComputedStyle(preview).width === window.innerWidth + "px" && getComputedStyle(document.getElementById("render-preview-stage")).position === "absolute" && getComputedStyle(document.getElementById("render-preview-stage")).touchAction === "none" && document.getElementById("render-preview-image").hidden && !document.getElementById("render-preview-surface").hidden && document.getElementById("render-preview-surface").width > 0 && Boolean(previewTools && getComputedStyle(previewTools).borderRadius !== "0px" && document.getElementById("render-preview-adjust") && document.querySelectorAll("[data-render-adjust]").length === 6 && document.getElementById("render-preview-download") && document.getElementById("render-preview-reset") && document.getElementById("render-preview-clear") && document.getElementById("render-preview-close"));
      app.components.renderPreview.close();
      app.state.renderResult = { src: imageSrc, logicalFileId: "", slot: "upscale", createdAt: Date.now() }; editor.syncAll();
      checks.renderResultChrome = !document.getElementById("render-result-trigger").hidden && document.getElementById("render-result-trigger").classList.contains("is-ready") && !document.getElementById("render-notice");
      app.events.emit("render:clear");
      checks.renderResultClear = app.state.renderResult === null && document.getElementById("render-result-trigger").hidden;
      checks.colorButtons = document.querySelectorAll('input[type="color"]').length === 0 && getComputedStyle(document.getElementById("background-color")).borderRadius === "50%";
      document.body.classList.remove("keyboard-focus"); document.getElementById("work-settings").focus();
      checks.noTapOutline = getComputedStyle(document.getElementById("work-settings")).outlineStyle === "none";
      app.components.settings.open("models");
      var advancedSummary = document.querySelector("details.advanced > summary");
      if (advancedSummary) { document.body.classList.add("keyboard-focus"); advancedSummary.focus(); await settled(function () { return getComputedStyle(advancedSummary).outlineStyle === "none"; }, 800); checks.advancedNoOutline = getComputedStyle(advancedSummary).outlineStyle === "none"; }
      document.body.classList.remove("keyboard-focus"); ui.close();
      checks.brandLeft = document.querySelector(".brand").getBoundingClientRect().left <= 24 && document.getElementById("app-version").textContent === "v" + app.version;
      var performanceState = canvas.performance(), assetPerformance = app.services.assets.performance();
      // The journal keeps the current state plus one entry per undoable action,
      // so a 120-step limit is 121 entries.
      checks.performanceBounds = performanceState.imageCache.entries <= 16 && performanceState.undoLimit === 120 && performanceState.historyEntries <= performanceState.undoLimit + 1 && assetPerformance.cache.entries <= 10;
      var generate = document.getElementById("generate-quality").getBoundingClientRect();
      checks.actionsVisible = generate.left >= 0 && generate.right <= window.innerWidth && generate.bottom <= window.innerHeight;
      checks.bridgeReady = Boolean(window.haminn.isReady);
    } catch (error) {
      checks.error = app.utils.cleanError(error);
    } finally {
      step("cleanup"); ui.close(); app.components.renderPreview.close(); app.services.imageEngine.cancel();
      app.config = config; await store.saveConfig(config);
      canvas.load(original || { objects: [], result: null, prompt: "", workId: "", workTitle: "" });
      app.state.tool = originalTool; app.i18n.theme(); editor.syncAll(); await store.flush();
      var testWorks = store.list().filter(function (item) { return originalWorkIds.indexOf(item.id) < 0; });
      for (var testWork of testWorks) await store.remove(testWork.id);
      window.__hamdrawSelfTest = { version: app.version, passed: Object.keys(checks).every(function (key) { return checks[key] === true; }), checks: checks };
      window.__hamdrawSelfTestProgress = "complete";
      window.history.replaceState(null, "", window.location.pathname);
      editor.status(editor.defaultStatus());
    }
  }
  app.features.selfTest = { run: run };
})(window.hamdraw);
