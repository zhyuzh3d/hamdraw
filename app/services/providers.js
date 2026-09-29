(function (app) {
  "use strict";

  var u = app.utils;
  var network = app.platform.haminn;
  var t = app.i18n && app.i18n.text || function (zh) { return zh; };
  var PROTOCOLS = [
    { id: "chp", name: "CHP 插件（ComfyUI Haminn Protocol，推荐）", description: "连接装有 CHP 插件（ComfyUI Haminn Protocol）的 ComfyUI。插件自带快速生图 / 局部重绘 / 高质量渲染三套工作流，不需要导出工作流 JSON；密码在插件的配置节点里设置。中文提示词由插件自动译成英文。" },
    { id: "openai-images", name: "OpenAI Images 兼容", description: "兼容 /v1/images/generations 与 /v1/images/edits，适合云端与兼容网关。" },
    { id: "sd-webui", name: "SD WebUI / Forge", description: "兼容 /sdapi/v1/img2img，适合局域网 Stable Diffusion WebUI 或 Forge。" },
    { id: "stability", name: "Stability AI", description: "兼容 Stable Image v2beta 的 Control Sketch 与 Generate 接口。" }
  ];

  function headers(config, contentType) {
    var output = u.parseHeaders(config.customHeaders || "");
    if (contentType) output["Content-Type"] = contentType;
    if (config.apiKey && !output.Authorization && !output.authorization) output.Authorization = "Bearer " + config.apiKey;
    return output;
  }
  function ensureOk(response, requestHeaders) {
    if (response.status >= 200 && response.status < 300) return response;
    var payload = u.parseJson(response.bodyText || "", null);
    throw network.httpError(response, payload, requestHeaders || {});
  }
  function dataUrl(mime, base64) { return "data:" + (mime || "image/png") + ";base64," + String(base64 || "").replace(/\s/g, ""); }
  function jsonImage(payload) {
    if (!payload) return null;
    var item = payload.data && payload.data[0] || null;
    if (item && item.b64_json) return { src: dataUrl(payload.output_format === "jpeg" ? "image/jpeg" : payload.output_format === "webp" ? "image/webp" : "image/png", item.b64_json), metadata: payload };
    if (item && item.url) return { remoteUrl: item.url, metadata: payload };
    if (payload.images && payload.images[0]) return { src: dataUrl("image/png", String(payload.images[0]).replace(/^data:image\/[^;]+;base64,/, "")), metadata: payload };
    if (payload.image && payload.image.base64) return { src: dataUrl(payload.image.mime || "image/png", payload.image.base64), metadata: payload };
    if (payload.artifacts && payload.artifacts[0] && payload.artifacts[0].base64) return { src: dataUrl("image/png", payload.artifacts[0].base64), metadata: payload };
    return null;
  }
  async function responseImage(response, requestHeaders) {
    ensureOk(response, requestHeaders);
    if (response.file && response.file.url) return { src: response.file.url, logicalFileId: response.file.logicalFileId || "", metadata: {} };
    if (response.bodyBase64) return { src: dataUrl(u.imageMimeFromHeaders(response.headers), response.bodyBase64), metadata: {} };
    var payload = u.parseJson(response.bodyText || "", null);
    var found = jsonImage(payload);
    if (!found) throw new Error("模型已响应，但未找到可显示的图片");
    if (!found.remoteUrl) return found;
    var downloaded = await network.request({ url: found.remoteUrl, method: "GET", timeoutMs: 120000 });
    var converted = await responseImage(downloaded, {});
    converted.metadata = found.metadata;
    return converted;
  }
  function openAiRoot(endpoint) {
    var value = u.stripSlash(endpoint);
    return value.replace(/\/images\/(?:generations|edits)$/i, "");
  }
  function size(config) { return String(config.width || 1024) + "x" + String(config.height || 1024); }
  //: The sizes the OpenAI image API documents per model. A model missing from this
  //: table is *unknown*, not unsupported — the difference matters, because refusing a
  //: working model over a table that has not heard of it would be worse than asking.
  var OPENAI_IMAGE_SIZES = {
    "gpt-image-1": [[1024, 1024], [1536, 1024], [1024, 1536]],
    "dall-e-3": [[1024, 1024], [1792, 1024], [1024, 1792]],
    "dall-e-2": [[256, 256], [512, 512], [1024, 1024]]
  };

  async function openAiGenerate(config, input) {
    var root = openAiRoot(config.endpoint), useSketch = config.inputMode !== "text";
    var url = root + "/images/" + (useSketch ? "edits" : "generations");
    var requestHeaders, response;
    if (useSketch) {
      var image = u.dataUrlParts(input.imageDataUrl);
      var fields = {
        model: config.model,
        prompt: input.prompt,
        n: 1,
        size: size(config),
        quality: config.quality || (config.slot === "quick" ? "low" : "high"),
        output_format: "png"
      };
      var files = [{ name: "image", filename: "hamdraw.png", mime: image.mime, bytes: image.bytes }];
      if (input.openAiMaskDataUrl) {
        var mask = u.dataUrlParts(input.openAiMaskDataUrl);
        files.push({ name: "mask", filename: "hamdraw-mask.png", mime: mask.mime, bytes: mask.bytes });
      }
      var body = u.multipart(fields, files);
      requestHeaders = headers(config, body.contentType);
      response = await network.request({ url: url, method: "POST", headers: requestHeaders, bodyBytes: body.bytes, contentType: body.contentType, timeoutMs: config.timeoutMs });
    } else {
      requestHeaders = headers(config, "application/json");
      response = await network.request({
        url: url, method: "POST", headers: requestHeaders, timeoutMs: config.timeoutMs,
        bodyText: JSON.stringify({ model: config.model, prompt: input.prompt, n: 1, size: size(config), quality: config.quality || "auto", response_format: "b64_json" })
      });
    }
    return responseImage(response, requestHeaders);
  }

  async function sdWebuiGenerate(config, input) {
    var url = u.stripSlash(config.endpoint) + "/sdapi/v1/" + (config.inputMode === "text" ? "txt2img" : "img2img");
    var requestHeaders = headers(config, "application/json");
    var body = {
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      width: Number(config.width) || 512,
      height: Number(config.height) || 512,
      steps: Number(config.steps) || (config.slot === "quick" ? 6 : 28),
      seed: Number(input.seed),
      cfg_scale: config.slot === "quick" ? 2 : 6,
      batch_size: 1,
      n_iter: 1,
      send_images: true,
      save_images: false
    };
    if (config.inputMode !== "text") {
      body.init_images = [u.dataUrlParts(input.imageDataUrl).base64];
      body.denoising_strength = u.clamp(Number(input.strength), 0, 1);
      body.resize_mode = 0;
      if (input.maskDataUrl) {
        body.mask = u.dataUrlParts(input.maskDataUrl).base64;
        body.inpainting_fill = 1;
        body.inpaint_full_res = true;
        body.mask_blur = 4;
      }
    }
    if (config.model) body.override_settings = { sd_model_checkpoint: config.model };
    var response = await network.request({ url: url, method: "POST", headers: requestHeaders, bodyText: JSON.stringify(body), timeoutMs: config.timeoutMs });
    return responseImage(response, requestHeaders);
  }

  function stabilityEndpoint(config) {
    var endpoint = u.stripSlash(config.endpoint);
    if (/\/v2beta\//.test(endpoint)) return endpoint;
    return endpoint + (config.inputMode === "text" ? "/v2beta/stable-image/generate/core" : "/v2beta/stable-image/control/sketch");
  }
  async function stabilityGenerate(config, input) {
    var requestHeaders = headers(config, ""), fields = { prompt: input.prompt, output_format: "png" }, files = [];
    requestHeaders.Accept = "image/*";
    if (config.inputMode !== "text") {
      var image = u.dataUrlParts(input.imageDataUrl), extension = image.mime === "image/jpeg" ? "jpg" : image.mime === "image/webp" ? "webp" : "png";
      fields.control_strength = String(u.clamp(input.strength, 0, 1));
      files.push({ name: "image", filename: "hamdraw." + extension, mime: image.mime, bytes: image.bytes });
    } else {
      fields.aspect_ratio = aspect(config.width, config.height);
    }
    if (/\/sd3(?:$|\?)/.test(stabilityEndpoint(config)) && config.model) fields.model = config.model;
    if (input.negativePrompt) fields.negative_prompt = input.negativePrompt;
    if (Number(input.seed) >= 0) fields.seed = String(input.seed);
    var body = u.multipart(fields, files);
    requestHeaders["Content-Type"] = body.contentType;
    var response = await network.request({ url: stabilityEndpoint(config), method: "POST", headers: requestHeaders, bodyBytes: body.bytes, contentType: body.contentType, timeoutMs: config.timeoutMs });
    return responseImage(response, requestHeaders);
  }
  function aspect(width, height) {
    var ratio = (Number(width) || 1) / (Number(height) || 1);
    if (ratio > 1.35) return "16:9";
    if (ratio < 0.74) return "9:16";
    return "1:1";
  }

  // --------------------------------------------------------------------- //
  // CHP — the ComfyUI HamDraw plugin (spec chp/2)
  //
  // The plugin ships the graphs, so the client names a category, picks a
  // resolution out of the frames the plugin published, and never uploads a
  // workflow. The plugin also serves the finished image itself, which keeps a
  // single password for submitting and downloading alike.
  //
  // Three calls, each with one job: the information endpoint says what the
  // server can do, /chp/jobs/{id}/progress is the light one to poll while
  // waiting, and /chp/jobs/{id} is read once, at the end, because that is where
  // the results are. Nothing here translates a prompt: the plugin owns the
  // translator and its memory, and decides by itself whether a model needs
  // English.
  // --------------------------------------------------------------------- //

  //: The plugin names categories semantically, not after a model. A slot is the
  //: app's own word for the same thing, and this map is the one place the two are
  //: tied together — which is why a task's config keeps a slot and nothing else. A
  //: second name for the same task is how the two drift apart, and a reader who
  //: follows only one of them reads the wrong frames and the wrong step count.
  //:
  //: 高清渲染 is the plugin's `upscale` and 快速生图 is its `fast` — one workflow
  //: per task on the server, one slot per task here. The plugin renamed `quick` in
  //: chp/2 and kept no alias, so a client that still spelled it that way would be
  //: answered `unsupported_category` rather than quietly served as `fast`.
  var CHP_CATEGORY = { quick: "fast", inpaint: "inpaint", upscale: "upscale" };
  //: The address a CHP task starts from. The plugin travels with this app, so
  //: choosing that API format fills the server address in rather than leaving the
  //: box empty for the user to type.
  var CHP_EXAMPLE = "http://192.168.1.1:8188";
  //: Examples an earlier version of this app offered as that same starting address.
  //: A connection still holding one was never really chosen by the user, so it
  //: moves up to the current example instead of pinning the app to an old address.
  var CHP_PAST_EXAMPLES = [CHP_EXAMPLE, "http://192.168.1.2:8188"];
  //: The last information document. It is what lets the client offer the
  //: resolutions a category really accepts, read the addresses it publishes, name
  //: the model it will run and say whether a Chinese prompt needs translating —
  //: and it is refreshed every time the connection is tested.
  var chpInfo = null;

  //: The origin a CHP request is addressed against, with the root stripped.
  //:
  //: The root is not a version of the plugin — `/chp` is the only one it serves
  //: now — it is tolerance for what a *user's address box* may hold: nothing, the
  //: root, the information path, or a root an older version of this app put there.
  //: Every one of them resolves to the same origin, which is what the document's
  //: relative `endpoints` are read against.
  function chpBase(endpoint) {
    var value = u.stripSlash(endpoint), marker = value.search(/\/(?:chp|cvp|hamdraw)(?:\/|$)/i);
    return marker > 0 ? value.slice(0, marker) : value;
  }
  //: The category a slot submits. Only the slot is read: `task` and `capability`
  //: were this app's own fields for the same thing and are gone, and a stored copy
  //: of either would name a category this version does not recognise.
  function chpCategory(config) { return CHP_CATEGORY[(config && config.slot) || ""] || "fast"; }
  //: The category a slot submits, resolved exactly the way a request resolves it.
  //: `preset()` and the connection test need this: they hold a slot name, and the
  //: plugin's document is keyed by the plugin's word for the same task.
  function chpSlotCategory(slot) { return chpCategory({ slot: slot }); }
  //: The address a CHP task should really use. A blank one, or one that is only an
  //: example this app used to offer, resolves to the current example; an address
  //: the user typed is returned untouched.
  function chpAddress(stored) {
    var value = String(stored == null ? "" : stored).trim();
    return !value || CHP_PAST_EXAMPLES.indexOf(value) >= 0 ? CHP_EXAMPLE : value;
  }
  function chpRemember(document) { if (document && document.spec) chpInfo = document; return chpInfo; }
  //: One `rules[]` entry — the category's own contract. `category` is the only
  //: spelling: chp/2 keeps no aliases, so a name that is not in the table is
  //: nothing rather than another word for something else.
  function chpRule(name) {
    var wanted = String(name == null ? "" : name).toLowerCase(), list = (chpInfo && chpInfo.rules) || [];
    if (!wanted) return null;
    return list.filter(function (item) {
      return item && String(item.category || "").toLowerCase() === wanted;
    })[0] || null;
  }
  //: The frames a category can be asked for, in document order, across every
  //: ability that answers it. Order is part of the contract — the first entry here
  //: is what the plugin takes when a job omits `resolution` — so nothing reorders
  //: this list, and nothing invents an entry that is not in it.
  function chpFrames(name) {
    var wanted = String(name == null ? "" : name).toLowerCase(), frames = [];
    ((chpInfo && chpInfo.abilities) || []).forEach(function (ability) {
      ((ability && ability.frames) || []).forEach(function (frame) {
        if (frame && String(frame.category || "").toLowerCase() === wanted) frames.push(frame);
      });
    });
    return frames;
  }
  //: The abilities entry that answers a category — the one whose frames name it.
  //: Where a category's files and its readiness live: an ability is what *answers*
  //: a category, and one ability may answer several.
  function chpAbility(name) {
    var wanted = String(name == null ? "" : name).toLowerCase();
    return ((chpInfo && chpInfo.abilities) || []).filter(function (ability) {
      return ((ability && ability.frames) || []).some(function (frame) {
        return frame && String(frame.category || "").toLowerCase() === wanted;
      });
    })[0] || null;
  }
  //: `"768x1344"` → `[768, 1344]`. The resolution is one string in the document
  //: and one string in the request; this app composes on a square it keeps as two
  //: numbers, so the string is parsed at this edge and formatted again on the way
  //: out — never re-derived from anything else.
  function chpPair(resolution) {
    var parts = String(resolution == null ? "" : resolution).split("x");
    return [Number(parts[0]) || 0, Number(parts[1]) || 0];
  }
  //: Every resolution a category publishes, as whole [width, height] pairs. Kept
  //: as pairs because a canvas is one: a client that keeps only the first number
  //: silently turns a published 768×1344 into a square 768, and nothing anywhere
  //: reports a wrong shape.
  function chpSizes(name) {
    var pairs = [];
    chpFrames(name).forEach(function (frame) {
      ((frame && frame.resolution) || []).forEach(function (value) { pairs.push(chpPair(value)); });
    });
    return pairs.filter(function (pair) { return pair[0] > 0 && pair[1] > 0; });
  }
  //: The canvas this app locks for a category: the first frame labelled `1:1`, as
  //: both its edges at once.
  //:
  //: The label is what is read, and that is the point. A ratio in this contract is
  //: a name its author chose rather than the quotient of the two numbers — a
  //: published `768 × 1344` is called `9:16` — so a client that searched the list
  //: for `width === height` would be computing a label instead of reading one, and
  //: the search would only ever work by luck. HamDraw composes on a square, so it
  //: takes the square frame's own first resolution and nothing else.
  //:
  //: `null` when the category publishes no square. The preset then keeps the
  //: app's own canvas and `lockedCanvasError` names the refusal — a plugin whose
  //: frames cannot fill this app's square composition is told about, not silently
  //: stretched into.
  function chpSquare(name) {
    var frames = chpFrames(name);
    for (var index = 0; index < frames.length; index += 1) {
      if (String(frames[index].ratio || "") !== "1:1") continue;
      var pair = chpPair((frames[index].resolution || [])[0]);
      if (pair[0] > 0 && pair[1] > 0) return pair;
    }
    return null;
  }
  //: A default the category declares. Only `ref_strength` is left: the step count
  //: is this plugin's own extension key inside `ext_params` rather than a
  //: published field, so the app keeps its own numbers for it.
  function chpDefault(name, field) {
    var rule = chpRule(name), defaults = rule && rule.defaults, value = defaults ? defaults[field] : null;
    return value == null ? null : value;
  }
  //: One address out of the document's `endpoints`, resolved against the address
  //: the user typed. A relative value is a path on the same origin as the
  //: information endpoint; an absolute one is used as it stands, because the
  //: contract lets a server put a task endpoint on another machine. Reading these
  //: is a rule — assembling `/chp/...` by hand is what this version stops doing —
  //: so the recommended path survives only as the fallback for a document read
  //: before the key existed, or for a task that was submitted before any test.
  function chpUrl(base, name, fallback) {
    var published = chpInfo && chpInfo.endpoints ? chpInfo.endpoints[name] : "";
    var value = String(published == null ? "" : published).trim() || fallback;
    if (/^https?:/i.test(value)) return value;
    return base + (value.charAt(0) === "/" ? value : "/" + value);
  }
  //: A URL template out of `endpoints`, with this job's id in it. The contract
  //: writes `{job_id}`; the index placeholder is never needed here, because the
  //: plugin hands back output URLs that are already complete.
  function chpJobUrl(base, name, fallback, jobId) {
    return chpUrl(base, name, fallback).split("{job_id}").join(encodeURIComponent(jobId));
  }
  //: What a service can actually make, as whole [width, height] pairs — or `null` when
  //: this app has no way to know. The two are deliberately different: an unknown
  //: service is left to answer for itself, while a known list that misses the canvas
  //: is a refusal this app can name before anything is sent.
  //:
  //: CHP answers with the document it publishes about itself. The OpenAI image API is
  //: documented per model. Stability takes an aspect ratio rather than a size, and 1:1
  //: — which is every task here — is always one of them, so there is nothing to judge.
  function publishedCanvases(config) {
    if (config.protocol === "chp") {
      var category = chpCategory(config);
      return chpRule(category) ? chpSizes(category) : null;
    }
    if (config.protocol === "openai-images") return OPENAI_IMAGE_SIZES[String(config.model || "").trim().toLowerCase()] || null;
    return null;
  }
  //: The refusal to report when a task's locked canvas is not one its service makes.
  //: HamDraw runs one fixed square per task and the sheet offers no menu, so a shape
  //: the service cannot produce would otherwise travel to the server — which answers
  //: about the model, not about the size, and that reads as a broken setup.
  function lockedCanvasError(config) {
    var side = [Number(config.width) || 0, Number(config.height) || 0];
    if (!side[0] || !side[1]) return null;
    // sd-webui takes a rule rather than a list: a square whose edges divide by 64.
    if (config.protocol === "sd-webui") {
      if (side[0] === side[1] && side[0] % 64 === 0) return null;
      return new Error(t("这个任务固定输出 1:1 的 " + side[0] + " × " + side[1] + "，SD WebUI 只接受边长是 64 倍数的正方形。请检查模型配置",
                         "This task always produces a 1:1 " + side[0] + " × " + side[1] + ", and SD WebUI only accepts a square whose edges are a multiple of 64. Check the model settings"));
    }
    var pairs = publishedCanvases(config);
    if (!pairs || !pairs.length) return null;
    if (pairs.some(function (pair) { return pair[0] === side[0] && pair[1] === side[1]; })) return null;
    var list = pairs.map(function (pair) { return pair[0] + " × " + pair[1]; }).join(" / ");
    return new Error(t("这个任务固定输出 " + side[0] + " × " + side[1] + "，这个接口只接受 " + list + "。请改用支持该画幅的接口或模型",
                       "This task always produces " + side[0] + " × " + side[1] + ", and this service only accepts " + list + ". Use a service or model that supports it"));
  }
  //: A refusal the plugin sent, in the words a person can act on. Matched on the
  //: error *codes*, never on the Chinese sentence: the plugin's own messages say
  //: 模型 in places that are not about the model — a workflow that failed for a
  //: missing node says it too — so matching the sentence would relabel a real
  //: workflow failure as "no model". The codes are published in the document's
  //: `errors`, which is what makes them the stable half.
  function chpError(error) {
    var text = String(error && error.message || error || "");
    if (/unauthorized|401/.test(text)) return new Error(t("访问密码不正确，请在 ComfyUI 的 CHP 插件配置节点里核对密码", "Wrong access password. Check the password set in the ComfyUI CHP plugin's config node."));
    if (/no_model/.test(text)) return new Error(t("插件没有可用模型，请先在 ComfyUI 的 CHP 插件配置节点里为这个场景选好模型", "The plugin has no model. Choose the one this category runs on in the ComfyUI CHP plugin's config node."));
    if (/unsupported_category/.test(text)) return new Error(t("插件不认识这个场景，请升级 CHP 插件", "The plugin does not know this category. Please update the CHP plugin."));
    if (/unsupported_size/.test(text)) return new Error(t("插件不接受这个画幅；请点一次测试连接，读取插件当前的画幅表", "The plugin does not accept this resolution. Test the connection once to read the plugin's current frames."));
    if (/unsupported_steps/.test(text)) return new Error(t("插件不接受这个步数；请点一次测试连接，读取插件当前的取值", "The plugin does not accept this step count. Test the connection once to read what it currently takes."));
    if (/busy|429/.test(text)) return new Error(t("插件队列已满，请稍后再试", "The plugin queue is full. Try again shortly."));
    return error;
  }
  //: The headers a CHP request carries. A request that has a body deliberately
  //: leaves the password out of them: the contract puts it in `chp_params` and asks
  //: a request to use one carrier rather than both, and a secret in a header is a
  //: secret in whatever a proxy logs. A `GET` has no body, so there the header is
  //: the only carrier there is.
  function chpHeaders(config, contentType) {
    var output = u.parseHeaders(config.customHeaders || "");
    if (contentType) output["Content-Type"] = contentType;
    return output;
  }
  function chpStrength(config, strength) {
    var base = Number(config && config.refStrength);
    var rendered = Boolean(config) && config.slot === "upscale";
    if (!Number.isFinite(base) || base <= 0) base = rendered ? 0.75 : 0.55;
    // A render exists to enlarge the picture that is already on the canvas, not to
    // reinterpret it, so it keeps its own reference weight instead of being scaled
    // by the artwork-wide creativity slider. That slider stays what it looks like:
    // a control for the free-hand quick draw. Scaling the render by it made the
    // one task that must preserve the artwork the most destructive pass in the app.
    if (rendered) return u.clamp(base, 0.05, 0.95);
    // The artwork slider runs 0–100% with 80% as the neutral point, so the
    // per-slot reference weight stays the default while the slider still lets
    // the user trade fidelity for freedom.
    var value = Number(strength);
    if (!Number.isFinite(value) || value <= 0) value = 0.8;
    return u.clamp(base * (value / 0.8), 0.05, 0.95);
  }
  async function chpGenerate(config, input) {
    var base = chpBase(config.endpoint), category = chpCategory(config);
    // The canvas this job will ask for, taken once: the request and everything that
    // judged it read the same pair, so the row the sheet prints is what is submitted.
    var canvas = [Number(config.width) || 512, Number(config.height) || 512];
    var requestHeaders = chpHeaders(config, "application/json");
    // The model layer, and this plugin's two keys in it. Neither is a top-level
    // field any more: the contract recognises no `steps` and no `negative_prompt`,
    // so a client that sent them there would have them echoed back in
    // `job.ignored` instead of used — a rename made visible, not a silent no-op.
    var ext = { step: Number(config.steps) || 8 };
    if (input.negativePrompt) ext.negative_prompt = input.negativePrompt;
    var body = {
      // The category, never a model name and never the retired `capability` /
      // `task`: the plugin renaming a category must not require a new client, and a
      // client still sending one of those old names is told which field it was.
      category: category,
      // The resolution is the string the plugin published, spelled the way its
      // frame table spells it. The app keeps its own canvas as two numbers; this is
      // the one place they are written back out, and nothing recomputes the shape.
      resolution: canvas[0] + "x" + canvas[1],
      prompt: input.prompt,
      seed: Number(input.seed) >= 0 ? Number(input.seed) : Math.floor(Math.random() * 9007199254740991),
      ref_strength: chpStrength(config, input.strength),
      ext_params: ext
    };
    // The CHP layer, and the request's only password carrier: this one has a body,
    // so the secret goes in it rather than into a header. An empty password means
    // the plugin checks nothing, and then there is nothing to carry.
    if (config.apiKey) body.chp_params = { password: config.apiKey };
    if (input.imageDataUrl) body.image_base64 = input.imageDataUrl;
    if (category === "inpaint") {
      if (!input.maskDataUrl) throw new Error(t("局部重绘缺少蒙版，请先用局部工具标记要改的区域", "Local redraw needs a mask. Mark the area with the mask tool first."));
      body.mask_base64 = input.maskDataUrl;
      //: The request carries no grow field at all: the client widens the stroke
      //: itself (MASK_GROW in canvas-io.js), because a server side grow dilates
      //: the mask until it is flat again, which is exactly the hard edge the
      //: feather removes.
    }
    var label = category === "inpaint" ? t("局部重绘", "Local redraw")
      : category === "upscale" ? t("高清渲染", "Render")
      : t("快速生图", "Quick draw");
    app.events.emit("generation:progress", t("正在提交" + label + "任务…", "Submitting the " + label + " job…"));
    var submitted;
    try {
      submitted = await network.request({ url: chpUrl(base, "jobs", "/chp/jobs"), method: "POST", headers: requestHeaders, bodyText: JSON.stringify(body), timeoutMs: config.timeoutMs });
      ensureOk(submitted, requestHeaders);
    } catch (error) { throw chpError(error); }
    var accepted = u.parseJson(submitted.bodyText || "", null), jobId = accepted && accepted.job && accepted.job.id;
    if (!jobId) throw new Error(t("CHP 插件未返回任务 ID，请确认插件版本与地址", "The CHP plugin did not return a job id. Check the plugin version and address."));
    // Both addresses come out of the document the plugin published, read once here
    // so a poll cannot drift onto a different path halfway through a job.
    var progressUrl = chpJobUrl(base, "progress", "/chp/jobs/{job_id}/progress", jobId);
    var deadline = Date.now() + (Number(config.timeoutMs) || 120000), state = "";
    while (Date.now() < deadline) {
      await u.sleep(700);
      var polled;
      try {
        polled = await network.request({ url: progressUrl, method: "GET", headers: headers(config), timeoutMs: 15000 });
        ensureOk(polled, headers(config));
      } catch (error) { throw chpError(error); }
      var payload = u.parseJson(polled.bodyText || "", null), frame = payload && payload.job;
      if (!frame) continue;
      state = String(frame.state || "");
      if (state === "completed") break;
      if (state === "failed") throw new Error(t("CHP 工作流执行失败：", "CHP workflow failed: ") + String(frame.error || "unknown"));
      if (state === "cancelled") throw new Error(t("CHP 任务已取消", "The CHP job was cancelled"));
      // The progress call answers with a state and a queue position and nothing
      // else — a percentage is deliberately not part of the contract. The wait
      // is therefore reported as an indeterminate one, and only the queue, which
      // every implementation can actually count, gets a number.
      var ahead = Number(frame.queue_position);
      app.events.emit("generation:progress", Number.isFinite(ahead) && ahead > 0
        ? t(label + "排队中，前面还有 " + ahead + " 个任务…", label + " queued behind " + ahead + " job(s)…")
        : t(label + "进行中…", label + " in progress…"));
    }
    if (state !== "completed") throw new Error(t("CHP 生成超时，任务可能仍在服务端队列中", "CHP timed out; the job may still be queued on the server"));
    // The light call said it was done; the heavy one is where the results live,
    // so it is read once, here, rather than on every poll.
    var finished;
    try {
      finished = await network.request({ url: chpJobUrl(base, "job", "/chp/jobs/{job_id}", jobId), method: "GET", headers: headers(config), timeoutMs: 30000 });
      ensureOk(finished, headers(config));
    } catch (error) { throw chpError(error); }
    var job = (u.parseJson(finished.bodyText || "", null) || {}).job || null;
    if (!job || job.state !== "completed") throw new Error(t("CHP 任务结束时状态是 " + String(job && job.state || "未知"), "The CHP job ended in state " + String(job && job.state || "unknown")));
    var output = job.outputs && job.outputs[0];
    if (!output || !output.url) throw new Error(t("CHP 任务完成，但没有图片输出", "The CHP job finished without an image"));
    var imageUrl = /^https?:/i.test(output.url) ? output.url : base + output.url;
    app.events.emit("generation:progress", t("正在读取生成图片…", "Loading the generated image…"));
    var downloaded;
    try {
      downloaded = await network.request({ url: imageUrl, method: "GET", headers: headers(config), timeoutMs: 60000 });
      ensureOk(downloaded, headers(config));
    } catch (error) { throw chpError(error); }
    var result = await responseImage(downloaded, headers(config));
    result.metadata = job;
    return result;
  }

  async function generate(config, input) {
    validate(config);
    if (config.protocol === "chp") return chpGenerate(config, input);
    if (config.protocol === "openai-images") return openAiGenerate(config, input);
    if (config.protocol === "sd-webui") return sdWebuiGenerate(config, input);
    if (config.protocol === "stability") return stabilityGenerate(config, input);
    throw new Error("不支持的图像接口协议：" + config.protocol);
  }
  function validate(config) {
    if (!config) throw new Error("模型配置不存在");
    u.validateEndpoint(config.endpoint);
    if (config.protocol === "stability" && !config.apiKey && !u.isPrivateHost(new URL(config.endpoint).hostname)) throw new Error(app.i18n ? app.i18n.text("请先填写 API Key", "Enter an API key first") : "请先填写 API Key");
    if (config.protocol === "openai-images" && !config.model) throw new Error("请填写图像模型 ID");
    // Nothing else is judged here for CHP. There used to be a copy of the plugin's
    // own 256–2048 rule; with the frames table published, a second copy of a numeric
    // domain is a second rule that can disagree with the one the server enforces,
    // and the app's job is to be told what a service accepts, not to re-state it.
    // Every task here is locked to one square and the sheet offers no menu, so a
    // service that cannot make that square is reported before a job is built rather
    // than left to answer about the model it was asked for.
    var canvasProblem = lockedCanvasError(config);
    if (canvasProblem) throw canvasProblem;
    u.parseHeaders(config.customHeaders || "");
  }
  //: The information endpoint, read the way the contract writes the client's side
  //: down: the address the user typed *is* the information endpoint, and a
  //: recommended `<base>/chp/info` is tried once behind it for an address that
  //: carries no root this plugin answers on. Two attempts, and only the second is a
  //: guess — which is what keeps "something answered, and it was not CHP" apart
  //: from "nothing answered at all": the first is a wrong address the user can fix,
  //: the second is a network failure with its own message.
  async function chpInfoRequest(config, requestHeaders, timeoutMs) {
    var typed = u.stripSlash(config.endpoint);
    var candidates = [typed, chpBase(typed) + "/chp/info"];
    var answered = false, firstError = null;
    for (var index = 0; index < candidates.length; index += 1) {
      if (index && candidates[index] === candidates[0]) continue;
      var response;
      try {
        response = await network.request({ url: candidates[index], method: "GET", headers: requestHeaders, timeoutMs: timeoutMs });
        ensureOk(response, requestHeaders);
      } catch (error) {
        if (!firstError) firstError = error;
        // ComfyUI's own web root answers 200 with a page, and a wrong path answers
        // 404: both are answers. A request that never got one has no status, and
        // that is the case whose error is worth keeping.
        if (Number(error && error.status) > 0) answered = true;
        continue;
      }
      answered = true;
      var document = u.parseJson(response.bodyText || "", null);
      if (document && document.spec) return { status: response.status, document: document };
    }
    if (answered) throw new Error(t("这个地址不是 CHP 服务，请确认插件已安装且 ComfyUI 已重启", "That address is not a CHP server. Check that the plugin is installed and ComfyUI restarted."));
    throw firstError || new Error(t("无法连接这个地址", "Could not reach that address"));
  }
  async function test(config) {
    validate(config);
    var root, url;
    if (config.protocol === "openai-images") { root = openAiRoot(config.endpoint); url = root + "/models"; }
    else if (config.protocol === "sd-webui") url = u.stripSlash(config.endpoint) + "/sdapi/v1/sd-models";
    else if (config.protocol === "chp") url = "";
    else {
      var parsed = new URL(stabilityEndpoint(config));
      url = parsed.origin + "/v1/user/account";
    }
    var requestHeaders = headers(config), timeoutMs = Math.min(Number(config.timeoutMs) || 30000, 30000);
    if (config.protocol === "chp") {
      // One public call answers every question the model card asks: does the
      // address resolve, was the password right, does the category exist, are its
      // models installed, and does it want English. It is public on purpose, so the
      // first two are answered together instead of being told apart by a second
      // failing request.
      var found = await chpInfoRequest(config, requestHeaders, timeoutMs);
      var document = chpRemember(found.document);
      var auth = document.auth || {};
      if (auth.required && !auth.authorized) throw new Error(t("访问密码不正确，请在 ComfyUI 的 CHP 插件配置节点里核对密码", "Wrong access password. Check the password set in the ComfyUI CHP plugin's config node."));
      var wanted = chpCategory(config), rule = chpRule(wanted);
      if (!rule) throw new Error(t("CHP 插件不支持“" + wanted + "”这个场景，请升级 CHP 插件", "The CHP plugin does not offer the " + wanted + " category. Please update the CHP plugin."));
      // Readiness belongs to the ability, not to the category: a category is what a
      // client asks for, and an ability is the set of files that answers it. Absent
      // is a different sentence from unready — the first means the document does not
      // serve this category at all, the second means the files are not installed.
      var ability = chpAbility(wanted);
      if (!ability) throw new Error(t("插件没有可以回答“" + wanted + "”的模型组，请在 ComfyUI 的 CHP 插件配置节点里检查", "The plugin has no model group answering " + wanted + ". Check the ComfyUI CHP plugin's config node."));
      if (!ability.ready) throw new Error(t("插件还没有为“" + wanted + "”装好模型，请在 ComfyUI 的 CHP 插件配置节点里设置", "The plugin has no model installed for " + wanted + ". Set it in the ComfyUI CHP plugin's config node."));
      // This call is what makes the plugin's document known, so this is the one place
      // a canvas it cannot make is discoverable in the same breath as the connection.
      // The address is reachable, the password was right, the model is installed, and
      // the job would still be refused for its size — that combination deserves saying
      // here rather than at the first generation.
      var canvasProblem = lockedCanvasError(config);
      if (canvasProblem) throw canvasProblem;
      return {
        ok: true, status: found.status, spec: document.spec, plugin: document.plugin || {},
        category: wanted, label: rule.label || {}, ready: true,
        promptLanguage: (rule.prompt || {}).language || "",
        resolutions: chpSizes(wanted), defaults: rule.defaults || {},
        //: The files this category would run on, as the ability reports them. It is
        //: what the card names instead of reading a model name out of a request that
        //: has not been sent yet.
        files: ability.files || {},
        authRequired: Boolean(auth.required), authorized: Boolean(auth.authorized),
        translation: document.translation || null
      };
    }
    var response = await network.request({ url: url, method: "GET", headers: requestHeaders, timeoutMs: timeoutMs });
    ensureOk(response, requestHeaders);
    return { ok: true, status: response.status };
  }
  function preset(protocol, slot) {
    var name = slot === "quality" ? "upscale" : (app.defaults[slot] ? slot : "quick");
    var value = u.copy(app.defaults[name]), rendered = name === "upscale";
    // Only the slot is written: the category a task submits is resolved from it
    // through the one map above, so there is no second name in a config to go stale.
    value.slot = name;
    value.protocol = protocol;
    value.apiKey = "";
    value.customHeaders = "";
    value.workflow = "";
    if (protocol === "chp") {
      // What the plugin accepts is the plugin's to say, so once its document has
      // been read it decides the starting canvas and reference weight. With nothing
      // read yet both fall back to the app's own numbers, which is where an
      // unconfigured install starts anyway.
      //
      // The canvas is the square frame the category publishes — chosen, not merely
      // first, and read from the `1:1` label rather than by comparing the two
      // numbers. A category that publishes no square locks nothing here: the app
      // keeps its own canvas and `lockedCanvasError` names the refusal, which is
      // louder than quietly submitting a shape this app's square composition would
      // come back stretched into. The step count is not read at all: it is this
      // plugin's own key inside `ext_params`, not a published field, so the app's
      // per-task number stands.
      var category = chpSlotCategory(name);
      var canvas = chpSquare(category), strength = chpDefault(category, "ref_strength");
      value.endpoint = CHP_EXAMPLE;
      value.model = "";
      value.inputMode = "sketch";
      value.width = canvas ? canvas[0] : (rendered ? 1024 : 512);
      value.height = canvas ? canvas[1] : (rendered ? 1024 : 512);
      value.refStrength = strength == null ? (name === "inpaint" ? 0.3 : rendered ? 0.95 : 0.55) : Number(strength);
      value.timeoutMs = rendered ? 240000 : 60000;
    } else if (protocol === "openai-images") {
      value.endpoint = "https://api.openai.com/v1";
      value.model = "gpt-image-1";
      value.inputMode = "sketch";
      value.width = value.height = rendered ? 1024 : 512;
      value.quality = rendered ? "high" : "low";
      value.timeoutMs = rendered ? 180000 : 60000;
    } else if (protocol === "sd-webui") {
      value.endpoint = "http://192.168.1.2:7860";
      value.model = "";
      value.inputMode = "sketch";
      value.width = value.height = rendered ? 1024 : 512;
      value.steps = rendered ? 28 : 6;
      value.timeoutMs = rendered ? 180000 : 60000;
    } else if (protocol === "stability") {
      value.endpoint = rendered ? "https://api.stability.ai/v2beta/stable-image/generate/ultra" : "https://api.stability.ai/v2beta/stable-image/control/sketch";
      value.model = "";
      value.inputMode = rendered ? "text" : "sketch";
      value.width = value.height = rendered ? 1024 : 1024;
    }
    return value;
  }

  app.services.providers = {
    protocols: PROTOCOLS,
    generate: generate,
    test: test,
    validate: validate,
    preset: preset,
    //: The server address a CHP task starts from, and the normalizer that maps a
    //: never-chosen address onto it. The settings card uses both, so the address is
    //: filled in the moment that API format is chosen.
    exampleEndpoint: CHP_EXAMPLE,
    resolveEndpoint: chpAddress,
    //: The category a slot submits. A slot name is the app's word and the plugin
    //: keys its document by its own, so anything reading that document on a slot's
    //: behalf resolves through here first.
    slotCategory: chpSlotCategory,
    //: The shape label a canvas gets ("9:16", "16:9", "1:1"). It lives next to
    //: the sizes so the settings sheet can name the aspect without keeping a
    //: second copy of the ratio thresholds.
    aspect: aspect,
    internals: {
      openAiRoot: openAiRoot,
      chpBase: chpBase,
      chpCategory: chpCategory,
      chpSlotCategory: chpSlotCategory,
      chpStrength: chpStrength,
      chpRule: chpRule,
      chpFrames: chpFrames,
      chpAbility: chpAbility,
      chpSizes: chpSizes,
      chpSquare: chpSquare,
      chpDefault: chpDefault,
      chpUrl: chpUrl,
      chpRemember: chpRemember,
      chpError: chpError,
      publishedCanvases: publishedCanvases,
      lockedCanvasError: lockedCanvasError,
      jsonImage: jsonImage,
      aspect: aspect
    }
  };
})(window.hamdraw);
