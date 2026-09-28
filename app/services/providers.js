(function (app) {
  "use strict";

  var u = app.utils;
  var network = app.platform.haminn;
  var t = app.i18n && app.i18n.text || function (zh) { return zh; };
  var PROTOCOLS = [
    { id: "chp", name: "ComfyUI Hamdraw Plugin CHP（推荐）", description: "连接装有 HamDraw 插件 CHP 的 ComfyUI。插件自带快速生图 / 局部重绘 / 高质量渲染三套工作流，不需要导出工作流 JSON；密码在插件的配置节点里设置。中文提示词由插件自动译成英文。" },
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
  // CHP — the ComfyUI HamDraw plugin (spec chp/1)
  //
  // One contract, three capabilities. The plugin ships the graphs, so the
  // client names a capability, hands over the canvas, and never uploads a
  // workflow. The plugin also serves the finished image itself, which keeps a
  // single password for submitting and downloading alike.
  //
  // Three calls, each with one job: /chp/info says what the server can do,
  // /chp/jobs/{id}/progress is the light one to poll while waiting, and
  // /chp/jobs/{id} is read once, at the end, because that is where the results
  // are. Nothing here translates a prompt: the plugin owns the translator and
  // its memory, and decides by itself whether a model needs English.
  // --------------------------------------------------------------------- //

  //: The plugin names capabilities semantically, not after a model. A slot is
  //: the app's own word for the same thing, and this map is the one place the
  //: two are tied together.
  //:
  //: The three words are the same on both sides, and that is the point. 高清渲染
  //: is the plugin's `upscale` — one workflow per task on the server, one slot
  //: per task here. Inventing a second name for a slot is what lets a slot and
  //: the job it submits drift apart, and a reader who then follows only one of
  //: the two names reads the wrong capability's canvases and step counts.
  var CHP_CAPABILITY = { quick: "quick", inpaint: "inpaint", upscale: "upscale" };
  //: The address a ComfyUI Hamdraw Plugin task starts from. The plugin travels
  //: with this app, so choosing that API format fills the server address in rather
  //: than leaving the box empty for the user to type.
  var CHP_EXAMPLE = "http://192.168.1.1:8188";
  //: Examples an earlier version of this app offered as that same starting address.
  //: A connection still holding one was never really chosen by the user, so it
  //: moves up to the current example instead of pinning the app to an old address.
  var CHP_PAST_EXAMPLES = [CHP_EXAMPLE, "http://192.168.1.2:8188"];
  //: The last /chp/info document. It is what lets the client honour a
  //: capability's `ignores` and offer the sizes that capability really accepts,
  //: and it is refreshed every time the connection is tested.
  var chpInfo = null;

  function chpBase(endpoint) {
    var value = u.stripSlash(endpoint), marker = value.search(/\/(?:chp|cvp|hamdraw)(?:\/|$)/i);
    return marker > 0 ? value.slice(0, marker) : value;
  }
  function chpTask(config) { return CHP_CAPABILITY[config && (config.capability || config.task || config.slot)] || "quick"; }
  //: The capability a slot submits, resolved exactly the way a request resolves
  //: it. The settings sheet and `preset()` need this: they used to hand a slot
  //: name straight to `chpCapability()` / `chpSizes()` / `chpDefault()`, which
  //: are keyed by capability id, so the moment the two differ they would read
  //: the wrong entry — the wrong canvas menu, steps and reference weight.
  function chpSlotCapability(slot) { return chpTask({ slot: slot }); }
  //: The address a CHP task should really use. A blank one, or one that is only an
  //: example this app used to offer, resolves to the current example; an address
  //: the user typed is returned untouched.
  function chpAddress(stored) {
    var value = String(stored == null ? "" : stored).trim();
    return !value || CHP_PAST_EXAMPLES.indexOf(value) >= 0 ? CHP_EXAMPLE : value;
  }
  function chpRemember(document) { if (document && document.spec) chpInfo = document; return chpInfo; }
  function chpCapability(name) {
    var wanted = String(name == null ? "" : name).toLowerCase(), list = (chpInfo && chpInfo.capabilities) || [];
    if (!wanted) return null;
    return list.filter(function (item) {
      if (!item) return false;
      if (String(item.id || "").toLowerCase() === wanted) return true;
      return (item.aliases || []).some(function (alias) { return String(alias).toLowerCase() === wanted; });
    })[0] || null;
  }
  //: The canvases a capability publishes, as whole [width, height] pairs. The
  //: canvas belongs to the plugin and it is not always square — chp/1 2.4.0
  //: publishes 768×1344 for render — so a client that keeps only the first
  //: number silently rewrites the shape it was offered into a square.
  function chpSizes(name) {
    var capability = chpCapability(name), pairs = capability && capability.values && capability.values.size;
    return (pairs || []).map(function (pair) {
      return [Number(pair && pair[0]), Number(pair && pair[1])];
    }).filter(function (pair) { return pair[0] > 0 && pair[1] > 0; });
  }
  function chpDefault(name, field) {
    var capability = chpCapability(name), defaults = capability && capability.defaults, value = defaults ? defaults[field] : null;
    return value == null ? null : value;
  }
  function chpIgnores(name, field) {
    var capability = chpCapability(name);
    return ((capability && capability.ignores) || []).some(function (item) { return String(item) === field; });
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
      var capability = chpCapability(chpTask(config));
      return capability ? chpSizes(chpTask(config)) : null;
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
  function chpError(error) {
    var text = String(error && error.message || error || "");
    if (/unauthorized|401/.test(text)) return new Error(t("访问密码不正确，请在 ComfyUI 的 HamDraw 配置节点里核对密码", "Wrong access password. Check the password set in the ComfyUI HamDraw config node."));
    if (/no_model|模型/.test(text)) return new Error(t("插件没有可用模型，请先在 ComfyUI 的 HamDraw 配置节点里为这个能力选好模型", "The plugin has no model. Choose one for this capability in the ComfyUI HamDraw config node first."));
    if (/unsupported_capability|unsupported_task/.test(text)) return new Error(t("插件不认识这个能力，请升级插件", "The plugin does not know this capability. Please update it."));
    if (/busy|429/.test(text)) return new Error(t("插件队列已满，请稍后再试", "The plugin queue is full. Try again shortly."));
    return error;
  }
  function chpStrength(config, strength) {
    var base = Number(config && config.refStrength);
    var rendered = Boolean(config) && (config.task === "upscale" || config.slot === "upscale");
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
    var base = chpBase(config.endpoint), api = base + "/chp", capability = chpTask(config);
    // The canvas this job will ask for, taken once: the request and everything that
    // judged it read the same pair, so the row the sheet prints is what is submitted.
    var canvas = [Number(config.width) || 512, Number(config.height) || 512];
    var requestHeaders = headers(config, "application/json");
    var body = {
      // The capability id, never a model name and never the old `task`: the
      // plugin renaming a capability must not require a new client.
      capability: capability,
      prompt: input.prompt,
      seed: Number(input.seed) >= 0 ? Number(input.seed) : Math.floor(Math.random() * 9007199254740991),
      size: canvas,
      steps: Number(config.steps) || 8,
      ref_strength: chpStrength(config, input.strength)
    };
    // A capability that declares a field ignored is not sent it: the server
    // would drop it anyway and report it back, and sending it would let the
    // user believe a control did something. Knowing which fields those are is
    // what the last /chp/info was for.
    if (!chpIgnores(capability, "negative_prompt")) body.negative_prompt = input.negativePrompt;
    if (input.imageDataUrl) body.image_base64 = input.imageDataUrl;
    if (capability === "inpaint") {
      if (!input.maskDataUrl) throw new Error(t("局部重绘缺少蒙版，请先用局部工具标记要改的区域", "Local redraw needs a mask. Mark the area with the mask tool first."));
      body.mask_base64 = input.maskDataUrl;
      body.grow_mask_by = u.clamp(Number(config.growMaskBy) || 8, 0, 64);
    }
    var label = capability === "inpaint" ? t("局部重绘", "Local redraw")
      : capability === "upscale" ? t("高清渲染", "Render")
      : t("快速生图", "Quick draw");
    app.events.emit("generation:progress", t("正在提交" + label + "任务…", "Submitting the " + label + " job…"));
    var submitted;
    try {
      submitted = await network.request({ url: api + "/jobs", method: "POST", headers: requestHeaders, bodyText: JSON.stringify(body), timeoutMs: config.timeoutMs });
      ensureOk(submitted, requestHeaders);
    } catch (error) { throw chpError(error); }
    var accepted = u.parseJson(submitted.bodyText || "", null), jobId = accepted && accepted.job && accepted.job.id;
    if (!jobId) throw new Error(t("CHP 插件未返回任务 ID，请确认插件版本与地址", "The CHP plugin did not return a job id. Check the plugin version and address."));
    var deadline = Date.now() + (Number(config.timeoutMs) || 120000), state = "";
    while (Date.now() < deadline) {
      await u.sleep(700);
      var polled;
      try {
        polled = await network.request({ url: api + "/jobs/" + encodeURIComponent(jobId) + "/progress", method: "GET", headers: headers(config), timeoutMs: 15000 });
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
      finished = await network.request({ url: api + "/jobs/" + encodeURIComponent(jobId), method: "GET", headers: headers(config), timeoutMs: 30000 });
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
    if (config.protocol === "chp" && !(Number(config.width) >= 256 && Number(config.width) <= 2048 && Number(config.height) >= 256 && Number(config.height) <= 2048)) throw new Error(app.i18n ? app.i18n.text("画幅需为 256–2048", "Use a canvas size between 256 and 2048") : "画幅需为 256–2048");
    // Every task here is locked to one square, and the sheet offers no menu, so a
    // service that cannot make that square is reported before a job is built rather
    // than left to answer about the model it was asked for.
    var canvasProblem = lockedCanvasError(config);
    if (canvasProblem) throw canvasProblem;
    u.parseHeaders(config.customHeaders || "");
  }
  async function test(config) {
    validate(config);
    var root, url;
    if (config.protocol === "openai-images") { root = openAiRoot(config.endpoint); url = root + "/models"; }
    else if (config.protocol === "sd-webui") url = u.stripSlash(config.endpoint) + "/sdapi/v1/sd-models";
    else if (config.protocol === "chp") url = chpBase(config.endpoint) + "/chp/info";
    else {
      var parsed = new URL(stabilityEndpoint(config));
      url = parsed.origin + "/v1/user/account";
    }
    var requestHeaders = headers(config), response = await network.request({ url: url, method: "GET", headers: requestHeaders, timeoutMs: Math.min(Number(config.timeoutMs) || 30000, 30000) });
    ensureOk(response, requestHeaders);
    if (config.protocol === "chp") {
      // One public call answers every question the model card asks: does the
      // address resolve, was the password right, does the capability exist, are
      // its models installed, and does it want English. It is public on
      // purpose, so the first two are answered together instead of being told
      // apart by a second failing request.
      var document = chpRemember(u.parseJson(response.bodyText || "", null));
      if (!document || !document.spec) throw new Error(t("这个地址不是 CHP 服务，请确认插件已安装且 ComfyUI 已重启", "That address is not a CHP server. Check that the plugin is installed and ComfyUI restarted."));
      var auth = document.auth || {};
      if (auth.required && !auth.authorized) throw new Error(t("访问密码不正确，请在 ComfyUI 的 HamDraw 配置节点里核对密码", "Wrong access password. Check the password set in the ComfyUI HamDraw config node."));
      var wanted = chpTask(config), capability = chpCapability(wanted);
      if (!capability) throw new Error(t("CHP 插件不支持“" + wanted + "”能力，请升级插件", "The CHP plugin does not offer the " + wanted + " capability. Please update it."));
      if (!capability.ready) throw new Error(t("插件的" + wanted + "能力还没有选好模型，请在 ComfyUI 的 HamDraw 配置节点里设置", "The plugin has no model for " + wanted + ". Set it in the ComfyUI HamDraw config node."));
      // This call is what makes the plugin's document known, so this is the one place
      // a canvas it cannot make is discoverable in the same breath as the connection.
      // The address is reachable, the password was right, the model is installed, and
      // the job would still be refused for its size — that combination deserves saying
      // here rather than at the first generation.
      var canvasProblem = lockedCanvasError(config);
      if (canvasProblem) throw canvasProblem;
      return {
        ok: true, status: response.status, spec: document.spec, plugin: document.plugin || {},
        capability: wanted, label: capability.label || {}, ready: true,
        promptLanguage: (capability.prompt || {}).language || "",
        sizes: chpSizes(wanted), steps: (capability.values || {}).steps || [],
        defaults: capability.defaults || {}, models: capability.models || [],
        authRequired: Boolean(auth.required), authorized: Boolean(auth.authorized),
        translation: document.translation || null
      };
    }
    return { ok: true, status: response.status };
  }
  function preset(protocol, slot) {
    var name = slot === "quality" ? "upscale" : (app.defaults[slot] ? slot : "quick");
    var value = u.copy(app.defaults[name]), rendered = name === "upscale";
    value.slot = name;
    value.task = name;
    value.capability = name;
    value.protocol = protocol;
    value.apiKey = "";
    value.customHeaders = "";
    value.workflow = "";
    if (protocol === "chp") {
      // What the plugin accepts is the plugin's to say, so a capability the
      // client has already read decides the starting canvas, steps and weight.
      // With nothing read yet these fall back to the same numbers as before.
      // The lookup is by capability, not by slot: the render slot submits
      // `render`, so asking under its own name would take upscale's numbers —
      // 8 steps and up to 2048², the first of which the server rejects outright.
      var capability = chpSlotCapability(name);
      var sizes = chpSizes(capability), steps = chpDefault(capability, "steps"), strength = chpDefault(capability, "ref_strength");
      // The first canvas the capability publishes is the starting one; its
      // width and height are taken together, never mirrored from one number.
      var canvas = sizes.length ? sizes[0] : null;
      value.endpoint = CHP_EXAMPLE;
      value.model = "";
      value.inputMode = "sketch";
      value.width = canvas ? canvas[0] : (rendered ? 1024 : 512);
      value.height = canvas ? canvas[1] : (rendered ? 1024 : 512);
      value.steps = steps == null ? (name === "inpaint" ? 6 : rendered ? 20 : 8) : Number(steps);
      value.refStrength = strength == null ? (name === "inpaint" ? 0.3 : rendered ? 0.95 : 0.55) : Number(strength);
      value.growMaskBy = 8;
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
    //: The server address a ComfyUI Hamdraw Plugin task starts from, and the
    //: normalizer that maps a never-chosen address onto it. The settings card uses
    //: both, so the address is filled in the moment that API format is chosen.
    exampleEndpoint: CHP_EXAMPLE,
    resolveEndpoint: chpAddress,
    //: What the last /chp/info said about one capability. The model card reads
    //: this to offer the sizes the plugin really accepts instead of a guess.
    capability: chpCapability,
    capabilitySizes: chpSizes,
    //: The capability a slot submits. A slot name is the app's word and is not
    //: always the capability id — the render slot asks for `render` — so
    //: anything reading the plugin's document on a slot's behalf resolves
    //: through here first.
    slotCapability: chpSlotCapability,
    //: The shape label a canvas gets ("9:16", "16:9", "1:1"). It lives next to
    //: the sizes so the settings sheet can name the aspect without keeping a
    //: second copy of the ratio thresholds.
    aspect: aspect,
    internals: {
      openAiRoot: openAiRoot,
      chpBase: chpBase,
      chpTask: chpTask,
      chpSlotCapability: chpSlotCapability,
      chpStrength: chpStrength,
      chpCapability: chpCapability,
      chpSizes: chpSizes,
      chpRemember: chpRemember,
      chpIgnores: chpIgnores,
      publishedCanvases: publishedCanvases,
      lockedCanvasError: lockedCanvasError,
      jsonImage: jsonImage,
      aspect: aspect
    }
  };
})(window.hamdraw);
