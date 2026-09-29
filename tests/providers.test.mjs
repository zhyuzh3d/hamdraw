import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = {
  console,
  URL,
  Uint8Array,
  TextEncoder,
  setTimeout,
  clearTimeout,
  atob: value => Buffer.from(value, "base64").toString("binary"),
  btoa: value => Buffer.from(value, "binary").toString("base64")
};
context.window = context;
context.window.addEventListener = () => {};
vm.createContext(context);

function load(relative) {
  vm.runInContext(fs.readFileSync(path.join(root, relative), "utf8"), context, { filename: relative });
}
function plain(value) { return JSON.parse(JSON.stringify(value)); }

load("app/core/namespace.js");
load("app/core/utils.js");
context.hamdraw.platform.haminn = {};
load("app/services/providers.js");

const utils = context.hamdraw.utils;
const providers = context.hamdraw.services.providers;
const internals = providers.internals;

// A task's config keeps one name for the task, not three. `task` and `capability`
// were two more spellings of `slot`, and a stored copy of either is a name that
// outlives the vocabulary it was written in — which is how a slot and the category
// it submits drift apart.
assert.equal(context.hamdraw.defaults.quick.task, undefined, "a task config must not carry the retired task field");
assert.equal(context.hamdraw.defaults.upscale.capability, undefined, "a task config must not carry the retired capability field");
assert.equal(context.hamdraw.defaults.quick.slot, "quick");

