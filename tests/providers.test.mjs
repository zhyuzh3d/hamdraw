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

load("app/core/namespace.js");
load("app/core/utils.js");
context.hamdraw.platform.haminn = {};
load("app/services/providers.js");

const utils = context.hamdraw.utils;
const internals = context.hamdraw.services.providers.internals;

assert.equal(internals.openAiRoot("https://api.openai.com/v1/images/edits"), "https://api.openai.com/v1");
// A configured address may carry a root the plugin answers on (`/chp`), one it
// keeps only as an alias (`/cvp`), or one it stopped serving when the legacy
// projection was deleted (`/hamdraw/v1`). All of them strip down to the same
// origin: the path is the client's to add back, never the user's to get right.
assert.equal(internals.chpBase("http://192.168.1.2:8188"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://192.168.1.2:8188/chp"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://192.168.1.2:8188/chp/jobs"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://192.168.1.2:8188/cvp"), "http://192.168.1.2:8188", "an address saved while the plugin was called CVP must still resolve");
assert.equal(internals.chpBase("http://192.168.1.2:8188/cvp/jobs"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://192.168.1.2:8188/hamdraw/v1"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://192.168.1.2:8188/hamdraw/v1/jobs"), "http://192.168.1.2:8188");
assert.equal(internals.chpBase("http://chp-host.local:8188"), "http://chp-host.local:8188", "a hostname that merely starts with chp must survive");
assert.equal(internals.chpTask({ slot: "inpaint" }), "inpaint");
assert.equal(internals.chpTask({ capability: "quick", slot: "upscale" }), "quick", "the capability field wins over the slot");
assert.equal(internals.chpTask({ task: "inpaint", slot: "upscale" }), "inpaint");
assert.equal(internals.chpTask({ slot: "unexpected" }), "quick");
// A slot and the capability it submits are the same word on both sides: this app
// keeps one slot per task and the plugin one capability per task. A second name on
// either side is how a slot and the job it submits drift apart — a reader who then
// follows only one of the two names reads the wrong canvases and step counts.
assert.equal(internals.chpTask({ slot: "upscale" }), "upscale", "the render slot must submit the capability it is named after");
assert.equal(internals.chpTask({ capability: "upscale", slot: "quick" }), "upscale", "the capability a config carries must win over the slot it sits in");
// The ComfyUI plugin travels with the app, so choosing that API format fills the
// server address in: blank, and the example an earlier version offered, both
// resolve to the current example — while an address the user typed is kept.
const providers = context.hamdraw.services.providers;
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

// The one document the plugin publishes about itself. Everything the client
// knows about a capability — its sizes, its defaults, whether a model needs
// English, which fields do nothing — is read from here rather than assumed.
const infoDocument = {
  spec: "chp/1",
  plugin: { id: "hamdraw_chp", version: "2.4.0", label: { zh: "ComfyUI HamDraw 插件 CHP", en: "ComfyUI Hamdraw Plugin CHP" } },
  auth: { required: true, authorized: true, scheme: "Bearer", header: "Authorization" },
  endpoints: { info: "/chp/info", jobs: "/chp/jobs" },
  capabilities: [
    { id: "quick", aliases: [], prompt: { language: "en" }, ready: true, ignores: [],
      values: { size: [[512, 512]], steps: [2, 4, 6, 8] }, defaults: { size: [512, 512], steps: 8, ref_strength: 0.55 },
      models: [{ role: "checkpoint", name: "DreamShaper8_LCM.safetensors", ready: true }] },
    { id: "upscale", aliases: [], prompt: { language: "en" }, ready: true, ignores: [],
      values: { size: [[1024, 1024], [2048, 2048]], steps: [4, 8, 12, 16, 20] }, defaults: { size: [1024, 1024], steps: 8, ref_strength: 0.75 }, models: [] },
    // 2.3.0 stopped locking a hand-written list and publishes a portrait canvas
    // for render; the client must carry it as a pair, not as one edge.
    { id: "render", aliases: ["qwen"], prompt: { language: "any" }, ready: true, ignores: ["negative_prompt"],
      values: { size: [[1024, 1024], [768, 1344], [1344, 768]], steps: [20] }, defaults: { size: [1024, 1024], steps: 20, ref_strength: 0.95 }, models: [] }
  ]
};
internals.chpRemember(infoDocument);
assert.equal(internals.chpCapability("render").prompt.language, "any", "a capability that reads Chinese must say so");
assert.equal(internals.chpCapability("qwen").id, "render", "a capability must be found through its alias too");
assert.deepEqual(JSON.parse(JSON.stringify(internals.chpSizes("upscale"))), [[1024, 1024], [2048, 2048]], "the canvases the plugin accepts must come from the document, as whole pairs");
assert.deepEqual(JSON.parse(JSON.stringify(internals.chpSizes("render"))), [[1024, 1024], [768, 1344], [1344, 768]], "a portrait canvas must survive as a pair; keeping only the first number would turn 768×1344 into a square 768");
assert.equal(internals.chpSizes("inpaint").length, 0, "an unknown capability offers nothing rather than a guess");
assert.equal(internals.aspect(768, 1344), "9:16", "the shape label must be read off both numbers");
assert.equal(internals.chpIgnores("render", "negative_prompt"), true);
assert.equal(internals.chpIgnores("quick", "negative_prompt"), false);

// `preset()` reads a slot's capability out of this document, and the numbers it
// starts from are that capability's own rather than a list kept here. The canvas is
// the first one it publishes; the steps and reference weight are its declared
// defaults. This is the row the sheet prints, so it is also what a job carries.
assert.equal(providers.slotCapability("upscale"), "upscale", "a slot's capability must be resolved out of the plugin's own document");
const renderPreset = providers.preset("chp", "upscale");
assert.deepEqual(JSON.parse(JSON.stringify([renderPreset.width, renderPreset.height])), [1024, 1024],
  "the render slot must start on the first canvas its capability publishes");
assert.equal(renderPreset.steps, 8, "the render slot must start on the capability's own step count");
assert.equal(renderPreset.refStrength, 0.75, "the render slot must start on the capability's own reference weight");

// The canvas is the service's, and one it cannot make is refused here instead of
// being asked for. A refusal has to name the pair it wanted: the shape (every task
// here is a square) and the size (one the service really publishes).
assert.equal(internals.lockedCanvasError({ protocol: "chp", slot: "upscale", width: 1024, height: 1024 }), null, "a published square canvas must pass");
assert.equal(internals.lockedCanvasError({ protocol: "chp", slot: "upscale", width: 2048, height: 2048 }), null, "the other canvas the capability publishes must pass too");
assert.match(internals.lockedCanvasError({ protocol: "chp", slot: "upscale", width: 768, height: 1344 }).message, /768 × 1344/, "a size the capability never publishes must be refused, named as it was asked for");
assert.match(internals.lockedCanvasError({ protocol: "chp", slot: "quick", width: 512, height: 768 }).message, /512 × 768/, "a shape the capability never publishes must be refused");
assert.equal(internals.lockedCanvasError({ protocol: "chp", slot: "inpaint", width: 512, height: 512 }), null, "a capability the document does not mention is not judged; the server is left to answer");
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
context.hamdraw.platform.haminn.httpError = (_response, payload) => new Error(payload?.error || "http error");

// Testing the connection reads the public information document, which is what
// answers address, password, capability and model in one call. It answers 200
// even with the wrong password — auth.authorized is what says which it was —
// so the mock does the same thing the plugin does.
context.hamdraw.platform.haminn.request = async options => {
  if (!options.url.endsWith("/chp/info")) throw new Error("unexpected request " + options.url);
  const document = JSON.parse(JSON.stringify(infoDocument));
  document.auth.authorized = String(options.headers.Authorization || "") === "Bearer chp-secret";
  return { status: 200, bodyText: JSON.stringify(document) };
};
const chpTest = await context.hamdraw.services.providers.test({
  slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188/chp", apiKey: "chp-secret",
  width: 512, height: 512, timeoutMs: 30000, customHeaders: ""
});
assert.equal(chpTest.spec, "chp/1");
assert.equal(chpTest.capability, "quick");
assert.equal(chpTest.promptLanguage, "en", "the card must read whether this capability needs English");
assert.deepEqual(JSON.parse(JSON.stringify(chpTest.sizes)), [[512, 512]], "the card reads the canvases the plugin accepts, as pairs");
assert.equal(chpTest.authorized, true);
await assert.rejects(() => context.hamdraw.services.providers.test({
  slot: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "wrong",
  width: 512, height: 512, timeoutMs: 30000, customHeaders: ""
}), /访问密码不正确/, "a wrong password must be told apart from a wrong address");

const chpCalls = [];
let chpPolls = 0;
context.hamdraw.platform.haminn.request = async options => {
  chpCalls.push(options);
  if (options.method === "POST" && options.url.endsWith("/chp/jobs")) {
    return { status: 202, bodyText: JSON.stringify({ job: { id: "job_chp", capability: "inpaint", state: "queued", queue_position: 0, progress: null, outputs: [] } }) };
  }
  if (/\/chp\/jobs\/job_chp\/progress$/.test(options.url)) {
    chpPolls += 1;
    return { status: 200, bodyText: JSON.stringify({ job: { id: "job_chp", state: chpPolls === 1 ? "running" : "completed", queue_position: chpPolls === 1 ? 2 : null, progress: null } }) };
  }
  if (/\/chp\/jobs\/job_chp$/.test(options.url)) {
    return { status: 200, bodyText: JSON.stringify({ job: {
      id: "job_chp", capability: "inpaint", state: "completed", queue_position: null, progress: null,
      prompt: "a golden crown", prompt_source: "a golden crown", translated: false, ignored: [],
      outputs: [{ index: 0, filename: "inpaint_00001_.png", subfolder: "hamdraw", type: "output", media_type: "image/png", url: "/chp/jobs/job_chp/output/0" }]
    } }) };
  }
  if (options.url.endsWith("/chp/jobs/job_chp/output/0")) return { status: 200, headers: { "Content-Type": "image/png" }, bodyBase64: "YWJj" };
  throw new Error("unexpected CHP request " + options.url);
};
const chpResult = await context.hamdraw.services.providers.generate({
  slot: "inpaint", task: "inpaint", capability: "inpaint", protocol: "chp", endpoint: "http://192.168.1.2:8188/chp",
  apiKey: "chp-secret", model: "", inputMode: "sketch", width: 512, height: 512, steps: 6,
  refStrength: 0.55, growMaskBy: 12, timeoutMs: 30000, customHeaders: ""
}, {
  prompt: "a golden crown", negativePrompt: "blur", seed: 42, strength: 0.8,
  imageDataUrl: "data:image/png;base64,YWJj", maskDataUrl: "data:image/png;base64,ZEZn"
});
assert.equal(chpResult.src, "data:image/png;base64,YWJj");
assert.equal(chpCalls[0].headers.Authorization, "Bearer chp-secret", "the CHP password must travel as a bearer token");
const chpSubmission = JSON.parse(chpCalls.find(call => call.method === "POST").bodyText);
assert.equal(chpSubmission.capability, "inpaint", "a job must name the capability, not a model");
assert.equal("task" in chpSubmission, false, "the retired task field must not be sent");
assert.deepEqual(JSON.parse(JSON.stringify(chpSubmission.size)), [512, 512]);
assert.equal(chpSubmission.steps, 6);
assert.equal(chpSubmission.ref_strength, 0.55, "the artwork slider at 80% must keep the per-capability reference weight");
assert.equal(chpSubmission.negative_prompt, "blur", "a capability that keeps the negative prompt must be sent it");
assert.equal(chpSubmission.image_base64, "data:image/png;base64,YWJj");
assert.equal(chpSubmission.mask_base64, "data:image/png;base64,ZEZn");
assert.equal(chpSubmission.grow_mask_by, 12);
assert.equal("workflow" in chpSubmission, false, "the plugin ships its own graphs, so no workflow is ever uploaded");
// Waiting is two calls, not one: the light one is polled and carries no
// results to parse, and the full one is read exactly once, at the end.
assert.equal(chpPolls, 2);
assert.ok(chpCalls.filter(call => /\/progress$/.test(call.url)).length === 2, "the wait must poll the progress endpoint");
assert.equal(chpCalls.filter(call => /\/chp\/jobs\/job_chp$/.test(call.url)).length, 1, "the full status must be read once, after the light call reported completion");

// A capability that declares a field ignored is not sent it: the user would
// otherwise believe a control worked on a model that never reads it. Which
// fields those are is read from the document every time, never hard-coded, so a
// plugin that one day declares it for quick draw is obeyed with no new client.
chpCalls.length = 0; chpPolls = 0;
const ignoresDocument = JSON.parse(JSON.stringify(infoDocument));
ignoresDocument.capabilities.filter(item => item.id === "quick")[0].ignores = ["negative_prompt"];
internals.chpRemember(ignoresDocument);
await context.hamdraw.services.providers.generate({
  slot: "quick", capability: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "一只猫", negativePrompt: "blur", seed: 1, strength: 0.8, imageDataUrl: "data:image/png;base64,YWJj" });
const ignoredSubmission = JSON.parse(chpCalls.find(call => call.method === "POST").bodyText);
assert.equal(ignoredSubmission.capability, "quick");
assert.equal("negative_prompt" in ignoredSubmission, false, "a capability that ignores the negative prompt must not be sent one");
assert.equal(ignoredSubmission.prompt, "一只猫", "the prompt must travel exactly as written; translating it is the plugin's job");
internals.chpRemember(infoDocument);

chpCalls.length = 0; chpPolls = 0;
await context.hamdraw.services.providers.generate({
  slot: "quick", task: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "a fox", negativePrompt: "", seed: 1, strength: 1.6, imageDataUrl: "data:image/png;base64,YWJj" });
const quickSubmission = JSON.parse(chpCalls.find(call => call.method === "POST").bodyText);
assert.equal(quickSubmission.capability, "quick");
assert.equal(quickSubmission.ref_strength, 0.95, "a stronger artwork setting must raise fidelity and clamp at the maximum");
assert.equal("mask_base64" in quickSubmission, false, "quick draw never sends a mask");

// The refusal has to reach the submission path, not merely exist. A task whose
// canvas the plugin cannot make is stopped before anything is sent, which is what
// keeps a wrong size from arriving as a complaint about the model it was asked for.
chpCalls.length = 0; chpPolls = 0;
await assert.rejects(() => context.hamdraw.services.providers.generate({
  slot: "upscale", task: "upscale", capability: "upscale", protocol: "chp", endpoint: "http://192.168.1.2:8188",
  apiKey: "", model: "", inputMode: "sketch", width: 768, height: 1344, steps: 8,
  refStrength: 0.75, timeoutMs: 30000, customHeaders: ""
}, { prompt: "a fox", negativePrompt: "", seed: 1, strength: 0.8 }), /768 × 1344/, "a canvas the capability cannot make must be refused");
assert.equal(chpCalls.length, 0, "the refusal must come before the request, so nothing is submitted");

context.hamdraw.platform.haminn.request = async () => ({ status: 401, bodyText: JSON.stringify({ error: "unauthorized", message: "bad password" }) });
await assert.rejects(() => context.hamdraw.services.providers.generate({
  slot: "quick", task: "quick", protocol: "chp", endpoint: "http://192.168.1.2:8188", apiKey: "wrong",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "a fox", negativePrompt: "", seed: 1, strength: 0.8, imageDataUrl: "data:image/png;base64,YWJj" }), /访问密码不正确/, "a wrong password must surface as a readable password error");

console.log("providers.test.mjs: ok");
