//: The half of the canvas that talks to the outside world: what goes to the model,
//: what goes to the file store, what comes back from a saved artwork and what the
//: gallery draws on a card. It is the drawing half of `app/components/canvas.js`,
//: split off because that file had grown past 1700 lines and this is the part that
//: changes whenever the mask, the budget or the download does.
//:
//: The two halves share one closure in spirit: the paint helpers this half needs —
//: drawing a stroke or a picture, the image cache, selection, render, the undo
//: journal — are handed in through `create()` rather than reached across, so this
//: half owns no state of the drawing and the drawing half calls nothing in here.
//: Nothing below was rewritten in the move: the same text, resolving ten names
//: through the bag instead of a neighbouring function.
(function (app) {
  "use strict";

  function create(deps) {
    var state = deps.state, WIDTH = deps.WIDTH, isMaskStroke = deps.isMaskStroke;
    var drawStroke = deps.drawStroke, drawPicture = deps.drawPicture, drawResult = deps.drawResult;
    var drawCovered = deps.drawCovered, loadImage = deps.loadImage, setSelection = deps.setSelection;
    var render = deps.render, commit = deps.commit, resetHistory = deps.resetHistory;

  function maskStrokes() { return state.objects.filter(isMaskStroke); }
  function hasMask() { return state.objects.some(isMaskStroke); }
  function contentCount() { return state.objects.length - maskStrokes().length; }
  function clearMask() {
    var removed = 0;
    for (var index = state.objects.length - 1; index >= 0; index -= 1) {
      if (!isMaskStroke(state.objects[index])) continue;
      state.objects.splice(index, 1); removed += 1;
    }
    if (!removed) return 0;
    setSelection([]); render(); commit();
    return removed;
  }
  async function drawObjectList(targetContext, includeMask, opacity, objects) {
    var layer = document.createElement("canvas"); layer.width = WIDTH; layer.height = WIDTH;
    var layerContext = layer.getContext("2d");
    objects = objects || state.objects;
    for (var index = 0; index < objects.length; index += 1) {
      var object = objects[index];
      if (object.type === "stroke") {
        if (object.tool === "mask" && !includeMask) continue;
        drawStroke(layerContext, object, false);
      } else {
        var image = await loadImage(object.src || object.url, false);
        if (image) drawPicture(layerContext, object, image);
      }
    }
    targetContext.save(); targetContext.globalAlpha = opacity == null ? 1 : opacity; targetContext.drawImage(layer, 0, 0); targetContext.restore();
  }
  function captureComposition(overrides) {
    var currentResultOpacity = Number(state.resultOpacity);
    if (!Number.isFinite(currentResultOpacity)) currentResultOpacity = 1;
    // A local-redraw caller can assert the mode instead of inheriting it, so its
    // reference image can never silently fall back to the bare sketch.
    var masking = overrides && overrides.localMode != null ? Boolean(overrides.localMode) : Boolean(state.maskMode);
    // A local redraw is handed the picture exactly as it was generated. The colour
    // adjustments are a view of that picture, not part of it: a reference with them
    // baked in would have the model repaint against a filtered image, and the result
    // would then be filtered a second time on the way back to the screen, so the
    // repainted area would no longer match the pixels around it. This is deliberately
    // not `masking`: a snapshot is the opposite case and must keep the graded picture
    // that is on screen.
    var original = Boolean(overrides && overrides.originalResult);
    return {
      background: state.background || "#ffffff",
      localMode: masking,
      overlayGenerate: masking ? false : Boolean(state.overlayGenerate),
      resultOpacity: masking ? 1 : Math.max(0, Math.min(1, currentResultOpacity)),
      layerOpacity: masking ? 0 : Math.max(0, Math.min(1, Number(state.layerOpacity == null ? 1 : state.layerOpacity))),
      resultVisible: masking ? true : state.resultVisible !== false,
      resultSrc: state.result && state.result.src || "",
      resultBrightness: state.resultBrightness,
      resultContrast: state.resultContrast,
      resultSaturation: state.resultSaturation,
      resultHue: state.resultHue,
      resultGlow: state.resultGlow,
      resultClarity: state.resultClarity,
      resultAdjustmentsEnabled: original ? false : state.resultAdjustmentsEnabled !== false,
      objects: masking ? [] : app.drawing.cloneObjects(state.objects)
    };
  }
  async function drawCompositionResult(ctx, composition) {
    if (!composition.resultVisible || !composition.resultSrc) return;
    var result = await loadImage(composition.resultSrc, false);
    if (!result) return;
    ctx.save(); ctx.globalAlpha = composition.resultOpacity; drawResult(ctx, result, WIDTH, WIDTH, true, composition); ctx.restore();
  }
  async function renderComposition(composition, targetSize, visibleSnapshot) {
    var output = document.createElement("canvas");
    output.width = targetSize; output.height = targetSize;
    var ctx = output.getContext("2d");
    if (targetSize !== WIDTH) ctx.scale(targetSize / WIDTH, targetSize / WIDTH);
    ctx.fillStyle = composition.background;
    ctx.fillRect(0, 0, WIDTH, WIDTH);
    if (composition.overlayGenerate) {
      await drawCompositionResult(ctx, composition);
      await drawObjectList(ctx, false, composition.layerOpacity, composition.objects);
    } else {
      await drawObjectList(ctx, false, 1, composition.objects);
      if (visibleSnapshot || composition.localMode) await drawCompositionResult(ctx, composition);
    }
    return output;
  }
  async function snapshotVisible() {
    var composition = captureComposition();
    var output = await renderComposition(composition, WIDTH, true), src = output.toDataURL("image/png");
    await loadImage(src, false);
    var object = { id: app.utils.id("image"), type: "image", url: src, src: src, logicalFileId: "", name: "HamDraw snapshot", x: 0, y: 0, width: WIDTH, height: WIDTH };
    state.objects.push(object); setSelection([object.id]); state.tool = "select";
    render(); commit(); app.events.emit("tool", "select");
    return object;
  }
  function composeInput(options) {
    options = options || {};
    var targetSize = Number(options.size) || WIDTH;
    // withResult marks a local redraw: its reference has to be the decorated
    // result, never the bare sketch, so the mode is asserted rather than inherited.
    var composition = captureComposition(options.withResult ? { localMode: true, originalResult: true } : null);
    return composeWithinBudget(composition, targetSize, options.withResult === true, options);
  }
  function composeVisibleInput(options) {
    options = options || {};
    var targetSize = Number(options.size) || WIDTH;
    return composeWithinBudget(captureComposition(), targetSize, true, options);
  }
  function encodeCanvas(output, options) {
    var mime = options.mime || "image/png", quality = Number(options.quality) || 0.82;
    var encoded = output.toDataURL(mime, quality), maxBytes = Number(options.maxBytes) || 0;
    // maxBytes counts the characters of the encoded data URL, because that is
    // exactly what ends up inside the request body.
    while (maxBytes && mime === "image/jpeg" && encoded.length > maxBytes && quality > 0.45) {
      quality = Math.max(0.45, quality - 0.1); encoded = output.toDataURL(mime, quality);
    }
    return encoded;
  }
  // Quality alone cannot always reach the budget (a photo-like canvas stays
  // large in any JPEG quality), so the size steps down too.
  async function composeWithinBudget(composition, targetSize, visible, options) {
    var size = targetSize, output = await renderComposition(composition, size, visible);
    var encoded = encodeCanvas(output, options), maxBytes = Number(options.maxBytes) || 0;
    for (var attempt = 0; maxBytes && encoded.length > maxBytes && attempt < 6 && size > 256; attempt++) {
      size = Math.max(256, Math.round(size * 0.8));
      output = await renderComposition(composition, size, visible);
      encoded = encodeCanvas(output, options);
    }
    return encoded;
  }
  //: The ramp is sized from the mark the user drew, and bounded to a narrow
  //: range: a dot takes two pixels and a broad sweep ten, never more. A wide
  //: ramp on a small mark erases it, and a wide ramp anywhere is what came back
  //: as the grey collar around fresh content. One guard survives from the earlier
  //: sizing: a mark only a few pixels across takes a smaller ramp than the floor
  //: rather than being blurred out of existence.
  var FEATHER_MIN = 2;
  var FEATHER_MAX = 10;
  var MASK_GROW = 3;
  var lastFeatherRadius = 0;
  function maskFeatherRadius(data, size) {
    var area = 0, minX = size, minY = size, maxX = -1, maxY = -1, x, y, index;
    for (y = 0; y < size; y += 1) {
      for (x = 0; x < size; x += 1) {
        index = (y * size + x) * 4;
        if (data[index] < 128) continue;
        area += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (!area || maxX < 0) return 0;
    //: 0.22 × the mark's own equivalent radius — how big the thing drawn is, not
    //: how big the canvas is.
    var drawn = 0.22 * Math.sqrt(area / Math.PI);
    var span = Math.min(maxX - minX + 1, maxY - minY + 1);
    return Math.min(Math.max(drawn, FEATHER_MIN), 0.45 * span, FEATHER_MAX);
  }
  function featherPixels(data, size, radius) {
    var count = size * size, i, x, y, pass, sum, row;
    var front = new Float32Array(count), back = new Float32Array(count);
    for (i = 0; i < count; i += 1) front[i] = data[i * 4];
    var windowSize = radius * 2 + 1;
    for (pass = 0; pass < 3; pass += 1) {
      for (y = 0; y < size; y += 1) {
        row = y * size; sum = 0;
        for (x = -radius; x <= radius; x += 1) sum += front[row + Math.min(size - 1, Math.max(0, x))];
        for (x = 0; x < size; x += 1) {
          back[row + x] = sum / windowSize;
          sum += front[row + Math.min(size - 1, x + radius + 1)] - front[row + Math.max(0, x - radius)];
        }
      }
      for (x = 0; x < size; x += 1) {
        sum = 0;
        for (y = -radius; y <= radius; y += 1) sum += back[Math.min(size - 1, Math.max(0, y)) * size + x];
        for (y = 0; y < size; y += 1) {
          front[y * size + x] = sum / windowSize;
          sum += back[Math.min(size - 1, y + radius + 1) * size + x] - back[Math.max(0, y - radius) * size + x];
        }
      }
    }
    for (i = 0; i < count; i += 1) {
      var value = front[i];
      data[i * 4] = value; data[i * 4 + 1] = value; data[i * 4 + 2] = value;
    }
  }
  //: A feathered mask does not compress the way a flat black-and-white one
  //: does — the same marks go from a few thousand characters to hundreds of
  //: thousands — so its size is worth knowing when a submission is diagnosed.
  var lastMaskChars = 0;
  function featherMask(source, size) {
    var ctx = source.getContext("2d"), image;
    try { image = ctx.getImageData(0, 0, size, size); } catch (_) { lastFeatherRadius = 0; return source; }
    var radius = Math.round(maskFeatherRadius(image.data, size));
    lastFeatherRadius = radius;
    if (!radius) return source;
    var copy = document.createElement("canvas");
    copy.width = size; copy.height = size;
    copy.getContext("2d").drawImage(source, 0, 0);
    ctx.filter = "blur(" + radius + "px)";
    if (ctx.filter && ctx.filter !== "none") {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(copy, 0, 0);
      ctx.filter = "none";
      return source;
    }
    featherPixels(image.data, size, radius);
    ctx.putImageData(image, 0, 0);
    return source;
  }
  //: The mask is composed at the size the job actually runs at — the model's
  //: canvas, not the app's. The sampler resizes whatever mask it is handed onto
  //: its own latent grid, so a mask that is already that size arrives without a
  //: further resample on the way in, and the body that carries it is smaller. The
  //: marks themselves are drawn in the canvas' own coordinates, so they are scaled
  //: into the target rather than re-measured.
  function composeMask(openAiAlpha, size) {
    if (!hasMask()) return null;
    var side = Math.max(64, Math.round(Number(size) || WIDTH));
    var output = document.createElement("canvas");
    output.width = side; output.height = side;
    var ctx = output.getContext("2d");
    if (side !== WIDTH) ctx.scale(side / WIDTH, side / WIDTH);
    if (openAiAlpha) {
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, WIDTH, WIDTH);
      ctx.globalCompositeOperation = "destination-out";
    } else {
      ctx.fillStyle = "black"; ctx.fillRect(0, 0, WIDTH, WIDTH);
      ctx.strokeStyle = "white";
    }
    state.objects.filter(function (object) { return object.type === "stroke" && (object.tool === "mask" || object.tool === "eraser"); }).forEach(function (object) {
      var copy = { points: object.points, width: object.width + (openAiAlpha ? 0 : MASK_GROW * 2), color: !openAiAlpha && object.tool === "eraser" ? "black" : "white", opacity: 1, tool: openAiAlpha && object.tool === "mask" ? "eraser" : "brush" };
      drawStroke(ctx, copy, false);
    });
    //: The scaling is dropped before anything is drawn back over the marks: the
    //: ramp is drawn with `drawImage`, which honours the transform, and a second
    //: pass through it would shrink the blurred copy instead of laying it down.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    //: Only the plugin path is feathered. OpenAI reads this image as an alpha
    //: channel and blends on its own side, so it keeps the crisp shape. A ramp
    //: that cannot be measured is skipped rather than allowed to stop the job.
    if (openAiAlpha) return output.toDataURL("image/png");
    try { output = featherMask(output, side); } catch (_) { lastFeatherRadius = 0; }
    var dataUrl = output.toDataURL("image/png");
    lastMaskChars = dataUrl.length;
    return dataUrl;
  }
  async function exportSource(src, logicalFileId, baseName) {
    var bridge = app.platform.haminn.current();
    if (bridge && logicalFileId) return bridge.files.export({ logicalFileId: logicalFileId });
    if (bridge) {
      var file = await writeImageFile(bridge, src, (baseName || "HamDraw-canvas") + "-" + Date.now() + ".png", "image/png");
      try { return await bridge.files.export({ logicalFileId: file.logicalFileId }); }
      finally { await bridge.files.delete({ logicalFileId: file.logicalFileId }).catch(function () {}); }
    }
    var anchor = document.createElement("a");
    anchor.download = (baseName || "hamdraw-canvas") + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
    anchor.href = src;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  }
  //: The download has to be the picture, so the picture's own bytes are what get
  //: written. It used to be wrapped in an SVG document, because `writeText` was the
  //: only writer then and a text call cannot carry a JPEG — the file that landed in the
  //: gallery was a `.svg` that almost nothing else would open. The file library takes
  //: real bytes through a chunked writer, so the wrapper has no reason to exist.
  function dataUrlBytes(src) {
    var text = String(src), comma = text.indexOf(",");
    if (comma < 0 || text.slice(0, comma).indexOf("base64") < 0) throw new Error(app.i18n.text("画布数据不是可导出的图片字节", "The canvas data is not exportable image bytes"));
    var binary = atob(text.slice(comma + 1)), bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  async function writeImageFile(bridge, src, name, mime) {
    var bytes = dataUrlBytes(src), write = await bridge.files.beginWrite({ name: name, mime: mime });
    try {
      for (var at = 0; at < bytes.length; at += write.maxChunkBytes) {
        var slice = bytes.subarray(at, at + write.maxChunkBytes), binary = "";
        for (var index = 0; index < slice.length; index += 1) binary += String.fromCharCode(slice[index]);
        await bridge.files.appendBytes({ writeId: write.writeId, chunkBase64: btoa(binary) });
      }
      return await bridge.files.finishWrite({ writeId: write.writeId });
    } catch (error) {
      await bridge.files.abortWrite({ writeId: write.writeId }).catch(function () {});
      throw error;
    }
  }
  async function exportVisibleCanvas() {
    var src = await composeVisibleInput({ size: WIDTH, mime: "image/png" });
    return exportSource(src, "", "HamDraw-canvas");
  }
  async function imageDimensions(src) {
    var image = await loadImage(src, false);
    return image ? { width: image.naturalWidth, height: image.naturalHeight } : { width: 0, height: 0 };
  }
  function load(saved) {
    if (!saved) return;
    ["prompt", "localPrompt", "negativePrompt", "background", "color", "size", "opacity", "strength", "colorStrength", "seed", "seedLocked", "autoDelayMs", "autoGenerate", "overlayGenerate", "resultOpacity", "layerOpacity", "resultVisible", "maskVisible", "resultBrightness", "resultContrast", "resultSaturation", "resultHue", "resultGlow", "resultClarity", "resultAdjustmentsEnabled", "workId", "workTitle"].forEach(function (key) {
      if (saved[key] !== undefined) state[key] = saved[key];
    });
    state.objects = saved.objects || [];
    //: The containers come back with the objects. A member only names its container, so a record
    //: opened without its table would draw every grouped object upright. A record written before
    //: containers were nodes names no table at all and carries the group inside each member.
    state.groups = saved.groups && Object.keys(saved.groups).length ? app.drawing.cloneGroups(saved.groups) : app.drawing.groupsFromMembers(state.objects);
    state.result = saved.result || null;
    // The last render is part of the artwork, so it comes back with it.
    state.renderResult = saved.render || null;
    // So does the cover: it is the last generated picture and the history card draws it,
    // which is why it is restored even for a record whose result was cleared.
    state.cover = saved.cover || null;
    setSelection([]);
    state.objects.forEach(function (object) {
      if (object.type === "image") { object.src = object.src || object.url; loadImage(object.src, true); }
    });
    render(); resetHistory();
  }
  async function thumbnail(saved, target) {
    var size = 768, ctx = target.getContext("2d"); target.width = 288; target.height = 288;
    ctx.scale(288 / size, 288 / size); ctx.fillStyle = saved.background || "#fff"; ctx.fillRect(0, 0, size, size);
    // The card shows the cover — the last generated picture — before anything else, and
    // it is drawn from the filed reference rather than from whatever the sketch still
    // holds. A cover whose files have gone falls through instead of blanking the card.
    if (saved.cover && saved.cover.asset) {
      try {
        var coverSrc = await app.services.assets.resolve(saved.cover.asset), picture = await loadImage(coverSrc, false);
        if (picture) { drawCovered(ctx, picture, size, size); return; }
      } catch (_) {}
    }
    if (saved.result && saved.result.asset) {
      var src = await app.services.assets.resolve(saved.result.asset), result = await loadImage(src, false);
      if (result) drawCovered(ctx, result, size, size);
      return;
    }
    var layer = document.createElement("canvas"); layer.width = size; layer.height = size; var layerCtx = layer.getContext("2d");
    for (var object of saved.objects || []) {
      if (object.type === "stroke") { if (object.tool !== "mask") drawStroke(layerCtx, object, false); }
      else { var image = await loadImage(object.asset ? await app.services.assets.resolve(object.asset) : object.url, false); if (image) drawPicture(layerCtx, object, image); }
    }
    ctx.drawImage(layer, 0, 0);
  }

    return {
      maskStrokes: maskStrokes,
      hasMask: hasMask,
      contentCount: contentCount,
      clearMask: clearMask,
      snapshotVisible: snapshotVisible,
      composeInput: composeInput,
      composeVisibleInput: composeVisibleInput,
      composeMask: composeMask,
      maskFeatherRadius: maskFeatherRadius,
      maskChars: function () { return lastMaskChars; },
      exportVisibleCanvas: exportVisibleCanvas,
      exportSource: exportSource,
      imageDimensions: imageDimensions,
      load: load,
      thumbnail: thumbnail
    };
  }

  app.components.canvasIo = { create: create };
})(window.hamdraw);