assert.equal(internals.openAiRoot("https://api.openai.com/v1/images/edits"), "https://api.openai.com/v1");
// The root is not a version of the plugin — `/chp` is the only one it serves — it
// is tolerance for what the user's address box may hold: nothing, the root, the
// information path, or a root an older version of this app put there. All of them
// resolve to the same origin, which is what the document's relative `endpoints`
// are read against.
assert.equal(internals.chpBase("http://192.168.1.2:8188"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://192.168.1.2:8188/chp"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://192.168.1.2:8188/chp/jobs"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://192.168.1.2:8188/chp/info"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://192.168.1.2:8188/cvp"), "http://192.168.1.2:8188", "an address saved while the plugin was called CVP must still resolve");
assert.equal(internals.chpBase("http://192.168.1.2:8188/hamdraw/v1/jobs"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://chp-host.local:8188"), "http://chp-host.local:8188", "a hostname that merely starts with chp must survive");

// A slot is the app's word and a category is the plugin's; this map is the only
// place the two meet. `fast` is the category: chp/2 renamed `quick` and kept no
// alias, so a stored config still saying `quick` must resolve to the category the
// plugin publishes today — and never be forwarded as a category of its own.
assert.equal(internals.chpCategory({ slot: "quick" }), "fast");
assert.equal(internals.chpCategory({ slot: "inpaint" }), "inpaint");
assert.equal(internals.chpCategory({ slot: "upscale" }), "upscale");
assert.equal(internals.chpCategory({ slot: "unexpected" }), "fast");
assert.equal(internals.chpCategory({ slot: "quick", task: "quick", capability: "quick" }), "fast");
assert.equal(internals.chpCategory({ slot: "upscale", capability: "quick" }), "upscale",
  "the retired task/capability fields must not win over the slot: only the slot is read, so a stale pair cannot submit another task's category");
assert.equal(internals.chpSlotCategory("upscale"), "upscale", "the render slot's category is the plugin's own word for it");
assert.equal(internals.chpSlotCategory("inpaint"), "inpaint");

// The ComfyUI plugin travels with the app, so choosing that API format fills the
// server address in: blank, and the example an earlier version offered, both
// resolve to the current example — while an address the user typed is kept.
assert.equal(providers.exampleEndpoint, "http://192.168.1.1:8188");
assert.equal(providers.resolveEndpoint(""), providers.exampleEndpoint);
assert.equal(providers.resolveEndpoint("   "), providers.exampleEndpoint);
assert.equal(providers.resolveEndpoint("http://192.168.1.2:8188"), providers.exampleEndpoint, "an address only an earlier version offered is not a choice the user made");
assert.equal(providers.resolveEndpoint("http://192.168.124.31:8188"), "http://192.168.124.31:8188");
assert.equal(providers.preset("chp", "quick").endpoint, providers.exampleEndpoint);
assert.equal(providers.preset("chp", "upscale").endpoint, providers.exampleEndpoint);
assert.equal(internals.chpStrength({ refStrength: 0.55 }, 0.8), 0.55);
assert.ok(Math.abs(internals.chpStrength({ refStrength: 0.3 }, 0.4) - 0.15) < 1e-9, "half the artwork setting must halve the reference weight");
assert.equal(internals.chpStrength({ refStrength: 0.55 }, 1.6), 0.95, "the reference weight must clamp at the maximum");
assert.equal(internals.aspect(1024, 1024), "1:1");
assert.equal(internals.aspect(1536, 768), "16:9");
assert.equal(internals.aspect(768, 1536), "9:16");

// The information document, shaped the way the plugin derives it: two tables, and
// one checkpoint answering three categories is *one* ability while the render
// triple is another. Everything the client knows about a category — the frames it
// can be asked for, the files that answer it, whether a model needs English — is
// read out of here rather than assumed.
const document = {
  spec: "chp/2",
  plugin: { id: "hamdraw_chp", version: "3.0.0", label: { zh: "CHP 插件（ComfyUI Haminn Protocol）", en: "CHP plugin (ComfyUI Haminn Protocol)" } },
  auth: { required: true, authorized: true, scheme: "Bearer", header: "Authorization" },
  endpoints: {
    info: "/chp/info", jobs: "/chp/api/jobs", job: "/chp/api/jobs/{job_id}",
    progress: "/chp/api/jobs/{job_id}/progress", output: "/chp/api/jobs/{job_id}/output/{index}",
    cancel: "/chp/api/jobs/{job_id}/cancel", translate: "/chp/translate"
  },
  rules: [
    { category: "fast", rule: "txt-ref-2-img", signature: "txt-ref-2-img", input: "txt-ref-2-img/v1",
      label: { zh: "快速生图", en: "Quick draw" }, prompt: { language: "en" },
      needs: { prompt: true, image: true, mask: false }, defaults: { ref_strength: 0.55 } },
    { category: "inpaint", rule: "txt-msk-ref-2-img", signature: "txt-msk-ref-2-img", input: "txt-msk-ref-2-img/v1",
      label: { zh: "局部重绘", en: "Local redraw" }, prompt: { language: "en" },
      needs: { prompt: true, image: true, mask: true }, defaults: { ref_strength: 0.3 } },
    { category: "upscale", rule: "txt-ref-2-img", signature: "txt-ref-2-img", input: "txt-ref-2-img/v1",
      label: { zh: "图像放大", en: "Upscale" }, prompt: { language: "en" },
      needs: { prompt: true, image: true, mask: false }, defaults: { ref_strength: 0.75 } },
    { category: "render", rule: "txt-ref-2-img", signature: "txt-ref-2-img", input: "txt-ref-2-img/v1",
      label: { zh: "高质量生图", en: "High quality render" }, prompt: { language: "any" },
      needs: { prompt: true, image: false, mask: false }, defaults: { ref_strength: 0.95 } }
  ],
  abilities: [
    { name: "DreamShaper8_LCM.safetensors", files: { checkpoint: "DreamShaper8_LCM.safetensors" }, ready: true, missing: [], frames: [
      { ratio: "1:1", category: "fast", resolution: ["512x512"] },
      { ratio: "4:3", category: "fast", resolution: ["576x384"] },
      { ratio: "3:4", category: "fast", resolution: ["384x576"] },
      { ratio: "1:1", category: "inpaint", resolution: ["512x512"] },
      { ratio: "4:3", category: "inpaint", resolution: ["576x384"] },
      { ratio: "3:4", category: "inpaint", resolution: ["384x576"] },
      { ratio: "1:1", category: "upscale", resolution: ["1024x1024", "2048x2048"] }
    ] },
    { name: "qwen2.1", files: { unet: "qwen_image_21_fp8.safetensors", clip: "qwen_2.1_clip.safetensors", vae: "qwen_image_vae.safetensors" }, ready: true, missing: [], frames: [
      { ratio: "1:1", category: "render", resolution: ["1024x1024"] },
      { ratio: "9:16", category: "render", resolution: ["768x1344"] },
      { ratio: "16:9", category: "render", resolution: ["1344x768"] },
      { ratio: "3:4", category: "render", resolution: ["832x1152"] },
      { ratio: "4:3", category: "render", resolution: ["1152x832"] },
      { ratio: "2:3", category: "render", resolution: ["832x1216"] },
      { ratio: "3:2", category: "render", resolution: ["1216x832"] },
      { ratio: "21:9", category: "render", resolution: ["1536x640"] }
    ] }
  ],
  translation: { available: true }
};
internals.chpRemember(document);
assert.equal(internals.chpRule("render").prompt.language, "any", "a category that reads Chinese must say so");
// One category, one name. chp/2 keeps no aliases, so a word from the old table must
// not resolve to anything: the client would otherwise submit a category the server
// refuses, and read the wrong entry while doing it.
assert.equal(internals.chpRule("qwen"), null, "a category must not be found through an alias: there are none");
assert.equal(internals.chpRule("fast").rule, "txt-ref-2-img");
assert.equal(internals.chpRule("inpaint").signature, "txt-msk-ref-2-img", "the signature is read, never recomputed from the rule name");
assert.equal(internals.chpRule("nonexistent"), null);
// Order is part of the contract — the first frame of a category is what the plugin
// takes when a job omits `resolution` — so the reader must not sort or filter it.
assert.deepEqual(plain(internals.chpFrames("fast")).map(frame => frame.ratio), ["1:1", "4:3", "3:4"]);
assert.deepEqual(plain(internals.chpFrames("render")).map(frame => frame.ratio), ["1:1", "9:16", "16:9", "3:4", "4:3", "2:3", "3:2", "21:9"]);
assert.deepEqual(plain(internals.chpFrames("nonexistent")), [], "a category the document does not carry offers no frames rather than a guess");
// A canvas is a pair, never one number. The plugin publishes 768×1344 for render,
// and a client that kept only the first number would silently turn that portrait
// into a square 768 — a wrong shape with nothing anywhere reporting it.
assert.deepEqual(plain(internals.chpSizes("upscale")), [[1024, 1024], [2048, 2048]], "the resolutions a category accepts must come from its frames, as whole pairs");
assert.deepEqual(plain(internals.chpSizes("render")).slice(0, 3), [[1024, 1024], [768, 1344], [1344, 768]], "a portrait canvas must survive as a pair");
assert.deepEqual(plain(internals.chpSizes("inpaint")), [[512, 512], [576, 384], [384, 576]]);
assert.deepEqual(plain(internals.chpSizes("nonexistent")), [], "a category the document does not carry offers nothing rather than a guess");
assert.equal(internals.aspect(768, 1344), "9:16", "the shape label must be read off both numbers");
// Readiness and files belong to the ability that answers the category — the set of
// models a job would really run on — and not to the category, which is only what a
// client asks for.
assert.deepEqual(plain(internals.chpAbility("upscale").files), { checkpoint: "DreamShaper8_LCM.safetensors" }, "the files of a category come from the ability that answers it");
assert.equal(internals.chpAbility("render").name, "qwen2.1");
assert.equal(internals.chpAbility("nonexistent"), null);
assert.equal(internals.chpDefault("upscale", "ref_strength"), 0.75, "the reference weight is a published default");
assert.equal(internals.chpDefault("upscale", "steps"), null, "the step count is not a published field: the app keeps its own");
assert.deepEqual(plain(internals.chpSquare("upscale")), [1024, 1024],
  "the square frame's first resolution is the one taken, not its last: the frame publishes 1024 before 2048, and both edges come out of the same entry");
assert.deepEqual(plain(internals.chpSquare("fast")), [512, 512], "the square frame of a category that publishes one is read as a pair");

// Addresses come out of the document. Both of these are rules of the contract, not
// courtesies, so the app resolves what the plugin published instead of assembling a
// path of its own — and a value on another origin is used exactly as published.
assert.equal(internals.chpUrl("http://192.168.1.2:8188", "jobs", "/chp/jobs"), "http://192.168.1.2:8188/chp/api/jobs");
assert.equal(internals.chpUrl("http://192.168.1.2:8188", "progress", "/chp/jobs/{job_id}/progress"), "http://192.168.1.2:8188/chp/api/jobs/{job_id}/progress");
const absoluteDocument = plain(document);
absoluteDocument.endpoints.jobs = "https://render-box.lan:9000/jobs";
internals.chpRemember(absoluteDocument);
assert.equal(internals.chpUrl("http://192.168.1.2:8188", "jobs", "/chp/jobs"), "https://render-box.lan:9000/jobs", "an absolute endpoint must be used as it stands");
internals.chpRemember(document);

// `preset()` reads the plugin's document, and what it starts from is that
// document's rather than a list kept here. The canvas is the square frame the
// category publishes — chosen, not merely first — the reference weight is its
// declared default, and the step count is the app's own, because the plugin does
// not publish one.
const renderPreset = providers.preset("chp", "upscale");
assert.deepEqual(plain([renderPreset.width, renderPreset.height]), [1024, 1024],
  "the render task must start on the square frame its category publishes");
assert.equal(renderPreset.refStrength, 0.75, "the render task must start on the category's own reference weight");
assert.equal(renderPreset.steps, 8, "the step count is the app's own number, not something the document declares");
assert.equal(renderPreset.task, undefined, "a preset must not carry the retired task field");
assert.equal(renderPreset.capability, undefined, "a preset must not carry the retired capability field");

// The canvas belongs to the plugin, and the app has to follow it. Four documents,
// each one a change a plugin is allowed to make, and the canvas the app locks has
// to move with each — driven through the published document rather than asserted as
// text, because "which entry came out" is the whole question.
function withFrames(category, frames) {
  const copy = plain(document);
  copy.abilities = [{ name: "probe", files: { checkpoint: "probe.safetensors" }, ready: true, missing: [],
    frames: frames.map(frame => Object.assign({ category: category }, frame)) }];
  return copy;
}
// (1) 4:3 listed first must not become the app's canvas: the square is picked out of
// the list, not taken from the front.
internals.chpRemember(withFrames("fast", [{ ratio: "4:3", resolution: ["576x384"] }, { ratio: "1:1", resolution: ["512x512"] }, { ratio: "3:4", resolution: ["384x576"] }]));
assert.deepEqual(plain([providers.preset("chp", "quick").width, providers.preset("chp", "quick").height]), [512, 512],
  "a 4:3 frame listed first must not become the app's canvas");
// (2) The square frame's own resolution moved, so the app's canvas moves with it. The
// app keeps no second copy of a canvas it was given.
internals.chpRemember(withFrames("fast", [{ ratio: "1:1", resolution: ["640x640"] }, { ratio: "4:3", resolution: ["576x384"] }]));
assert.deepEqual(plain([providers.preset("chp", "quick").width, providers.preset("chp", "quick").height]), [640, 640],
  "the locked canvas must follow the frame the plugin publishes");
// (3) A ratio is a *label*, not the quotient of the two numbers — a published
// 768 × 1344 is called 9:16 because its author said so. So the square frame is the
// one labelled `1:1`, and a square-looking frame under another label is not it: a
// client that searched for `width === height` would be computing a label it is
// supposed to read, and would lock whichever square happened to come first.
internals.chpRemember(withFrames("fast", [{ ratio: "4:4", resolution: ["576x576"] }, { ratio: "1:1", resolution: ["512x512"] }]));
assert.deepEqual(plain([providers.preset("chp", "quick").width, providers.preset("chp", "quick").height]), [512, 512],
  "the frame labelled 1:1 is the app's canvas, not whichever frame has two equal numbers");
// (4) A `1:1` frame may publish more than one resolution, so the first is taken — the
// same one the plugin would take if a job omitted the resolution altogether. Neither
// number is one the app keeps a copy of, so this cannot pass by falling back.
internals.chpRemember(withFrames("upscale", [{ ratio: "1:1", resolution: ["1152x1152", "2304x2304"] }]));
assert.deepEqual(plain([providers.preset("chp", "upscale").width, providers.preset("chp", "upscale").height]), [1152, 1152],
  "the square frame's first resolution is the app's canvas, not its last");
internals.chpRemember(document);
assert.deepEqual(plain(internals.chpSizes("fast")), [[512, 512], [576, 384], [384, 576]], "the document must be back to the one the rest of this file reads");
assert.deepEqual(plain(internals.chpRule("quick")), null, "`quick` is a slot, not a category: the old word must resolve to nothing");

// A category that publishes no square at all: nothing here invents a canvas for it.
// The app keeps its own, and the refusal below names the resolutions the plugin does
// publish — which is louder than quietly submitting a shape this app's square
// composition would come back stretched into.
const noSquareDocument = withFrames("upscale", [{ ratio: "9:16", resolution: ["768x1344"] }]);
internals.chpRemember(noSquareDocument);
assert.equal(internals.chpSquare("upscale"), null, "a category with no 1:1 frame locks no canvas");
assert.deepEqual(plain([providers.preset("chp", "upscale").width, providers.preset("chp", "upscale").height]), [1024, 1024],
  "with no square published the preset keeps the app's own canvas rather than inventing a pair");
assert.match(internals.lockedCanvasError({ protocol: "chp", slot: "upscale", width: 1024, height: 1024 }).message, /768 × 1344/, "and that canvas is then refused, naming what the plugin does publish");
internals.chpRemember(document);

// The canvas is the service's, and one it cannot make is refused here instead of
// being asked for. A refusal has to name the pair it wanted: the shape (every task
// here is a square) and the size (one the service really publishes).
assert.equal(internals.lockedCanvasError({ protocol: "chp", slot: "upscale", width: 1024, height: 1024 }), null, "a published square canvas must pass");
assert.equal(internals.lockedCanvasError({ protocol: "chp", slot: "upscale", width: 2048, height: 2048 }), null, "the other resolution that category publishes must pass too");
assert.match(internals.lockedCanvasError({ protocol: "chp", slot: "upscale", width: 768, height: 1344 }).message, /768 × 1344/, "a resolution the category never publishes must be refused, named as it was asked for");
assert.match(internals.lockedCanvasError({ protocol: "chp", slot: "quick", width: 512, height: 768 }).message, /512 × 768/, "a shape the category never publishes must be refused");
assert.equal(internals.lockedCanvasError({ protocol: "chp", slot: "inpaint", width: 512, height: 512 }), null, "a published canvas of another task passes for its own category");
// The same rule covers the other formats, whose size is this app's too. A known
// model whose documented set misses the slot's square is refused; a model the table
// has never heard of is not, because guessing a refusal breaks working setups.
assert.match(internals.lockedCanvasError({ protocol: "openai-images", model: "dall-e-3", width: 512, height: 512 }).message, /512 × 512/, "quick draw's 512² must be refused by a model that only makes 1024² and up");
assert.equal(internals.lockedCanvasError({ protocol: "openai-images", model: "dall-e-3", width: 1024, height: 1024 }), null, "the render slot's 1024² must pass for that same model");
assert.equal(internals.lockedCanvasError({ protocol: "openai-images", model: "some-gateway-model", width: 512, height: 512 }), null, "an unknown model must not be refused on a guess");
assert.equal(internals.lockedCanvasError({ protocol: "sd-webui", width: 512, height: 512 }), null, "a square divisible by 64 is what SD WebUI takes");
assert.match(internals.lockedCanvasError({ protocol: "sd-webui", width: 500, height: 500 }).message, /500 × 500/, "a square SD WebUI cannot make must be refused");
assert.equal(internals.lockedCanvasError({ protocol: "stability", width: 1024, height: 1024 }), null, "stability takes an aspect ratio, and 1:1 is always one of them");

const image = internals.jsonImage({ data: [{ b64_json: "YWJj" }], output_format: "png" });
assert.equal(image.src, "data:image/png;base64,YWJj");

const body = utils.multipart({ prompt: "hello" }, [{ name: "image", filename: "x.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }]);
assert.match(body.contentType, /^multipart\/form-data; boundary=----HamDraw/);
assert.ok(body.bytes.length > 80);

assert.equal(utils.validateEndpoint("http://192.168.1.9:7860"), "http://192.168.1.9:7860/");
assert.throws(() => utils.validateEndpoint("http://example.com/api"), /公网服务必须使用 HTTPS/);
assert.throws(() => utils.parseHeaders('["not-object"]'), /JSON 对象/);

utils.sleep = async () => {};
// The same shape the app's own HTTP layer produces: the error *code* first, in a
// sentence a person reads. That preference is why the mapper below may match codes
// and nothing else.
context.hamdraw.platform.haminn.httpError = (response, payload) => {
  const detail = payload && (payload.error || payload.detail || payload.message) || response.bodyText || "服务未返回可读错误";
  const error = new Error("请求失败（" + response.status + "）：" + String(detail));
  error.status = response.status;
  return error;
};

// Testing the connection reads the public information document, which is what
// answers address, password, category and files in one call. It answers 200 even
// with the wrong password — auth.authorized is what says which it was — so the mock
// does the same thing the plugin does.
const infoCalls = [];
function serveInfo(options) {
  infoCalls.push(options.url);
  // The address the user typed is the information endpoint; ComfyUI's own web root
  // answers 200 with a page, and a path that is not the plugin's answers 404. Both
  // are answers, and both are what the second attempt exists for.
  if (!/\/chp\/info$/.test(options.url)) {
    const error = new Error("请求失败（404）：Not Found");
    error.status = 404;
    throw error;
  }
  const payload = plain(document);
  payload.auth.authorized = String(options.headers.Authorization || "") === "Bearer chp-secret";
  return { status: 200, bodyText: JSON.stringify(payload) };
}
context.hamdraw.platform.haminn.request = async options => serveInfo(options);

const chpTest = await providers.test({
  slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188/chp/info", apiKey: "chp-secret",
  width: 512, height: 512, timeoutMs: 30000, customHeaders: ""
});
assert.equal(chpTest.spec, "chp/2");
assert.equal(chpTest.category, "fast", "the card must name the category the slot submits, not the slot");
assert.equal(chpTest.promptLanguage, "en", "the card must read whether this category needs English");
assert.deepEqual(plain(chpTest.resolutions), [[512, 512], [576, 384], [384, 576]], "the card reads the resolutions the plugin accepts, as pairs");
assert.deepEqual(plain(chpTest.files), { checkpoint: "DreamShaper8_LCM.safetensors" }, "the card reads the files from the ability that answers the category");
assert.equal(chpTest.steps, undefined, "there is no published step enumeration to report");
assert.equal(chpTest.authorized, true);
assert.deepEqual(infoCalls, ["http://192.168.1.2:8188/chp/info"], "an address that already is the information endpoint is used as it stands");

// A bare origin is tried as it stands first — it is the address the user typed —
// and the recommended path behind it is what makes the plugin reachable from the
// address the app itself fills in.
infoCalls.length = 0;
await providers.test({ slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "chp-secret", width: 512, height: 512, timeoutMs: 30000, customHeaders: "" });
assert.deepEqual(infoCalls, ["http://192.168.1.2:8188", "http://192.168.1.2:8188/chp/info"], "a bare origin must fall back to the plugin's information path, and only once");
// An address stored while the app itself appended the root resolves the same way,
// which is what keeps a connection that was configured years ago working.
infoCalls.length = 0;
await providers.test({ slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188/chp", apiKey: "chp-secret", width: 512, height: 512, timeoutMs: 30000, customHeaders: "" });
assert.deepEqual(infoCalls, ["http://192.168.1.2:8188/chp", "http://192.168.1.2:8188/chp/info"], "a stored root must resolve to the same information endpoint");
// An address that never answered at all keeps its own network error: "nothing
// replied" and "something replied that was not CHP" are different problems.
context.hamdraw.platform.haminn.request = async () => { throw new Error("ConnectionRefused"); };
await assert.rejects(() => providers.test({
  slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "", width: 512, height: 512, timeoutMs: 30000, customHeaders: ""
}), /ConnectionRefused/, "an address nothing answered must report the failure it had, not a verdict about the plugin");

context.hamdraw.platform.haminn.request = async options => serveInfo(options);
await assert.rejects(() => providers.test({
  slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "wrong",
  width: 512, height: 512, timeoutMs: 30000, customHeaders: ""
}), /访问密码不正确/, "a wrong password must be told apart from a wrong address");

// A plugin that does not carry this category is not a plugin this app can use, and
// saying so is the point: a document read as if it had the category would submit a
// job the server refuses, and report that as a broken model.
const noFast = plain(document);
noFast.rules = noFast.rules.filter(rule => rule.category !== "fast");
context.hamdraw.platform.haminn.request = async () => ({ status: 200, bodyText: JSON.stringify(noFast) });
await assert.rejects(() => providers.test({
  slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "", width: 512, height: 512, timeoutMs: 30000, customHeaders: ""
}), /请升级 CHP 插件/, "a document without the category must ask for an update instead of failing later as a model problem");
// And a category whose models are not installed says which of the two it is: the
// ability exists and is not ready, rather than the category being absent.
const notReady = plain(document);
notReady.abilities[0].ready = false;
notReady.abilities[0].missing = ["checkpoint"];
context.hamdraw.platform.haminn.request = async () => ({ status: 200, bodyText: JSON.stringify(notReady) });
await assert.rejects(() => providers.test({
  slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "", width: 512, height: 512, timeoutMs: 30000, customHeaders: ""
}), /装好模型/, "an ability that is not ready must be reported as a missing model");

const chpCalls = [];
let chpPolls = 0;
const JOBS = "http://192.168.1.2:8188/chp/api/jobs";
context.hamdraw.platform.haminn.request = async options => {
  chpCalls.push(options);
  if (options.method === "POST" && options.url === JOBS) {
    return { status: 202, bodyText: JSON.stringify({ job: { id: "job_chp", category: "inpaint", state: "queued", queue_position: 0, progress: null, outputs: [] } }) };
  }
  if (options.url === JOBS + "/job_chp/progress") {
    chpPolls += 1;
    return { status: 200, bodyText: JSON.stringify({ job: { id: "job_chp", state: chpPolls === 1 ? "running" : "completed", queue_position: chpPolls === 1 ? 2 : null, progress: null } }) };
  }
  if (options.url === JOBS + "/job_chp") {
    return { status: 200, bodyText: JSON.stringify({ job: {
      id: "job_chp", category: "inpaint", state: "completed", queue_position: null, progress: null,
      resolution: "512x512", seed: 42, ref_strength: 0.55, ext_params: { step: 6, negative_prompt: "blur" },
      prompt: "a golden crown", prompt_source: "a golden crown", translated: false, ignored: [],
      outputs: [{ index: 0, filename: "inpaint_00001_.png", subfolder: "hamdraw/inpaint", type: "output", media_type: "image/png", url: "/chp/api/jobs/job_chp/output/0" }]
    } }) };
  }
  if (options.url === JOBS + "/job_chp/output/0") return { status: 200, headers: { "Content-Type": "image/png" }, bodyBase64: "YWJj" };
  throw new Error("unexpected CHP request " + options.url);
};
internals.chpRemember(plain(document));
const chpResult = await providers.generate({
  slot: "inpaint", protocol: "chp", endpoint: "http://192.168.1.2:8188/chp",
  apiKey: "chp-secret", model: "", inputMode: "sketch", width: 512, height: 512, steps: 6,
  refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, {
  prompt: "a golden crown", negativePrompt: "blur", seed: 42, strength: 0.8,
  imageDataUrl: "data:image/png;base64,YWJj", maskDataUrl: "data:image/png;base64,ZEZn"
});
assert.equal(chpResult.src, "data:image/png;base64,YWJj");
// One request, one carrier. A request with a body sends the password in
// `chp_params`, and a secret in a header is a secret in whatever a proxy logs, so
// this one deliberately has none.
const chpSubmission = JSON.parse(chpCalls.find(call => call.method === "POST").bodyText);
assert.equal(chpSubmission.category, "inpaint", "a job must name the category, not a model and not the slot");
assert.equal(chpSubmission.chp_params.password, "chp-secret", "a request with a body must carry the password there");
assert.equal(chpCalls.find(call => call.method === "POST").headers.Authorization, undefined, "and must not also carry it in a header");
// The waits are `GET`s, which have no body, so there the header is the only carrier.
assert.ok(chpCalls.filter(call => call.method === "GET").every(call => call.headers.Authorization === "Bearer chp-secret"),
  "a bodiless request must carry the password as a bearer token");
assert.equal(chpSubmission.resolution, "512x512", "the resolution travels as the string the plugin published");
assert.deepEqual(plain(chpSubmission.ext_params), { step: 6, negative_prompt: "blur" }, "the step count and the negative prompt are model-layer extensions, not top-level fields");
assert.equal(chpSubmission.ref_strength, 0.55, "the artwork slider at 80% must keep the category's reference weight");
assert.equal(chpSubmission.image_base64, "data:image/png;base64,YWJj");
assert.equal(chpSubmission.mask_base64, "data:image/png;base64,ZEZn");
// The retired top-level names must be gone rather than sent for the server to report.
// A wrong `size` is an array where a string is required, and `capability` / `task` /
// `steps` / `negative_prompt` are unknown fields — each of them would come back in
// `job.ignored` on every single job.
["size", "capability", "task", "steps", "negative_prompt", "grow_mask_by", "workflow"].forEach(field => {
  assert.equal(field in chpSubmission, false, `the retired field ${field} must not be in the request body`);
});
assert.equal(chpSubmission.seed, 42);
// 外扩在客户端做（canvas-io.js 把笔迹加粗），请求里没有这个字段。
// 每一跳都读文档里的地址，所以这里只有文档给出的那几个 URL 被请求过：一个自己拼
// `/chp/...` 的客户端会在这里收到「unexpected CHP request」。
assert.ok(chpCalls.every(call => call.url.indexOf("http://192.168.1.2:8188/chp/api/") === 0),
  "every request must be addressed out of the document's endpoints");
// Waiting is two calls, not one: the light one is polled and carries no
// results to parse, and the full one is read exactly once, at the end.
assert.equal(chpPolls, 2);
assert.ok(chpCalls.filter(call => /\/progress$/.test(call.url)).length === 2, "the wait must poll the progress endpoint");
assert.equal(chpCalls.filter(call => call.url === JOBS + "/job_chp").length, 1, "the full status must be read once, after the light call reported completion");

chpCalls.length = 0; chpPolls = 0;
await providers.generate({
  slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "一只猫", negativePrompt: "", seed: 1, strength: 1.6, imageDataUrl: "data:image/png;base64,YWJj" });
const quickSubmission = JSON.parse(chpCalls.find(call => call.method === "POST").bodyText);
assert.equal(quickSubmission.category, "fast", "quick draw submits the category the plugin publishes, which is not the slot's own name");
assert.equal(quickSubmission.chp_params, undefined, "an empty password is nothing to carry: the plugin checks none");
assert.equal(quickSubmission.ref_strength, 0.95, "a stronger artwork setting must raise fidelity and clamp at the maximum");
assert.equal("mask_base64" in quickSubmission, false, "quick draw never sends a mask");
assert.equal(quickSubmission.prompt, "一只猫", "the prompt must travel exactly as written; translating it is the plugin's job");

// The refusal has to reach the submission path, not merely exist. A task whose
// canvas the plugin cannot make is stopped before anything is sent, which is what
// keeps a wrong size from arriving as a complaint about the model it was asked for.
chpCalls.length = 0; chpPolls = 0;
await assert.rejects(() => providers.generate({
  slot: "upscale", protocol: "chp", endpoint: "http://192.168.1.2:8188",
  apiKey: "", model: "", inputMode: "sketch", width: 768, height: 1344, steps: 8,
  refStrength: 0.75, timeoutMs: 30000, customHeaders: ""
}, { prompt: "a fox", negativePrompt: "", seed: 1, strength: 0.8 }), /768 × 1344/, "a canvas the category cannot make must be refused");
assert.equal(chpCalls.length, 0, "the refusal must come before the request, so nothing is submitted");

// Every code the plugin can answer with is turned into something a person can act
// on, and the code — not the Chinese sentence — is what is matched: the plugin's own
// messages say 模型 in places that are not about the model at all.
context.hamdraw.platform.haminn.request = async () => ({ status: 400, bodyText: JSON.stringify({ error: "unsupported_size", message: "该场景没有这个分辨率，请从它的帧表里挑一个。" }) });
await assert.rejects(() => providers.generate({
  slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "a fox", negativePrompt: "", seed: 1, strength: 0.8, imageDataUrl: "data:image/png;base64,YWJj" }), /插件不接受这个画幅/,
"a resolution the server refuses must be reported as the plugin's refusal, in words the user can act on");
// What is matched is the code, never the Chinese sentence the plugin sends with it.
// The plugin's own messages say 模型 in places that are not about the model at all —
// a workflow that failed for a missing node says it too — so matching the sentence
// would report a real workflow failure as "no model installed".
assert.equal(internals.chpError(new Error("请求失败（400）：unsupported_category")).message, "插件不认识这个场景，请升级 CHP 插件");
assert.equal(internals.chpError(new Error("请求失败（400）：内置工作流校验失败，可能是模型或节点缺失。")).message,
  "请求失败（400）：内置工作流校验失败，可能是模型或节点缺失。",
  "a message that merely mentions 模型 must be passed through untouched");
assert.equal(internals.chpError(new Error("请求失败（409）：no_model")).message,
  "插件没有可用模型，请先在 ComfyUI 的 CHP 插件配置节点里为这个场景选好模型");

context.hamdraw.platform.haminn.request = async () => ({ status: 401, bodyText: JSON.stringify({ error: "unauthorized", message: "bad password" }) });
await assert.rejects(() => providers.generate({
  slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "wrong",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "a fox", negativePrompt: "", seed: 1, strength: 0.8, imageDataUrl: "data:image/png;base64,YWJj" }), /访问密码不正确/, "a wrong password must surface as a readable password error");

console.log("providers.test.mjs: ok");
