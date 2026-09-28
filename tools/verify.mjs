import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "haminn.json"), "utf8"));
assert.equal(manifest.schema, 2);
assert.equal(manifest.happId, "life.airen.hamdraw");
assert.ok(Number.isInteger(manifest.version.code) && manifest.version.code > 0);
assert.equal(manifest.display.orientation, "portrait", "HamDraw must lock to portrait orientation");

const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const editorCss = fs.readFileSync(path.join(root, "styles/editor.css"), "utf8");
const componentsCss = fs.readFileSync(path.join(root, "styles/components.css"), "utf8");
const baseCss = fs.readFileSync(path.join(root, "styles/base.css"), "utf8");
const editorJs = fs.readFileSync(path.join(root, "app/features/editor.js"), "utf8");
const canvasJs = fs.readFileSync(path.join(root, "app/components/canvas.js"), "utf8");
const settingsJs = fs.readFileSync(path.join(root, "app/components/settings.js"), "utf8");
const storeJs = fs.readFileSync(path.join(root, "app/services/store.js"), "utf8");
const uiJs = fs.readFileSync(path.join(root, "app/components/ui.js"), "utf8");
const imageEngineJs = fs.readFileSync(path.join(root, "app/services/image-engine.js"), "utf8");
const appJs = fs.readFileSync(path.join(root, "app/app.js"), "utf8");
const assetsJs = fs.readFileSync(path.join(root, "app/services/assets.js"), "utf8");
const providersJs = fs.readFileSync(path.join(root, "app/services/providers.js"), "utf8");
const haminnJs = fs.readFileSync(path.join(root, "app/platform/haminn.js"), "utf8");
const renderPreviewJs = fs.readFileSync(path.join(root, "app/components/render-preview.js"), "utf8");
const galleryJs = fs.readFileSync(path.join(root, "app/components/gallery.js"), "utf8");
const runtimeJs = fs.readFileSync(path.join(root, "app/core/runtime.js"), "utf8");
const drawingJs = fs.readFileSync(path.join(root, "app/core/drawing.js"), "utf8");
assert.ok(html.includes('id="result-opacity"') && html.includes('id="result-visibility"'), "canvas bar must expose result opacity and visibility");
assert.ok(html.includes('id="choice-layer"') && html.includes('id="choice-options"'), "app must provide a shared in-app choice sheet");
assert.ok(!html.includes("<select") && !settingsJs.includes("<select") && !componentsCss.includes(".field select"), "app settings must not use native select menus");
assert.ok(settingsJs.includes("function bindChoices") && settingsJs.includes("ui.openChoice") && settingsJs.includes('select("theme"') && settingsJs.includes('select("language"'), "preference and model choices must use the shared choice sheet");
assert.ok(uiJs.includes("function openChoice") && uiJs.includes("choice-layer") && uiJs.includes("choice-option"), "choice sheet must render and handle its own option buttons");
assert.match(componentsCss, /\.choice-layer\{position:fixed;z-index:140;left:0;right:0;top:0;bottom:0\}/, "choice sheet must use Android WebView-compatible viewport bounds");
assert.ok(!html.includes('id="generation-strength"') && html.includes('id="seed-lock"'), "generation bar must remove the sketch-strength slider and retain seed rolling");
assert.ok(html.includes('id="overlay-toggle"') && html.includes('id="snapshot-canvas"'), "generation bar must expose overlay and snapshot controls");
assert.equal((html.match(/data-adjust="result/g) || []).length, 6, "canvas must expose six inline color adjustment sliders");
assert.ok(html.includes('id="color-adjust-panel"'), "color adjustments must live below the canvas");
assert.ok(html.includes('id="color-adjust-reset"') && html.includes('id="color-adjust-default"'), "color panel must expose reset and default actions");
assert.ok(html.includes('id="color-adjust-close"') && html.includes('id="color-adjust-enabled"'), "color panel must expose close and effect toggle actions");
assert.ok(html.includes('id="seed-value"') && !html.match(/id="seed-lock"[^>]*aria-pressed/), "dice must show the seed and must not be a lock switch");
assert.ok(html.indexOf('id="generate-quick"') < html.indexOf('id="seed-lock"') && html.indexOf('id="seed-lock"') < html.indexOf('id="generate-quality"'), "seed button must sit between Fast and Quality");
assert.ok(/id="generate-quality"[\s\S]*data-zh="渲染"/.test(html), "quality action must be presented as Render");
assert.ok(html.includes('id="render-preview"') && html.includes('id="render-preview-surface"') && html.includes('id="render-preview-adjust"') && html.includes('id="render-preview-adjustments"') && html.includes('id="render-preview-download"') && html.includes('id="render-preview-reset"') && html.includes('id="render-preview-clear"') && html.includes('id="render-preview-close"') && html.includes('id="render-preview-stage"') && html.includes('role="toolbar"'), "Render must have a fullscreen preview toolbox, adjustment panel, and image stage");
assert.equal((html.match(/data-render-adjust="result/g) || []).length, 6, "Render preview must expose all six live color adjustment sliders, the same set the canvas panel offers");
// The panel must offer the six sliders *and* feed them to the filter. Presence alone
// is the trap this panel already fell into once: two sliders sat in the markup while
// their filter terms were hard-wired to a neutral constant, so the picture ignored
// them and every markup assertion stayed green. The count above is what makes a
// dropped slider fail; the assertions below are what make a present-but-unapplied one
// fail. `NEUTRAL` was that constant's name.
assert.ok(renderPreviewJs.includes('var adjustmentKeys = ["resultBrightness", "resultContrast", "resultSaturation", "resultHue", "resultGlow", "resultClarity"];'), "one list must name all six keys the sliders, the redraw and the saved default share");
assert.ok(renderPreviewJs.includes("resultBrightness: adjustments.resultBrightness") && renderPreviewJs.includes("resultContrast: adjustments.resultContrast"), "the panel's brightness and contrast must reach the drawn pixels rather than a neutral term");
assert.ok(!/NEUTRAL/.test(renderPreviewJs), "the neutral placeholder must be gone, not merely bypassed");
assert.ok(html.indexOf('data-render-adjust="resultBrightness"') < html.indexOf('data-render-adjust="resultSaturation"') && html.indexOf('data-render-adjust="resultContrast"') < html.indexOf('data-render-adjust="resultSaturation"'), "brightness and contrast must lead the panel, as they lead the canvas panel's");
// The two panels offer the same six sliders, so they must also agree on the range. A
// preview whose brightness stops somewhere else than the canvas's is exactly the drift
// that only ever surfaces as "the saved default looks wrong".
["resultBrightness", "resultContrast", "resultSaturation", "resultHue", "resultGlow", "resultClarity"].forEach(function (key) {
  const bounds = (tag) => tag.match(/min="(-?[\d.]+)"/)[1] + ".." + tag.match(/max="(-?[\d.]+)"/)[1];
  assert.equal(bounds(html.match(new RegExp('data-render-adjust="' + key + '"[^>]*'))[0]), bounds(html.match(new RegExp('data-adjust="' + key + '"[^>]*'))[0]), "the preview's " + key + " slider must cover the same range as the canvas panel's");
});
assert.match(html, /id="render-preview-adjust-enabled"[^>]*role="switch"/, "the action row must end in a switch for the color effect");
assert.ok(renderPreviewJs.includes("adjustmentsEnabled = effectsToggle.checked") && renderPreviewJs.includes("resultAdjustmentsEnabled: adjustmentsEnabled !== false") && renderPreviewJs.includes("config.canvas.resultAdjustmentsEnabled = adjustmentsEnabled !== false"), "the switch must reach the drawn pixels, the download, and save-default");
// The panel and the toolbar are both dark glass: the backdrop is blurred and its
// brightness turned down, and what is written on them is white — labels, slider tracks
// and the hollow handle's outline. The canvas panel keeps its light-surface grey, which
// is why the slider colours are declared per panel instead of once for both.
// Asserting that *some* rule dims the glass is a trap: this file already shipped a
// later `.render-preview-tools{...brightness(1)!important}` that flattened the dimming
// back to 1, and the substring check stayed green the whole time. So read the cascade
// instead — take the last backdrop-filter that actually wins (deferring to !important,
// as the browser does) and require the dim there. Re-adding a trailing flatten rule
// turns this red, which is the whole point.
function winningBackdrop(css, selector) {
  const decls = css.split("}").map((chunk) => {
    const at = chunk.lastIndexOf("{");
    if (at < 0) return null;
    const sel = chunk.slice(0, at).split("{").pop().trim();
    return sel.split(",").some((part) => part.trim() === selector) ? chunk.slice(at + 1) : null;
  }).filter((decl) => decl && decl.indexOf("backdrop-filter:") >= 0);
  assert.ok(decls.length > 0, "expected at least one backdrop-filter rule for " + selector);
  const important = decls.filter((decl) => /backdrop-filter:[^;]*!important/.test(decl));
  const pool = important.length ? important : decls;
  return pool[pool.length - 1];
}
assert.match(winningBackdrop(componentsCss, ".render-preview-adjustments"), /brightness\(\.58\)/, "the adjustment panel must be dark glass with the backdrop brightness turned down");
assert.match(winningBackdrop(componentsCss, ".render-preview-tools"), /brightness\(\.58\)/, "the toolbar glass must be darkened the same way");
assert.ok(/\.render-preview-adjustments\{[^}]*background:rgba\(9,10,13,/.test(componentsCss) && /\.render-preview-tools\{[^}]*background:rgba\(9,10,13,/.test(componentsCss), "both preview glass surfaces must sit on the same dark tint");
assert.match(componentsCss, /\.render-preview-tools \.icon-button\{[^}]*color:#fff!important/, "the toolbar icons must be white on the dark glass");
assert.match(componentsCss, /\.render-preview-adjustments \.color-adjust-item>span,\.render-preview-adjustments \.color-adjust-item output\{color:#fff/, "the panel must write in white");
assert.ok(componentsCss.includes(".render-preview-adjustments .color-adjust-item input[type=range]::-webkit-slider-runnable-track{background:#fff}") && componentsCss.includes(".render-preview-adjustments .color-adjust-item input[type=range]::-webkit-slider-thumb{border-color:#fff") && componentsCss.includes(".render-preview-adjust-actions .button-secondary{background:rgba(255,255,255,.14)"), "the preview's track, its outlined handle and its secondary buttons must all be white");
assert.ok(componentsCss.includes(".color-adjust-item input[type=range]::-webkit-slider-runnable-track{background:#dfe3e9}") && componentsCss.includes(".color-adjust-item input[type=range]::-webkit-slider-thumb{width:18px;height:18px;margin-top:-7px;border:2px solid #c2c8d2"), "the canvas panel must keep its pale grey slider instead of inheriting the preview's white");
assert.ok(html.includes('id="render-preview-adjust-close"') && html.includes('id="render-preview-adjust-reset"') && html.includes('id="render-preview-adjust-default"'), "Render preview adjustments must expose close, reset, and save-default actions");
assert.ok(html.includes('id="prompt-display"') && html.includes('id="prompt-strength"') && html.includes('id="prompt-strength-default"') && html.includes('id="prompt-strength-value"') && html.includes('min="20" max="100"'), "Main prompt row must expose the image weight control bounded to 20-100%, its percentage, and the 80% shortcut");
assert.ok(editorJs.includes("var value = Math.max(20, Math.min(100, Math.round(Number(app.state.strength || 0.8) * 100)))") && editorJs.includes("value = Math.max(20, Math.min(100, Number(value) || 80)"), "the image weight control and its setter must share the 20-100% range declared by the markup");
assert.ok(componentsCss.includes(".advanced summary:focus{outline:none!important}") && !componentsCss.includes(".advanced summary:focus,.advanced summary:focus-visible"), "the summary focus rule must stay split: an unsupported selector listed beside :focus makes an old WebView drop the whole rule and draw the UA focus ring");
assert.ok(html.indexOf('id="render-preview-adjust-default"') < html.indexOf('id="render-preview-adjust-reset"') && html.indexOf('id="render-preview-adjust-reset"') < html.indexOf('id="render-preview-adjust-close"'), "Render preview adjustment actions must be save-default, reset, close");
assert.ok(!html.includes('id="render-preview-title"') && !html.includes('id="render-preview-meta"') && !html.includes('render-preview-footer'), "Render preview must not show title, resolution, or footer text");
assert.ok(html.includes('id="render-result-trigger"') && !html.includes('id="render-notice"'), "Render result must use only the animated diamond trigger");
assert.ok(editorJs.includes('detail.slot === "upscale"') && editorJs.includes('node("stage-busy").hidden = false'), "Render progress must show a non-blocking wait layer while the canvas remains editable");
assert.ok(editorJs.includes('syncRenderResult(true)') && editorJs.includes('trigger.hidden = true') && editorJs.includes('setTimeout(function ()'), "Repeated high-resolution renders must replay the diamond completion animation");
assert.ok(renderPreviewJs.includes('scale = Math.max(1, Math.min(8') && renderPreviewJs.includes('type: "pan"') && renderPreviewJs.includes('type: "pinch"'), "render preview must support bounded pan and pinch zoom");
assert.ok(renderPreviewJs.includes("createFrameTask(apply)"), "render preview transforms must be coalesced to animation frames");
// The description on the drawing screen used to be dragged sideways. It is a label
// with a tap target now: too long and it is clipped with an ellipsis, and a tap opens
// the dialog that edits it instead of scrolling it. Saving a changed description is a
// reason to draw again — the same path a brush stroke takes — and the sketch weight
// only counts once the finger is up, so it hangs off `change` rather than one `input`
// per pixel of the drag.
assert.match(editorCss, /\.prompt-readonly\{[^}]*flex:0 0 50%;[^}]*overflow:hidden;text-overflow:ellipsis;white-space:nowrap[^}]*\}/, "the description must take half the bar and be clipped with an ellipsis");
assert.match(editorCss, /\.prompt-strength\{[^}]*flex:1 1 0[^}]*\}/, "the sketch weight must fill the other half of the bar");
assert.ok(!editorJs.includes("promptDrag") && !editorJs.includes("scrollLeft") && !/\.prompt-readonly\{[^}]*overflow-x:auto/.test(editorCss) && !editorCss.includes(".prompt-readonly::-webkit-scrollbar"), "the horizontal scrolling design must be gone, not merely hidden");
assert.match(html, /id="prompt-display"[^>]*role="button"/, "the description must announce itself as something that can be opened");
// The pencil is an inline sibling of the description label, so the whole line — icon
// included — is one tap target. The failure mode this guards is silent: any code that
// writes the tap target's own textContent erases the icon on the next refresh, and a
// screenshot taken before that refresh would still look right.
assert.match(html, /id="prompt-display"[^>]*><i class="fa-solid fa-pen prompt-edit-icon" aria-hidden="true"><\/i><span[^>]*id="prompt-display-text"/, "the description must open with a pencil icon that sits before its label inside the same tap target");
assert.match(editorCss, /\.prompt-edit-icon\{[^}]*margin-right:5px;[^}]*font-size:10px;[^}]*vertical-align:middle/, "the pencil must be a small inline glyph at the start of the line");
assert.ok(editorJs.includes('node("prompt-display-text"), text =') && appJs.includes('getElementById("prompt-display-text").textContent = snapshot.prompt'), "both the refresh path and the restore path must fill the label inside the tap target");
assert.ok(!editorJs.includes('node("prompt-display").textContent') && !appJs.includes('getElementById("prompt-display").textContent'), "no code may write the tap target's own textContent, or the pencil disappears on the next refresh");
// The empty canvas opens with a pencil too. It used to carry a fountain-pen nib, which
// reads as a different tool than the one the app actually draws with.
assert.match(html, /id="stage-empty"><i class="fa-solid fa-pen"><\/i><strong/, "the empty canvas must open with a pencil rather than a fountain-pen nib");
assert.ok(!html.includes("fa-pen-nib"), "no fountain-pen nib may remain in the empty-canvas placeholder");
const promptEditorBody = editorJs.slice(editorJs.indexOf("function editPrompt"), editorJs.indexOf("function bindOptions"));
assert.ok(promptEditorBody.includes("data-cancel") && promptEditorBody.includes("data-save") && promptEditorBody.includes("app.state.prompt = next") && promptEditorBody.includes("app.services.imageEngine.schedule()"), "the description dialog must offer cancel and save, and a saved change must ask for a redraw");
assert.ok(promptEditorBody.indexOf('next === String(app.state.prompt || "").trim()') > 0 && promptEditorBody.indexOf('next === String(app.state.prompt || "").trim()') < promptEditorBody.indexOf("app.services.imageEngine.schedule()"), "an unchanged description must close without asking for a redraw");
assert.ok(editorJs.includes("display.onclick = editPrompt") && editorJs.includes('strength.addEventListener("change", function () { app.services.imageEngine.schedule(); })') && editorJs.includes('node("prompt-strength-default").onclick = function () { setPromptStrength(80); app.services.imageEngine.schedule(); }'), "a tap on the description and a released sketch-weight control must both schedule the automatic pass");
assert.ok(editorJs.includes("setPromptStrength(80)") && editorJs.includes("app.state.strength = value / 100"), "main image weight must share the canvas strength and provide an 80% shortcut");
assert.ok(editorJs.includes('node("prompt-strength-value").textContent = value + "%"') && editorCss.includes('.prompt-strength .icon-button{flex:0 0 24px') && editorCss.includes('margin:0 0 0 1px') && editorCss.includes('margin-left:3px'), "main image weight must use a borderless compact icon, tight gaps, and visible percentage");
assert.ok(renderPreviewJs.includes('document.getElementById("render-preview-download").onclick') && renderPreviewJs.includes('surface.toDataURL("image/png")') && renderPreviewJs.includes('result = result || current') && renderPreviewJs.includes('surfaceTask.request()') && renderPreviewJs.includes('saveAdjustmentsDefault'), "render preview download and adjustment actions must use the adjusted surface");
assert.ok(imageEngineJs.includes('if (slot === "upscale") config.inputMode = "sketch"') && imageEngineJs.includes('canvasInput.composeVisibleInput(referenceOptions)') && imageEngineJs.includes('dimensions.width !== wantWidth'), "Render must submit the visible canvas and require the configured square result");
assert.ok(providersJs.includes('id: "chp"') && providersJs.includes("CHP_CAPABILITY") && providersJs.includes('base + "/chp"') && providersJs.includes('api + "/jobs"') && providersJs.includes("image_base64") && providersJs.includes("mask_base64") && providersJs.includes("grow_mask_by") && providersJs.includes("ref_strength"), "the CHP format must submit the plugin's capabilities with a reference weight and a mask");
// A capability is named by its id, never by the model behind it: swapping the
// model must not require a new client. The plugin's own document is what tells
// the client what a capability accepts and which fields it ignores, so the
// client reads /chp/info instead of assuming either.
assert.ok(providersJs.includes("capability: capability") && !/task: task,/.test(providersJs), "a job must be submitted under its capability id, not the retired task field");
assert.ok(providersJs.includes('"/chp/info"') && providersJs.includes('chpRemember') && providersJs.includes("capabilitySizes"), "testing the connection must read the plugin's information endpoint and keep what it says");
// A canvas is a pair, never one number. The plugin stopped publishing squares
// only in 2.3.0, so a client that keeps just the first number silently turns a
// portrait 768×1344 into a square 768 — a wrong shape with no error anywhere.
assert.ok(providersJs.includes("function chpSizes") && providersJs.includes("return [Number(pair && pair[0]), Number(pair && pair[1])];"), "a published canvas must be carried as [width, height], not as its first number alone");
assert.ok(providersJs.includes("var canvas = sizes.length ? sizes[0] : null;") && providersJs.includes("value.width = canvas ? canvas[0]") && providersJs.includes("value.height = canvas ? canvas[1]"), "the CHP preset must take both edges of the first published canvas instead of mirroring one of them");
// The canvas belongs to the capability, so the sheet prints it instead of offering it.
// There used to be a pair of buttons on the render slot; what keeps the row honest now
// is that it prints the pair the request will carry, so it can never advertise a shape
// the job does not submit — and one edge mirrored into two would turn a portrait canvas
// into a square, which is exactly what the buttons were once written to avoid.
assert.ok(!settingsJs.includes("data-aspect-width") && !settingsJs.includes("data-aspect-height") && !settingsJs.includes("aspect-sizes"), "the model sheet must not offer a canvas chooser: the canvas is the plugin's, not a menu");
assert.ok(settingsJs.includes('model.width + " × " + model.height'), "the locked aspect row must print the canvas as a pair, straight from what the job will submit");
assert.ok(!settingsJs.includes("<strong>1:1</strong>"), "the locked aspect row must name the real shape, not assume every canvas is square");
assert.ok(providersJs.includes('"/jobs/" + encodeURIComponent(jobId) + "/progress"') && providersJs.includes("queue_position"), "the wait must poll the light progress call and may only count the queue");
assert.ok(providersJs.includes('if (!chpIgnores(capability, "negative_prompt"))') && providersJs.includes("function chpIgnores"), "a capability that declares a field ignored must not be sent it");
assert.ok(!providersJs.includes("detail.progress"), "a percentage must never be drawn from a progress response that does not carry one");
assert.ok(!providersJs.includes('id: "comfyui"') && !providersJs.includes("/view?filename=") && providersJs.includes("output.url"), "the retired workflow contract and the ComfyUI /view endpoint must be gone; the plugin serves its own images");
assert.ok(providersJs.includes("chpStrength") && providersJs.includes("base * (value / 0.8)"), "the reference weight must scale from the per-task default while the artwork slider stays neutral at 80%");
assert.ok(settingsJs.includes("SLOT_TABS") && settingsJs.includes('["inpaint"') && settingsJs.includes("aspectField") && !settingsJs.includes("a1x") && !settingsJs.includes("a1x-profile"), "the model dialog must configure the three CHP tasks, show the locked aspect row, and carry no A1X preset");
assert.ok(!settingsJs.includes("app.config.quality"), "the retired quality slot must not be read by the settings dialog");
assert.match(componentsCss, /\.advanced summary:focus[^{]*\{outline:none/, "the advanced-options summary must not draw a focus ring");
assert.ok(!providersJs.includes("a1x") && !providersJs.includes("A1X"), "the A1X protocol implementation must be deleted from the provider layer, not just hidden from the menu");
assert.ok(providersJs.includes('name: "ComfyUI Hamdraw Plugin CHP'), "the CHP format must be presented under its full ComfyUI Hamdraw Plugin CHP name");
assert.ok(storeJs.includes("value.upscale = app.utils.merge") && storeJs.includes("value.inpaint = app.utils.merge") && storeJs.includes('model.protocol === "a1x-image"') && storeJs.includes('model.protocol = "chp"') && storeJs.includes("value.schema = 10"), "the two-model migration must split into the three tasks and fold the retired A1X and workflow formats into CHP");
// Schema 9 is the CVP -> CHP rename. It cannot be left to the comparison sites: a
// stored `protocol: "cvp"` answers to no entry in the picker, so the dialog would open
// with nothing selected and `generate()` would refuse a task that used to work.
assert.ok(storeJs.includes("if (previousSchema < 9)") && storeJs.includes('carried.protocol === "cvp"') && storeJs.includes('carried.protocol = "chp"'), "schema 9 must carry a config still holding the retired CVP protocol id over to CHP");
// Schema 10 points the render slot at the plugin's `render` capability instead
// of `upscale`. The two declare different domains — upscale runs 4/8/12/16/20
// steps up to 2048², render runs 12/16/20/25/30/40 up to 1 MP / 1536 px — so a
// stored 8 steps or 2048² comes back as unsupported_steps / unsupported_size,
// a hard failure that reads as a broken model rather than a changed capability.
assert.ok(storeJs.includes("if (previousSchema < 10)") && storeJs.includes("var render = value.upscale") && storeJs.includes("render.steps = app.defaults.upscale.steps") && storeJs.includes("render.refStrength = app.defaults.upscale.refStrength"), "schema 10 must re-derive the render slot's numbers from the app's own defaults");
assert.ok(providersJs.includes('var CHP_CAPABILITY = { quick: "quick", inpaint: "inpaint", upscale: "upscale" };'), "a slot and the capability it submits must be the same word on both sides; a second name on either side is how a slot and its job drift apart");
// The canvas is locked to one square per task, and a service that cannot make it is
// reported rather than asked. One definition, called from the two places that can
// know: validate(), which every submission passes through, and the connection test,
// which is the call that makes the plugin's own document known at all. The count is
// the assertion — two callers that merely compute a value and drop it would satisfy
// a "does it appear" check while refusing nothing.
assert.ok(providersJs.includes("function publishedCanvases") && providersJs.includes("function lockedCanvasError") && providersJs.includes('if (config.protocol === "openai-images") return OPENAI_IMAGE_SIZES'), "the canvases a service publishes must be read from the plugin's document and from the documented size sets of the other formats");
assert.equal((providersJs.match(/lockedCanvasError\(/g) || []).length, 3, "the canvas check must be defined once and called from both the connection test and the submission path");
assert.equal((providersJs.match(/if \(canvasProblem\) throw canvasProblem;/g) || []).length, 2, "both callers must refuse, not merely compute the check's answer");
// The sheet no longer reads the plugin's document on a slot's behalf: with the canvas
// and the numbers printed rather than offered, it has nothing left to take from it. The
// slot-to-capability resolution therefore keeps one caller, `preset()`, and the
// assertion follows it there instead of pinning a call the sheet no longer makes.
assert.ok(providersJs.includes("function chpSlotCapability") && providersJs.includes("var capability = chpSlotCapability(name);") && !settingsJs.includes("providers.capabilitySizes(name)"), "a slot's capability must be resolved before the plugin's document is read on its behalf; the preset is what reads it now");
assert.ok(storeJs.includes("function shareChpConnection") && storeJs.includes('["quick", "inpaint", "upscale"].forEach') && storeJs.includes("model.endpoint = connection.endpoint") && storeJs.includes("var value = shareChpConnection(app.utils.merge(app.defaults, config))"), "one CHP connection must be re-derived into every CHP task on load and on save, so editing it anywhere edits all three");
assert.ok(settingsJs.includes("var shared = draft.connection") && settingsJs.includes('var sharedField = chp && ["endpoint", "apiKey", "customHeaders"].indexOf(field.name) >= 0') && settingsJs.includes("if (sharedField) shared[field.name] = value"), "the model dialog must read and write the one shared CHP connection while leaving the other formats alone");
assert.ok(settingsJs.includes("data-plugin-download") && settingsJs.includes("async function downloadPlugin") && settingsJs.includes("bridge.files.beginWrite(") && settingsJs.includes("bridge.files.appendBytes(") && settingsJs.includes("bridge.files.finishWrite(") && settingsJs.includes("bridge.files.export(") && settingsJs.includes('root.querySelector("[data-plugin-download]")') && settingsJs.includes("pluginButton.onclick = ui.action(downloadPlugin)"), "the CHP form must offer the bundled plugin through the host file writer and the system save dialog, not a download");
assert.ok(html.includes('src="./app/assets/comfyui-plugin.js"'), "the bundled plugin bytes must be part of the runtime script list");
const pluginBundleJs = fs.readFileSync(path.join(root, "app/assets/comfyui-plugin.js"), "utf8");
assert.ok(/app\.comfyuiPlugin = \{[\s\S]*name: "hamdraw-comfyui-plugin-v[0-9.]+\.zip"[\s\S]*base64:/.test(pluginBundleJs), "the generated asset must expose the archive name and its bytes");
assert.ok(pluginBundleJs.length > 20000 && !/\b(?:import|export)\s/.test(pluginBundleJs), "the embedded archive must carry real bytes and stay a plain script");
assert.ok(settingsJs.includes("function helpLine") && settingsJs.includes("function helpSection") && settingsJs.includes('class="help-icon"') && componentsCss.includes(".help-icon{box-sizing:border-box;flex:0 0 auto"), "every help line must lead with the tool's own icon");
// The sheet is a map of the toolbars, so the icons it prints must be the icons the
// toolbars paint. Asserting a few of them keeps a rewrite from quietly dropping them.
["pencil", "wand-magic-sparkles", "dice", "gear", "keyboard", "expand", "palette", "arrow-pointer", "object-group", "minus", "mask-face", "bolt", "camera", "download", "cubes"].forEach((name) => {
  assert.ok(settingsJs.includes('fa("fa-solid", "' + name + '")') || settingsJs.includes('fa("fa-regular", "' + name + '")'), "the help sheet must show the " + name + " icon");
});
assert.ok(settingsJs.includes('fa("fa-regular", "image")') && settingsJs.includes('fa("fa-regular", "gem")'), "the help sheet must show the image-weight and render icons in their regular cut");
// The whole point of the sheet is that a reader can find the button on screen, so no
// icon may be invented. Read every glyph the help body names and require the markup to
// actually paint it — the sheet once advertised pen-to-square, which no toolbar has.
{
  const helpBody = settingsJs.slice(settingsJs.indexOf("function help("), settingsJs.indexOf("function about("));
  const named = [...helpBody.matchAll(/fa\("fa-(?:solid|regular)", "([a-z0-9-]+)"\)/g)].map((match) => match[1]);
  assert.ok(named.length >= 15, "the help sheet must name the toolbar icons it explains");
  const invented = [...new Set(named)].filter((name) => !html.includes("fa-" + name));
  assert.equal(invented.join(","), "", "every icon the help sheet shows must exist in the markup: " + invented.join(", "));
  assert.ok(!helpBody.includes("pen-to-square"), "the prompt is edited in Artwork settings, so the sheet must not advertise a pen-to-square button that does not exist");
}
assert.ok(settingsJs.includes('<span class="mini-switch"></span>') && !/<ol>/.test(settingsJs.slice(settingsJs.indexOf("function help("), settingsJs.indexOf("function about("))), "the overlay switch must be shown as the real control, and the help must stay a list of short lines rather than prose paragraphs");
assert.ok(settingsJs.includes('var PROJECT_URL = "https://github.com/zhyuzh3d/hamdraw"') && settingsJs.includes('class="button button-secondary about-link" href="\' + PROJECT_URL + \'"') && !/<a [^>]*target=/.test(settingsJs), "the about sheet must link to the project in the same frame: this WebView has no window handler for a new tab");
assert.ok(componentsCss.includes(".about-link{width:100%;margin-top:16px;text-decoration:none}"), "the project link must read as a full-width button");
assert.ok(haminnJs.includes("var MESSAGE_CHARS = 200000") && haminnJs.includes("function checkBudget") && haminnJs.includes("checkBudget(options)") && haminnJs.includes("messageChars: MESSAGE_CHARS"), "the platform layer must keep every inline body inside the host message budget and expose that budget");
assert.ok(imageEngineJs.includes("mime: \"image/jpeg\"") && imageEngineJs.includes("maxBytes: Math.max(40000, (app.platform.haminn.messageChars || 200000) - reserved)") && imageEngineJs.includes("String(maskDataUrl || openAiMaskDataUrl || \"\").length + 8000"), "the reference image must be a budgeted JPEG that leaves room for the mask and the RPC envelope");
assert.ok(canvasJs.includes("async function composeWithinBudget") && canvasJs.includes("encoded.length > maxBytes") && canvasJs.includes("composeWithinBudget(composition, targetSize, options.withResult === true, options)"), "the canvas must step the reference size down until it fits the budget instead of relying on JPEG quality alone");
assert.ok(canvasJs.includes('async function exportVisibleCanvas()') && editorJs.includes('canvas.exportVisibleCanvas()') && !editorJs.includes('function exportOptions()'), "toolbar Download must directly export the visible canvas");
// The toolbar's Download and the preview's download both hand their bytes to this one
// function, so it alone decides what lands in the user's gallery — and it used to put an
// SVG document there, wrapping a JPEG because `writeText` was the only writer back then.
// The gate is deliberately two-sided: demanding the chunked writer on its own would still
// pass if the SVG wrapper were re-added beside it, so the wrapper is forbidden by name and
// the text writer is counted out.
const exportBody = canvasJs.slice(canvasJs.indexOf("async function exportSource"), canvasJs.indexOf("async function exportVisibleCanvas"));
assert.ok(!/<svg[\s>]/.test(exportBody) && !exportBody.includes("image/svg"), "a download must not wrap its picture in an SVG document");
assert.equal((exportBody.match(/files\.(beginWrite|appendBytes|finishWrite|abortWrite)\(/g) || []).length, 4, "the export must open, feed, commit and be able to abandon the chunked write");
assert.equal((exportBody.match(/files\.writeText\(/g) || []).length, 0, "the export must not smuggle bytes through the text writer");
assert.ok(exportBody.includes('+ ".png"') && exportBody.includes('"image/png"'), "the downloaded file must be named and typed as a PNG");
// The turn handle hangs below the selection box and turns what is selected about the centre of
// that box, and the box turns with it. Three properties make it safe rather than merely present:
// the circle can never fight a corner for the same tap, every frame of the drag is rebuilt from
// the snapshot the drag began with, and the whole of a turn goes into one angle about one centre
// so that nothing in the geometry is written to. All three are pinned here, because a handle that
// is present but wrong is exactly what counting handles cannot catch.
assert.ok(canvasJs.includes("var ROTATE_HANDLE_GAP = (HANDLE_HIT_RADIUS + ROTATE_HANDLE_HIT_RADIUS + HANDLE_DRAW_RADIUS) / 2;"), "the circle must hang half the distance it hung - the owner's number - so it sits near the bottom edge where a thumb already is");
assert.ok(canvasJs.includes("function insideFrame(p, frame)") && canvasJs.includes('if (handles[index].key === "rotate" && (insideFrame(p, frame) || (gap > handles[index].radius && hitTest(p)))) continue;'), "half that distance puts the circle's reach back over the box, so the sliver must be refused: a touch on a selected object's own edge has to drag it rather than start a turn - and the same for any other object once the finger is off the circle's own ink, because the reach covers a band a finger wide all round the box and a touch on the object below a selected one belongs to that object, or the next object cannot be picked up at all");
assert.ok(canvasJs.includes("var gap = distance(p, handles[index]);") && canvasJs.includes("if (gap <= handles[index].reach) return handles[index];"), "and the circle keeps its own ink: a finger on the circle that is drawn is aiming at the circle, so a selection overlapping another object can still be turned - the band given back is the invisible one");
assert.ok(canvasJs.indexOf("var handle = current.length ? hitHandle(p, current) : null;") < canvasJs.indexOf("var hit = hitTest(p)"), "and handles are still tried before the tap is, which is the whole reason the circle has to refuse for itself: nothing downstream can give the object its touch back");
assert.equal((canvasJs.match(/hitTest\(p\)/g) || []).length, 3, "the hit test must be asked in exactly two places - the touch that picks, and the circle's own refusal - and defined once, so no reader of the drawing can disagree about what is under the finger");
assert.ok(canvasJs.includes("var ROTATE_HANDLE_DRAW_RADIUS = 27;") && canvasJs.includes("var ROTATE_HANDLE_HIT_RADIUS = 60;"), "the turn circle must be drawn at 27 - half again the 18 it was - with a reach to match, or a bigger picture would be a smaller target");
assert.ok(canvasJs.includes('["nw", "ne", "sw", "se"]') && canvasJs.includes('handles.push({ key: "rotate"'), "the corners must keep their order and the circle must be offered after them, for the corners are what the resize check indexes and the tap order is the array order");
assert.equal((canvasJs.match(/radius: HANDLE_DRAW_RADIUS, reach: HANDLE_HIT_RADIUS/g) || []).length, 1, "a handle's drawn size and its reach must be recorded once, where the handle is built");
assert.equal((canvasJs.match(/radius: ROTATE_HANDLE_DRAW_RADIUS, reach: ROTATE_HANDLE_HIT_RADIUS/g) || []).length, 1, "and the circle's own, likewise, so the picture and the target cannot drift apart");
assert.ok(canvasJs.includes("selectionContext.arc(handle.x, handle.y, handle.radius") && canvasJs.includes("var gap = distance(p, handles[index]);") && canvasJs.includes("if (gap <= handles[index].reach) return handles[index];"), "painting and hitting must both read that one record rather than decide again which handle is which");
const rotateBody = canvasJs.slice(canvasJs.indexOf("function beginRotate"), canvasJs.indexOf("function beginPinch"));
assert.ok(rotateBody.includes("originals: snapshotObjects(objects)") && rotateBody.includes("var node = transformContainer(objects);"), "a turn must be rebuilt from the snapshot the drag began with, so a long drag cannot accumulate rounding - and it must be given the container the selection is in, or handed one, rather than writing to the members");
assert.ok(rotateBody.includes("container: node ? { id: objects[0].groupId, m: node.m.slice() } : null"), "the drag must keep the placement the container began with, so every move of the gesture is one turn from that one placement and a drag of any length lands where a drag of one step lands");
const turnBody = canvasJs.slice(canvasJs.indexOf("function rotateTo(p) {"), canvasJs.indexOf("function beginPinch"));
assert.ok(turnBody.includes("node.m = app.drawing.placement.compose(app.drawing.placement.fromRotation(delta, transform.centre), transform.container.m);"), "a selection of several turns its container: one turn about one centre, written against the placement the drag began with");
const containerTurnBranch = turnBody.slice(turnBody.indexOf("if (transform.container) {"), turnBody.indexOf("} else {"));
assert.ok(!/object\.(?:rotation|linear|linear\b|rotationPivot|offset|points|x|y|width|height)\s*=/.test(containerTurnBranch) && !containerTurnBranch.includes("writeLevel("), "and must leave every member exactly as it was - no angle, no matrix, no geometry: that is the whole reason two members turned against each other still turn as one box and each keeps its own angle when the group is broken up");
assert.ok(containerTurnBranch.includes("app.drawing.placement.fromRotation(delta, transform.centre)"), "the turn must be given about the centre of the box the user is holding, which is what keeps the box spinning where it is");
const loneTurnBranch = turnBody.slice(turnBody.indexOf("} else {"));
assert.ok(loneTurnBranch.includes("writeLevel(object, app.drawing.placement.compose(app.drawing.placement.fromRotation(delta, transform.centre), app.drawing.levelMap(transform.originals[index])))"), "a selection of one turns itself, and still from the snapshot rather than from the record it just wrote");
assert.ok(turnBody.includes("Math.round(turned / (Math.PI / 2)) * (Math.PI / 2)") && canvasJs.includes("var ROTATE_SNAP_ANGLE"), "within the snap angle a turn must land on upright exactly, or a picture can never be brought back to level by hand and every later box carries the skew");
assert.ok(turnBody.includes("app.drawing.normalizeAngle(Math.atan2("), "the pointer's angle must be read as the short way round, or a finger crossing the far side of the circle - where the grip sits after a quarter turn - would spin the selection almost a full turn");
assert.ok(canvasJs.includes("rotating && rotating.changed"), "a finished turn must count as a change, or it would never reach the undo journal");
// A container is a node of its own - a placement and a rectangle - and the members only name it. Three
// operations decide how long it lives, and each answers a different question: a container that exists
// only because several things are selected is folded away when the selection is not theirs, a container
// left with fewer than two members is not a group at all, and a group the user made is folded into its
// members and deleted on ungroup. All three end in the same fold, which is why the fold is what is read.
const releaseBody = canvasJs.slice(canvasJs.indexOf("function releaseTemporaryContainers"), canvasJs.indexOf("function pruneContainers"));
assert.ok(releaseBody.includes("if (table[id].formal) return;") && releaseBody.includes("var same = members.length === selected.length && members.every(function (object) { return selected.indexOf(object.id) >= 0; });") && releaseBody.includes("if (!same) melt(id);"), "a container that exists only because several things are selected must be folded away the moment the selection is not exactly its members - and a group the user made must not be, which is the whole difference between the two");
assert.ok(canvasJs.includes("function setSelection(ids)") && canvasJs.includes("releaseTemporaryContainers(expanded);") && canvasJs.includes("pruneContainers();"), "every selection change comes through setSelection, so that is where both are answered for - and they must be settled before the ids are committed, or the next reader meets a container whose membership is not the thing it is looking at");
const pruneBody = canvasJs.slice(canvasJs.indexOf("function pruneContainers"), canvasJs.indexOf("function frameOf("));
assert.ok(pruneBody.includes("if (members.length >= 2) return;") && pruneBody.includes("if (!members.length) { delete table[id]; return; }") && pruneBody.includes("melt(id);"), "and a container left with one member is not a group: the last member takes the placement onto itself so the picture does not move, and a container with none is simply dropped");
const meltBody = canvasJs.slice(canvasJs.indexOf("function melt(groupId)"), canvasJs.indexOf("function beginResize"));
assert.ok(meltBody.includes("var map = node && node.m ? node.m : app.drawing.containerMap(object);") && meltBody.includes("if (map) absorb(object, map); else writeLevel(object, app.drawing.levelMap(object));") && meltBody.includes("delete object.groupId;") && meltBody.includes("delete groupTable()[groupId];"), "dissolving a group means deleting the group: each member takes the container's placement onto itself - so the picture does not move a pixel - stops naming it, and the node goes; a member naming a group with no node behind it is a record written before containers were nodes, and the group is folded in from the member then");
assert.ok(canvasJs.includes("function absorb(object, map) { writeLevel(object, app.drawing.placement.compose(map, app.drawing.levelMap(object))); }"), "inheriting a container's placement is composing it outside the member's own, which is exactly what the two levels drew - which is why nothing moves when it happens");
const writeBody = canvasJs.slice(canvasJs.indexOf("function writeLevel(object, total)"), canvasJs.indexOf("function absorb("));
assert.ok(writeBody.includes("delete object.groupRotation; delete object.groupPivot;"), "a placement written onto a record must stop it naming a container, or what has just been folded in would be drawn through a second time");
assert.ok(writeBody.includes("if (app.drawing.placement.isIdentity(total)) return;") && writeBody.includes("object.rotation = app.drawing.normalizeAngle(app.drawing.placement.angleOf(total)); object.rotationPivot = fixed;") && writeBody.includes("object.linear = [total[0], total[1], total[2], total[3]];"), "a placement that is a plain turn is written back as the record every object has always had - an angle and the centre it is about - so an ordinary object is untouched by any of this, and only a placement no rectangle can spell becomes a matrix");
// One container per selection, made in one place. A selection already inside one transforms that one
// rather than a new one, or the group the user made would be abandoned the first time it was turned;
// a selection whose members arrived from containers of their own starts from a fresh one, and those
// containers are folded into their members first - which moves nothing, and is the only arrangement in
// which one box around the whole selection is possible.
const containerForBody = canvasJs.slice(canvasJs.indexOf("function containerFor(objects, formal)"), canvasJs.indexOf("function transformContainer("));
assert.ok(canvasJs.includes("function commonGroupId(objects)") && canvasJs.includes('for (var index = 1; index < objects.length; index += 1) { if (objects[index].groupId !== id) return ""; }'), "the name every member of a selection agrees on, or nothing when they do not all agree: a selection is inside a container only when the whole of it is");
assert.ok(containerForBody.includes("var id = commonGroupId(objects);") && containerForBody.includes("var existing = id ? app.drawing.groupNode(id) : null;") && containerForBody.includes("if (existing) return existing;"), "a selection already inside one container transforms that container rather than being given a second one");
assert.ok(containerForBody.includes("objects.forEach(function (object) { if (object.groupId) melt(object.groupId); });"), "and one that is not starts from a fresh container, with the containers its members did arrive with folded into them first");
assert.ok(containerForBody.includes("var node = { m: app.drawing.placement.identity, rect: boxOfEdges(inkBox(objects, null)), formal: Boolean(formal) };"), "the fresh container is created upright and holding exactly the rectangle around what the selection is drawn as - the box the user can already see - so nothing moves when it is made");
assert.ok(canvasJs.includes("function transformContainer(objects) { return objects.length > 1 ? containerFor(objects, false) : null; }"), "and there is one place a multi-member transform gets its container, so no path can transform a selection without one or hand one to a lone object");
assert.equal((canvasJs.match(/= transformContainer\(objects\);/g) || []).length, 4, "a corner pull, a pinch, a turn and the toolbar's buttons must all take their container from that one place, so none of them can be the odd one out");
assert.ok(canvasJs.includes("if (node) scaleContainer(node, factor, factor, centre);") && canvasJs.includes("objects.forEach(function (object, index) { scaleLone(object, originals[index], factor, factor, centre); });"), "and the toolbar's buttons take the same fork, so a group is scaled as a group there too");
// The box is the container's own rectangle carried by the container's own placement - never a
// rectangle measured afresh around whatever is inside, and never a guess at "is every member drawn at
// the same angle". A box built from either of those came loose from the shapes it was meant to box.
const frameBody = canvasJs.slice(canvasJs.indexOf("function selectionFrame(selection)"), canvasJs.indexOf("function framePoint("));
assert.ok(frameBody.includes("if (objects.length === 1) return loneFrame(objects[0]);"), "a lone object is boxed by its own record, at the angle it is drawn at, as it has been since the angle was one");
assert.ok(frameBody.includes("var node = app.drawing.sharedContainer(objects);") && frameBody.includes("if (node) return frameOfBox(node.rect, node.m);"), "several members are boxed by the container's own rectangle and its own placement - which is what makes the box follow the group instead of the canvas");
assert.ok(frameBody.includes("return frameOfBox(boxOfEdges(inkBox(objects, null)), app.drawing.placement.identity);"), "and a selection that has not been transformed yet is in no container yet - the one it is about to be given is created upright - so its box is the tight upright rectangle around what is drawn");
assert.ok(frameBody.includes("if (rotating && rotating.box) return frameOf(rotating.box, rotating.turned, app.drawing.boxCentre(rotating.box));"), "the one exception is the drag itself: while a finger is down the box is the one it took hold of, spun by the turn made so far, or it would slide out from under the hand - the tight box around a turned selection is not the turn of the tight box around it");
assert.ok(frameBody.indexOf("objects.length === 1") < frameBody.indexOf("rotating && rotating.box"), "and the exception is for a selection of several: a lone object is boxed by its own record");
assert.ok(!canvasJs.includes("function commonAngle") && !canvasJs.includes("function containerPivot") && !canvasJs.includes("function sharedFrame") && !canvasJs.includes("function groupSpin") && !canvasJs.includes("function groupFrame"), "and the box must not be derived beside this: 'is every member drawn at the same angle' and 'what centre was the last turn about' were both the box coming loose from the shapes it was meant to box");
const frameOfBoxBody = canvasJs.slice(canvasJs.indexOf("function frameOfBox(box, map)"), canvasJs.indexOf("function loneFrame("));
assert.ok(frameOfBoxBody.includes("var centre = app.drawing.placement.apply(map, box.x + box.width / 2, box.y + box.height / 2);") && frameOfBoxBody.includes("width: Math.max(1, box.width * axes[0]), height: Math.max(1, box.height * axes[1]),") && frameOfBoxBody.includes("angle: app.drawing.placement.angleOf(map)"), "a rectangle placed is its own width and height at the size and angle of the placement that carries it, about the point its own centre lands on - the whole of where a box is, for an object and for a container alike");
const loneFrameBody = canvasJs.slice(canvasJs.indexOf("function loneFrame(object)"), canvasJs.indexOf("function selectionFrame("));
assert.ok(loneFrameBody.includes("if (app.drawing.placement.isSquare(map)) return frameOfBox(box, map);") && loneFrameBody.includes("return frameOfBox(boxOfEdges(inkBox([object], app.drawing.placement.invert(map))), map);"), "a lone object is boxed by its own box carried by its whole placement - so the box is at the angle and size the picture is drawn at - and where the placement is a shear rather than a turn and a size, by the tightest rectangle of the record's own axes that holds what is drawn");
assert.ok(!canvasJs.includes("frameOf(app.drawing.contentBounds(object),"), "and never by a box measured around the member's leaned rectangle, which is wider than the picture it is meant to hold");
assert.ok(canvasJs.includes("selectionContext.rotate(frame.angle)") && canvasJs.includes("selectionContext.strokeRect(-frame.width / 2, -frame.height / 2, frame.width, frame.height)"), "the box must be drawn in the frame's own axes, or the outline and the handles would disagree about where the rectangle is");
// Every path that paints a picture - the live canvas, the composite handed to the model, the gallery
// thumbnail - comes through one helper, and it applies the whole placement as the single matrix the
// canvas takes. That is both why a container can be more than a turn and why none of those three can
// quietly paint a picture upright while its box says otherwise.
assert.equal((canvasJs.match(/drawPicture\(/g) || []).length, 4, "every path that paints a picture must go through the one helper that applies the placements");
assert.equal((canvasJs.match(/drawImage\(image, object\.x, object\.y/g) || []).length, 1, "the upright draw may be spelled in exactly one place, the helper itself, so no paint path can reach the canvas without the placements");
const drawPictureBody = canvasJs.slice(canvasJs.indexOf("function drawPicture("), canvasJs.indexOf("function scheduleRender("));
assert.ok(drawPictureBody.includes("applySpin(ctx, object, centre)") && drawPictureBody.includes("drawImage(image, -object.width / 2"), "the helper must apply the placement itself instead of delegating it back to the caller");
const drawStrokeBody = canvasJs.slice(canvasJs.indexOf("function drawStroke("), canvasJs.indexOf("function loadImage("));
assert.ok(drawStrokeBody.includes("applySpin(ctx, object);"), "a stroke must be painted with the placements it carries, in the same place every other paint path applies them");
assert.equal((canvasJs.match(/applySpin\(/g) || []).length, 3, "one definition and two callers - the picture and the stroke - because a paint path that applied a placement on its own would be free to disagree");
assert.ok(canvasJs.includes("var map = app.drawing.placedMap(object);") && canvasJs.includes("if (app.drawing.placement.isIdentity(map)) return false;") && canvasJs.includes("ctx.transform(map[0], map[1], map[2], map[3], at.x - ox, at.y - oy);"), "and the placement is written as the one matrix the canvas takes, which is what lets a container be more than a turn: applying one is a single call rather than a turn per level, so the two levels cannot disagree");
const turnedBoxBody = drawingJs.slice(drawingJs.indexOf("function turnedBox("), drawingJs.indexOf("function localBounds("));
assert.ok(turnedBoxBody.includes("pivot.x + cornerX * cos") && turnedBoxBody.includes("box.x + halfWidth - pivot.x"), "a box must be carried round the centre it was turned about, not round its own centre: for a container those are two different points, and turning about the wrong one is invisible on a lone picture");
// The scale of a container goes on the *inside*, between its rectangle and its placement: those two are
// one pair, and a scale composed on the outside leaves the rectangle behind - an even scale that way is
// set at no angle at all, so the first pull by the same amount on both axes would stand the box upright
// and move the anchor with it.
const scaleInAxesBody = drawingJs.slice(drawingJs.indexOf("function scaleInAxes("), drawingJs.indexOf("function angleOf("));
assert.ok(scaleInAxesBody.includes("var back = invert(m);") && scaleInAxesBody.includes("return compose(m, fromScale(scaleX, scaleY, applyTo(back, anchor.x, anchor.y)));"), "a container's scale must be composed on the inside, with the anchor read back as a point of the container's own rectangle, so the corner the hand is holding stays under the hand");
assert.equal((scaleInAxesBody.match(/compose\(/g) || []).length, 1, "and it is one composition: a placement composed onto a scale composed onto the placement is the same mistake spelled the long way - the scale has left the rectangle behind, and an even pull is what cannot survive that");
assert.equal((scaleInAxesBody.match(/fromScale\(/g) || []).length, 1, "with the container's scale written exactly once, on the inside where its rectangle is");
assert.ok(drawingJs.includes("function cloneGroups(table)") && drawingJs.includes("function groupsFromMembers(objects)") && drawingJs.includes("function measureContainer(members)"), "a container table has to travel with the objects - a member only names its container and cannot say where it is drawn without it - and a record written before containers were nodes has to be rebuilt into one");
const cloneGroupsBody = drawingJs.slice(drawingJs.indexOf("function cloneGroups(table)"), drawingJs.indexOf("function measureContainer("));
assert.ok(cloneGroupsBody.includes("m: (node.m || identity).slice()") && cloneGroupsBody.includes("formal: Boolean(node.formal)"), "a copy of a container is a copy of its placement and its rectangle, so an entry of the journal, or a duplicate of a group, cannot share one with the original");
const groupsFromMembersBody = drawingJs.slice(drawingJs.indexOf("function groupsFromMembers(objects)"), drawingJs.indexOf("function selectionBounds("));
assert.ok(groupsFromMembersBody.includes("var angle = groupRotationOf(object), pivot = groupPivotOf(object);") && groupsFromMembersBody.includes("rect: measureContainer(members)") && groupsFromMembersBody.includes("formal: true"), "a group rebuilt from an older record keeps the turn the members carried, has its rectangle measured from them - the group named no rectangle at all - and is a group the user made, so it stays");
assert.ok(drawingJs.includes("function levelMap(object)") && drawingJs.includes("function containerMap(object)") && drawingJs.includes("function placedMap(object)") && drawingJs.includes("return container ? compose(container, levelMap(object)) : levelMap(object);"), "where a member is drawn is its own placement and then its container's, and each is read through one accessor - a record written before a placement was a matrix still spells a turn about a centre and is read as it stands");
assert.ok(drawingJs.includes("function contentBounds(object)") && drawingJs.includes("return boxOfMap(levelMap(object), localBounds(object));"), "what a member draws for itself must be its own placement applied, the container's not, because a container has to hold its contents and a member turned on its own leans out of the box its record spells");
assert.ok(drawingJs.includes("function bounds(object)") && drawingJs.includes("return boxOfMap(placedMap(object), localBounds(object));"), "and where it is drawn must be that carried by the container's placement, or hit-testing and the marquee would read a rectangle the object is not in");
assert.ok(drawingJs.includes("function sharedContainer(objects)") && drawingJs.includes("return node && node.m && node.rect ? node : null;"), "the one container a selection is inside must be readable off the container itself, rectangle and placement together, because a container with no rectangle is not one a box can be drawn from");
assert.ok(drawingJs.includes("function groupRotationOf(object)") && drawingJs.includes("function groupPivotOf(object)"), "the container a record written before containers were nodes names is read through the same two accessors, so such a record reads as upright rather than as NaN");
assert.ok(!drawingJs.includes("rotationPivotOf(object) || groupPivotOf(object)"), "the container's centre must not stand in for a member's own: a member that never named one is drawn about the centre of its own box");
assert.ok(canvasJs.includes("var back = app.drawing.placement.invert(app.drawing.placedMap(object));") && canvasJs.includes("return back ? app.drawing.placement.apply(back, p.x, p.y) : p;"), "a tap must be read in the coordinates the object is stored in, by undoing the whole placement at once - both levels, the container's included - or a group turned on its side would answer taps it is not under");
// One resize algorithm for every case, and it is two drags rather than one: a corner pull moves the two
// axes by their own factors, which is the difference between resizing a box and only growing it. The pull
// is read in the box's own axes about the corner that is drawn, each axis runs out of room on its own,
// and what it lands on is the container when the selection is inside one and the lone record when it is
// not - the members are not touched at all in the first case, which is what stops an uneven pull from
// stretching each of them along axes of its own and twisting the arrangement.
assert.ok(canvasJs.includes("function beginResize(objects, handle, pointerId)") && canvasJs.includes("var factorX = local.x / (-2 * transform.localX);") && canvasJs.includes("var factorY = local.y / (-2 * transform.localY);"), "a corner drag must be read as one drag per axis, or the box could never be made long and thin");
assert.ok(canvasJs.includes("factorX = Math.max(limits.minimumX, Math.min(limits.maximumX, factorX));") && canvasJs.includes("factorY = Math.max(limits.minimumY, Math.min(limits.maximumY, factorY));"), "each axis must run out of room on its own, or a pull that has hit the floor sideways would freeze the other axis with it");
assert.ok(canvasJs.includes("var local = turnPoint(-transform.angle, p.x - transform.held.x, p.y - transform.held.y);") && canvasJs.includes("held: corner, anchor: corner"), "a resize must read the drag in the box's own axes about the corner that is drawn, which is one point in both readings - which is why the upright resize is unchanged");
const resizeBody = canvasJs.slice(canvasJs.indexOf("function resizeTo(p) {"), canvasJs.indexOf("function beginPinch("));
assert.ok(resizeBody.includes("if (transform.container) scaleContainer(app.drawing.groupNode(transform.container.id), factorX, factorY, transform.anchor, transform.container.m);") && resizeBody.includes("else transform.objects.forEach(function (object, index) { scaleLone(object, transform.originals[index], factorX, factorY, transform.anchor); });"), "and the two factors must land on the container when the selection is inside one and on the lone record when it is not, always against the box as the drag began with it");
assert.ok(resizeBody.includes("transform.changed = Math.abs(factorX - 1) > 0.002 || Math.abs(factorY - 1) > 0.002;"), "and a pull that moved either axis must count as a change, or the journal would fill with steps for touches that moved nothing");
assert.ok(!canvasJs.includes("proportional") && !canvasJs.includes("diagonalX") && !canvasJs.includes("transform.proportional"), "a corner drag must stay two axes for every selection: one factor shared by both axes would answer a sideways pull by growing the selection the same amount, which is not the gesture the corner offers");
const limitsBody = canvasJs.slice(canvasJs.indexOf("function transformLimits"), canvasJs.indexOf("function snapshotObjects"));
assert.ok(limitsBody.includes("var drawn = app.drawing.placement.axesOf(app.drawing.placedMap(object));") && limitsBody.includes("var width = Math.max(1, box.width * drawn[0]), height = Math.max(1, box.height * drawn[1]);"), "the room a member has must be read on the size it is drawn at, not the size its record spells, or a member in a scaled container would be given the wrong floor");
assert.ok(limitsBody.includes("limits.minimum = Math.max(limits.minimumX, limits.minimumY);") && limitsBody.includes("limits.maximum = Math.min(limits.maximumX, limits.maximumY);"), "and the pair a uniform scale may use must be the tighter half of them, since a pinch and the toolbar's buttons move both axes together");
const scaleLoneBody = canvasJs.slice(canvasJs.indexOf("function scaleLone(object, original, factorX, factorY, anchor)"), canvasJs.indexOf("function scaleContainer("));
assert.ok(scaleLoneBody.includes("var map = app.drawing.levelMap(original);") && scaleLoneBody.includes("var local = back ? app.drawing.placement.apply(back, anchor.x, anchor.y) : anchor;"), "the anchor must be read back through the member's own placement first, so the corner the hand is holding stays under the hand");
assert.ok(scaleLoneBody.includes("object.points = (original.points || []).map(") && scaleLoneBody.includes("object.width = original.width * Math.sqrt(factorX * factorY);"), "a stroke is moved point by point, and its brush width - a length with no axis to lean along - takes the root of the two factors, which is the plain factor when they agree");
assert.ok(scaleLoneBody.includes("var fixed = app.drawing.placement.holdsStill(map);") && scaleLoneBody.includes("if (object.rotation !== undefined && !object.rotationPivot && !object.linear && fixed) object.rotationPivot = fixed;"), "only the missing centre may be written, and only for a record that names an angle and nothing else: a turn spelled as an angle with no centre is about the record's own centre, and the record has just changed size, so leaving it implicit would walk the picture away from the corner the hand is holding");
assert.ok(!scaleLoneBody.includes("writeLevel(object"), "and the angle is never re-derived from the placement: recomputing it would move it by the last bit of the arithmetic and turn an exact quarter into a near one");
const scaleContainerBody = canvasJs.slice(canvasJs.indexOf("function scaleContainer(node"), canvasJs.indexOf("function writeLevel("));
assert.ok(scaleContainerBody.includes("node.m = app.drawing.placement.scaleInAxes(from || node.m, factorX, factorY, anchor);"), "and scaling a container is nothing but scaling the container - from the placement the drag began with, not from the one the last move left");
assert.ok(canvasJs.includes("var node = app.drawing.groupNode(transform.container.id);") && canvasJs.includes("node.m = app.drawing.placement.compose(app.drawing.placement.fromScale(factor, factor, transform.center), transform.container.m);") && canvasJs.includes("node.m = app.drawing.placement.compose([1, 0, 0, 1, dx, dy], node.m);"), "a pinch has one number to give and no corner to speak of, so it scales the container about the point between the fingers and then carries it along with them");
assert.ok(canvasJs.includes("if (transform.container) {") && canvasJs.includes("scaleLone(object, transform.originals[index], factor, factor, transform.center);") && canvasJs.includes("translate(object, dx, dy);"), "and one object reaches the same result by scaling and moving its own record");
assert.ok(!canvasJs.includes("function resizeTurnedFrame") && !canvasJs.includes("function scaleTurnedFrame"), "the turned resize must be the one algorithm rather than a second path beside it, or the two would drift apart");
// Moving a member. A record that carries a placement of its own moves the placement and leaves its
// geometry where it is: the drawn picture is the geometry through the placement, so moving the geometry
// would move the picture by the placement's own idea of that direction - a different direction as soon
// as anything is turned. The centres the record turns about are points of the same plane, so they go too.
assert.ok(canvasJs.includes("if (object.linear) {") && canvasJs.includes("object.offset = { x: (Number(offset.x) || 0) + dx, y: (Number(offset.y) || 0) + dy };"), "a member carrying a placement of its own must move the placement rather than its geometry");
assert.ok(canvasJs.includes("if (pivot) object.rotationPivot = { x: pivot.x + dx, y: pivot.y + dy };") && canvasJs.includes("if (group) object.groupPivot = { x: group.x + dx, y: group.y + dy };"), "both centres an object turns about must be carried along when it is moved, or the box would come loose from the objects it boxes");
// Grouping is not the making of a group - the selection is already in a container. What the button does
// is make that container permanent, and it must touch nothing else: the owner's requirement is that the
// turn of the selection is unchanged when it becomes a group, so re-aiming or re-measuring it is the
// failure this pins. Dissolving is the same identity read backwards: the container is folded into its
// members and deleted, and the picture has not moved.
const groupBody = canvasJs.slice(canvasJs.indexOf("function groupSelected()"), canvasJs.indexOf("function ungroupSelected("));
assert.ok(groupBody.includes("containerFor(objects, true).formal = true;"), "grouping must make the container the selection is already in into a real one, keeping the angle and the size it has - which is what makes a group come back looking like itself");
assert.ok(!groupBody.includes("rotation") && !groupBody.includes("rect") && !groupBody.includes("measure"), "and must write nothing else at all: re-aiming or re-measuring the container here is exactly the turn the owner requires to be unchanged");
const ungroupBody = canvasJs.slice(canvasJs.indexOf("function ungroupSelected()"), canvasJs.indexOf("function duplicateSelected("));
assert.ok(ungroupBody.includes("ids.forEach(function (id, index) { if (ids.indexOf(id) === index) melt(id); });"), "ungrouping must fold the container into its members and delete it - the group itself is gone, its angle and its size with it, and what is left is exactly what it looked like");
assert.ok(ungroupBody.includes("var ids = objects.map(formalGroupId).filter(function (id) { return Boolean(id); });"), "and must take apart only a group: a container that exists because several things are selected is not something the user made, so the mutator itself has to refuse it rather than lean on a greyed-out button - which is the pairing that came apart here");
// The two buttons beside them are about a group, never about the box a selection happens to be
// wearing. A selection that has only been transformed is inside a temporary container like any other,
// and a temporary container is not a group, so both buttons have to be armed by the container's own
// flag. Reading the members' names instead is what the owner saw: the moment anything was turned,
// Group went dead and Ungroup came alive.
const armedBody = canvasJs.slice(canvasJs.indexOf("function canGroupSelected()"), canvasJs.indexOf("function groupSelected()"));
assert.ok(armedBody.includes("var node = app.drawing.sharedContainer(objects);") && armedBody.includes("return !(node && node.formal);"), "Group must be live for a selection of several things unless the whole of it is already inside one real container");
assert.ok(armedBody.includes("return node && node.formal ? object.groupId : \"\";") && armedBody.includes("if (formalGroupId(objects[index])) return true;"), "and Ungroup must be live only when some of the selection is really in a group, told apart from a temporary container by the container's own flag in one place");
assert.ok(armedBody.includes("if (objects.length < 2) return false;"), "while one object on its own is not a group, so Group has nothing to do with it");
assert.ok(canvasJs.includes("canGroupSelected: canGroupSelected") && canvasJs.includes("canUngroupSelected: canUngroupSelected"), "both predicates must be published, or the editor would have nothing to ask");
assert.ok(editorJs.includes('node("group-selected").disabled = !canvas.canGroupSelected()') && editorJs.includes('node("ungroup-selected").disabled = !canvas.canUngroupSelected()'), "the two buttons must be armed by the canvas's own predicates rather than by a second copy of the rule");
assert.ok(!editorJs.includes("alreadyOneGroup") && !editorJs.includes("groupedObjects"), "and the old rule - several things selected, all naming one container - must be gone from the editor altogether, since a member's name cannot tell a group from the box around a selection");
const duplicateBody = canvasJs.slice(canvasJs.indexOf("function duplicateSelected()"), canvasJs.indexOf("async function addImage("));
assert.ok(duplicateBody.includes("table[copiedGroups[id]] = app.drawing.cloneGroups({ node: node }).node;"), "a copy of a group must be a group: the container is copied under the new name, or the duplicate would be a set of members naming a container that does not exist");
// The containers belong in everything that carries a drawing around. A member only names its container,
// so an entry of the journal, an undo, a reset or a loaded record that kept the members and lost the
// table would put a turned group away and bring it back upright.
assert.ok(canvasJs.includes("return { objects: objects, groups: app.drawing.cloneGroups(state.groups),") && canvasJs.includes("groups: app.drawing.cloneGroups(value && value.groups),"), "a journal entry must carry the containers with the objects, and so must a copy of one");
assert.ok(canvasJs.includes("state.groups = app.drawing.cloneGroups(data.groups);") && canvasJs.includes("state.groups = {};") && canvasJs.includes("state.groups = saved.groups && Object.keys(saved.groups).length ? app.drawing.cloneGroups(saved.groups) : app.drawing.groupsFromMembers(state.objects);"), "restoring must bring the containers back, resetting must clear them, and loading must fall back to rebuilding them from the members for a record written before containers were nodes");
assert.ok(storeJs.includes("var snapshot = { schema: 11,") && storeJs.includes("snapshot.groups = app.drawing.cloneGroups(app.state.groups);"), "an artwork record must be written at schema 11 and carry the container table beside its objects");
assert.ok(storeJs.includes("if (Number(copy.schema) < 11) {") && storeJs.includes("copy.groups = app.drawing.groupsFromMembers(copy.objects || []);") && storeJs.includes("(copy.objects || []).forEach(function (object) { delete object.groupRotation; delete object.groupPivot; });"), "and a record written before that must be rebuilt into a table with the copies left on the members dropped, because the members now name the container and nothing else");
assert.ok(storeJs.includes("if (stored && Number(stored.schema) >= 11)"), "the fingerprint cache may only be entered for a record this version wrote, or a record from before it would be compared against state it never carried");
const selfTestJs = fs.readFileSync(path.join(root, "app/features/self-test.js"), "utf8");
assert.ok(selfTestJs.includes('checks.quarterTurn = turnBy(90)') && selfTestJs.includes('checks.turnSnapsUpright = turnBy(3)') && selfTestJs.includes('checks.turnFollowsPointer = turnBy(-40)'), "the device self-test must drive the handle at three distances, so a swallowed turn and an absorbed one cannot both pass");
assert.ok(selfTestJs.includes('checks.turnHandleSize = Boolean(gripBefore) && gripBefore.radius === 27 && gripBefore.reach === 60'), "the self-test must read the circle's size on the device, where a wrong radius is what the user actually feels");
assert.ok(selfTestJs.includes("checks.turnHandleGap") && selfTestJs.includes("gripFrame.y + gripFrame.height / 2) - 56"), "the self-test must measure the circle's distance to the bottom edge on the device, where the owner's number is what the thumb feels");
assert.ok(selfTestJs.includes("checks.cornerResizeTwoAxes") && selfTestJs.includes("checks.cornerResizeHoldsOpposite"), "the self-test must pull a corner further across than down on the device and read back both shares - the two axes moving apart and the opposite corner staying put - since a ratio that never changes is what a one-number scale would show");
assert.ok(selfTestJs.includes("checks.turnUndoToLevel") && selfTestJs.includes("canvas.redo(); canvas.redo();"), "the self-test must take two turns back to level, one undo each, or a build that folded two drags into one journal step would read as correct");
assert.ok(selfTestJs.includes("checks.groupTurnSharesContainer") && selfTestJs.includes("checks.groupTurnContainerAngle") && selfTestJs.includes("checks.groupTurnMovesNothing") && selfTestJs.includes("checks.groupBoxIsContainer"), "the self-test must turn a whole group on the device and read back that the members share one container and one only, that the turn went onto that container, that not one number of any member's geometry moved, and that the box is the container's own rectangle carried by the container's own placement");
assert.ok(selfTestJs.includes("checks.turnMakesNoContainer") && selfTestJs.includes("checks.noContainerBeforeGroupTurn") && selfTestJs.includes("checks.temporaryContainerReleased") && selfTestJs.includes("checks.releaseKeepsTheAngle"), "and must read the two halves of a container's life that a member's own record cannot show: a lone object turns without making one, a selection of several is in none before it is first transformed, and the moment the selection is not theirs the container is folded into its members and gone - leaving each member carrying the whole turn as its own angle");
assert.ok(selfTestJs.includes("checks.groupIsFormal") && selfTestJs.includes("checks.groupKeepsTransform") && selfTestJs.includes("checks.groupScaleMovesContainerOnly") && selfTestJs.includes("checks.ungroupDeletesGroup"), "and must read 成组 as the making of the container that is already there - the box coming back exactly as it was, so nothing was re-aimed or re-measured - that transforming the group moves the container and touches no child, and that 解散 really deletes the group, which is the reading the owner corrected");
assert.ok(selfTestJs.includes("checks.groupButtonsOnTemporaryContainer") && selfTestJs.includes("checks.groupButtonsOnAGroup") && selfTestJs.includes("checks.groupButtonsAfterDissolve") && selfTestJs.includes("checks.groupButtonsBlindToGroup") && selfTestJs.includes('document.getElementById("group-selected")') && selfTestJs.includes("checks.ungroupRefusesTemporaryContainer"), "and must read the two buttons themselves after a selection has been turned, scaled, carried and pinched - 成组 still live and 解散 still dead while the container is a temporary one, the two swapping over when it becomes a group and swapping back when it is dissolved - together with the guard that the box really had been transformed, since a button reading about an untouched selection would be right by accident; and must read that 解散 on a mere selection leaves its container standing");
assert.ok(selfTestJs.includes("checks.groupTurnKeepsOwnAngle") && selfTestJs.includes("checks.groupTurnCarriesWhole"), "and must turn a group whose members disagree on an angle - the case the box used to give up on - reading back that each member kept its own angle and that every member was drawn where the turn put it");
assert.ok(selfTestJs.includes("checks.groupCarryMovesContainer") && selfTestJs.includes("checks.groupCarryMovesBox") && selfTestJs.includes("checks.groupCarryMovesInk") && selfTestJs.includes("checks.groupCarryMovesNoChild"), "the self-test must carry a group on the device after turning it - the case the owner reported - and read back all four halves at once: the displacement landing on the container's own placement, the box going with it, the ink landing exactly a finger's distance away, and no child written to. Any one of them alone can be right by accident, which is how a group whose members moved while its box stood still went unnoticed");
assert.ok(selfTestJs.includes("checks.groupPinchScalesContainer") && selfTestJs.includes("checks.groupPinchOneFactor") && selfTestJs.includes("checks.groupPinchMovesInk") && selfTestJs.includes("checks.groupPinchMovesNoChild") && selfTestJs.includes("function inBox("), "and must pinch a turned group with two fingers placed inside the box's own frame, reading back that the container took the factor on both of its axes at once, that the ink landed where growing about the point between the fingers and carrying it put it, and that no child was written to");
assert.ok(selfTestJs.includes("checks.mixedGroupPullIsPerAxis") && selfTestJs.includes("checks.groupTurnLoneBox"), "the self-test must pull a corner of a selection whose members disagree and read back that its ink landed exactly where a pull of its own axes put it, and must read a member of a turned group alone as boxed at the angle it is drawn at");
assert.ok(selfTestJs.includes('=== "nw,ne,sw,se,rotate"'), "the self-test must read the handle set as a sequence, so a circle that displaced a corner cannot pass as a count of five");
assert.ok(selfTestJs.includes("checks.brandIcon") && selfTestJs.includes('document.querySelector(".brand-mark img")'), "the self-test must look for the app's own icon in the top bar, where a letter standing in for it would otherwise go unnoticed");
// The top bar used to carry the letter the product was named after before it was renamed, which
// no version bump would ever have replaced. The icon the app is packaged with is the one place
// that can be right for both the top bar and the About sheet, so both must point at it and the
// mark must be a picture slot rather than a letter slot.
assert.ok(!html.includes('<span class="brand-mark">V</span>') && html.includes('<span class="brand-mark" aria-hidden="true"><img src="./app/assets/icon.webp" alt=""></span>'), "the top bar must show the packaged icon rather than a letter standing in for it");
assert.ok(settingsJs.includes('<span class="brand-mark" aria-hidden="true"><img src="./app/assets/icon.webp" alt=""></span>'), "the About sheet must show the same icon, or the product would have two different marks");
assert.ok(!/brand-mark[^}]*font-style:italic/.test(baseCss) && baseCss.includes(".brand-mark img{width:100%;height:100%;object-fit:contain}"), "the mark must be a picture slot: a letter's styling left behind would fight the icon it now holds");
assert.ok(!/about-brand \.brand-mark\{[^}]*font-size/.test(componentsCss), "the About sheet's mark must not keep the letter sizing it no longer needs");
assert.match(editorJs, /seed-lock[\s\S]*generate-quick["']\)\.click\(\)/, "rolling a seed must trigger Fast generation");
assert.match(editorCss, /\.auto-button,\.generation-button\{[^}]*width:44px;height:44px;flex:0 0 44px/);
assert.match(editorCss, /\.seed-random-button,\.overlay-generate-button,\.snapshot-button,\.export-button\{[^}]*width:44px;height:44px;flex:0 0 44px/);
assert.ok(editorCss.includes('#brush-size-value{transform:translateX(-8px)}'), "stroke size output must sit 8px closer to its slider");
assert.ok(html.includes('id="prompt-display"') && !html.includes('id="prompt-input"') && !html.includes('id="prompt-save"'), "top prompt must be a read-only scrolling summary");
assert.match(editorCss, /\.prompt-panel\{[^}]*border:0;[^}]*background:transparent/);
assert.match(editorCss, /\.render-result-trigger\{[^}]*position:absolute;[^}]*right:8px;[^}]*bottom:8px;[^}]*width:34px;height:34px/);
assert.ok(!editorCss.includes(".render-notice"), "Render must not add a separate bottom notice bar");
assert.match(editorCss, /\.work-name span\{[^}]*text-overflow:ellipsis;white-space:nowrap/);
assert.match(editorCss, /\.work-name\{[^}]*flex:0 1 auto;[^}]*max-width:calc\(100% - 112px\)/, "title button must size to its text so the pencil follows the title");
assert.ok(editorJs.includes('node("rename-work").onclick = rename'), "title and its pencil must share the rename action");
assert.ok(!editorJs.includes("app.state.prompt.slice") && !fs.readFileSync(path.join(root, "app/services/store.js"), "utf8").includes("snapshot.prompt.slice"), "prompt text must never become an artwork title");
assert.ok(!editorJs.includes('node("generation-strength")') && editorJs.includes('node("overlay-toggle")'), "editor must bind overlay instead of the removed strength slider");
assert.ok(settingsJs.includes('class="toggle-switch" name="overlayGenerate" type="checkbox" role="switch"'), "artwork overlay setting must use the common switch control");
assert.ok(canvasJs.includes("async function snapshotVisible()") && canvasJs.includes("renderComposition(composition, WIDTH, true)") && canvasJs.includes("width: WIDTH, height: WIDTH"), "snapshot must flatten the current visible layer order into a full-canvas image element");
assert.ok(canvasJs.includes("composition.layerOpacity") && canvasJs.includes("if (composition.overlayGenerate)") && canvasJs.includes("if (visibleSnapshot || composition.localMode) await drawCompositionResult"), "composition must place the result below translucent elements only in overlay mode, and keep the result as the local-redraw reference");
assert.ok(html.includes('id="mask-canvas"') && html.includes('id="mask-clear"') && html.includes('id="local-prompt"') && html.includes('id="local-prompt-edit"'), "local mode must own a mask layer, a clear action and its own description entry");
assert.ok(canvasJs.includes("function clearMask()") && canvasJs.includes("function maskStrokes()") && canvasJs.includes("localMode: masking") && canvasJs.includes("objects: masking ? [] : "), "local redraw must clear marks and submit the result without the element layer");
assert.ok(canvasJs.includes("maskContext.drawImage(maskContentCanvas, 0, 0)") && canvasJs.includes('object.tool === "mask" && maskPreview ? "#e5484d"'), "red marks must render on their own layer above the result");
assert.match(editorCss, /\.mask-canvas\{z-index:6;pointer-events:none\}/, "the mask layer must sit above the result layer and stay click-through");
assert.ok(editorJs.includes("function enterMaskMode()") && editorJs.includes("function exitMaskMode()") && !/function exitMaskMode\(\)[\s\S]{0,600}?canvas\.clearMask\(\)/.test(editorJs) && editorJs.includes('node("mask-clear").onclick'), "leaving local mode must hide the red marks but keep them for the next visit; only the broom clears them");
assert.ok(canvasJs.includes("function contentCount()") && canvasJs.includes("if (state.maskMode && state.maskVisible !== false) {\n        maskContext.drawImage(maskContentCanvas, 0, 0)"), "marks must stay off the canvas outside local mode, obey the mask switch, and never count as content");
assert.match(editorCss, /\.draw-options\.is-mask \.stroke-controls,\.draw-options\.is-eraser \.stroke-controls\{grid-template-columns:minmax\(0,1fr\);flex:1 1 50%/, "the area slider must span the full row inside local mode");
assert.match(editorCss, /\.draw-options\.is-mask #brush-size-value,\.draw-options\.is-eraser #brush-size-value\{transform:none;flex:0 0 auto;min-width:12px\}/, "the size value must hug the slider instead of sitting in a fixed 25px box");
assert.match(editorCss, /\.draw-options\.is-mask \.local-prompt-options\{flex:1 1 50%;margin-left:18px\}/, "the clear icon must keep a wider gap before a narrower description field");
assert.ok(imageEngineJs.includes('masking && (requested === "quick" || !requested) ? "inpaint"') && imageEngineJs.includes("canvasInput.composeMask(false)") && !imageEngineJs.includes('slot !== "quality" && canvasInput.hasMask()'), "an active mask must switch quick draw to the local-redraw task and submit the mask");
assert.ok(editorJs.includes("node(\"auto-toggle\").disabled = masking") && editorJs.includes("node(\"overlay-toggle\").disabled = masking") && editorJs.includes('node("background-color").hidden = maskMode'), "local mode must disable auto, overlay and the background control");
assert.ok(editorJs.includes("app.state.localPrompt") && editorJs.includes("hasResultImage()") && editorJs.includes("is-disabled"), "local mode must require a result and keep a separate description");
assert.ok(imageEngineJs.includes('app.utils.composePrompt("", app.state.localPrompt)') && !imageEngineJs.includes("composePrompt(app.state.prompt, masking ?") && imageEngineJs.includes("if (app.state.maskMode || !app.state.autoGenerate"), "a local redraw must submit the local description only, never the artwork-wide prompt, and skip auto generation");
// The prompt leaves exactly as it was written. Translating is the backend's
// job now: it owns the translator and its memory, it translates on submit when
// a text encoder needs English, and it reports what it did through the job's
// translated / prompt / prompt_source. A second mechanism here would be a
// second answer to the same fact, and the two would disagree eventually.
const engineRunBody = imageEngineJs.slice(imageEngineJs.indexOf("async function run("), imageEngineJs.indexOf("running = true; queuedSlot = \"\";"));
assert.ok(engineRunBody.includes("app.state.localPrompt") && engineRunBody.includes("app.state.negativePrompt") && engineRunBody.includes("app.state.prompt") && engineRunBody.includes("RENDER_PROMPT") && !engineRunBody.includes("english(") && !engineRunBody.includes("app.services.translate"), "the engine must hand over the prompt as written and take no part in translating it");
// The whole client-side translation mechanism is retired: the plugin does it on
// submit, so there is nothing here that could fall out of step with the plugin.
assert.ok(!/services\.translate|hasCjk|TRANSLATE_TAB|data-translate-now|translate\.probe/.test(settingsJs + editorJs + imageEngineJs + appJs + providersJs), "no client file may keep the retired translation mechanism");
assert.ok(!html.includes("translate.js") && !fs.existsSync(path.join(root, "app/services/translate.js")), "the retired translation service must be gone, not merely unused");
assert.ok(editorJs.includes("app.state.maskVisible = Number(event.target.value) >= 50") && editorJs.includes("app.state.maskVisible = app.state.maskVisible === false") && editorJs.includes('node("opacity-target-label").textContent = masking ? t("蒙版层显示（0 或 100）"'), "inside local redraw the eye and the slider must drive the mask layer only");
assert.ok(editorJs.includes('node("result-opacity").disabled = masking ? false') && editorJs.includes('visibility.disabled = masking ? false : !hasResult') && !editorJs.includes("成图固定不透明"), "local redraw must keep both controls usable and must never label the slider with the result opacity");
assert.ok(canvasJs.includes("function captureComposition(overrides)") && canvasJs.includes("options.withResult ? { localMode: true } : null") && imageEngineJs.includes("if (masking) referenceOptions.withResult = true"), "a local redraw must reference the decorated result on purpose instead of inheriting the mode flag");
const maskRecipeBody = canvasJs.slice(canvasJs.indexOf("function composeMask"), canvasJs.indexOf("async function exportSource"));
assert.ok(maskRecipeBody.includes('ctx.fillStyle = "black"') && !maskRecipeBody.includes("resultFilter") && !maskRecipeBody.includes("drawResult"), "the mask image must stay plain black and white: color adjustments must never reach it");
assert.ok(storeJs.includes('"resultVisible", "maskVisible"') && canvasJs.includes('"resultVisible", "maskVisible"'), "the mask switch must survive a reload like the other view toggles");
const enterMaskBody = editorJs.slice(editorJs.indexOf("function enterMaskMode"), editorJs.indexOf("function exitMaskMode"));
const exitMaskBody = editorJs.slice(editorJs.indexOf("function exitMaskMode"), editorJs.indexOf("function requestMaskTool"));
assert.ok(enterMaskBody.includes("syncCanvas()") && exitMaskBody.includes("syncCanvas()"), "entering and leaving local redraw must repaint the borrowed result controls instead of waiting for a canvas change");
const canvasExportBlock = (canvasJs.match(/return \{([\s\S]*?)\n  \};/g) || []).pop() || "";
const canvasExports = new Set([...canvasExportBlock.matchAll(/([A-Za-z0-9_]+):/g)].map((match) => match[1]));
const missingCanvasExports = [...new Set([...editorJs.matchAll(/(?:^|[^A-Za-z0-9_.])canvas\.([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1]))].filter((name) => !canvasExports.has(name));
assert.ok(missingCanvasExports.length === 0, "every canvas method the editor calls must be exported by the canvas module: " + missingCanvasExports.join(", "));
assert.ok(html.includes("fa-solid fa-eraser") && html.includes("fa-solid fa-keyboard") && !html.includes("fa-broom") && !/color-control icon-control/.test(html), "clear marks and edit description must be bare icons (eraser and keyboard, no chip)");
assert.ok(editorCss.includes(".icon-control{display:grid;place-items:center;flex:0 0 27px;width:27px;height:27px;margin-left:4px;padding:0;border:0;background:transparent"), "row icons must be plain glyphs without a circle");
assert.ok(/\.local-prompt-button\{[^}]*border:0;background:transparent/.test(editorCss), "the local description must render without a box");
assert.ok(canvasJs.includes('marqueeOnDrag: Boolean(hit && hit.type === "image" && !hitAlreadySelected)') && canvasJs.includes('!selectionGesture.marqueeOnDrag'), "dragging from an unselected image must start a marquee instead of moving the image");
assert.ok(editorJs.includes('image.style.zIndex = overlay ? "1" : "4"') && editorJs.includes('animateActiveOpacity(0.66)'), "display mode must swap result layering and animate opacity to 66%");
assert.ok(editorJs.includes('app.state.layerOpacity = value') && editorJs.includes('app.state.resultOpacity = value'), "top opacity slider must target the active layer");
assert.match(editorJs, /snapshot-canvas[\s\S]*canvas\.snapshotVisible\(\)/);
assert.ok(html.includes('id="hamdraw-sharpen-matrix"'), "clarity must use a real sharpening convolution filter");
assert.ok(html.includes('id="canvas-fullscreen"') && html.includes('id="fullscreen-bottom"'), "fullscreen canvas controls must have fixed top and bottom anchors");
assert.ok(html.includes('id="fullscreen-tools-toggle"'), "fullscreen bottom tools must expose a collapse handle");
assert.ok(html.includes('id="modal-actions"'), "modal shell must provide an action area outside scrolling content");
assert.match(editorCss, /body\.canvas-fullscreen \.canvas-bar\{position:fixed;/);
assert.match(editorCss, /body\.canvas-fullscreen \.fullscreen-bottom\{position:fixed;/);
assert.ok(!html.includes('id="canvas-action-help"') && !html.includes('id="tool-action-help"') && editorJs.includes('document.addEventListener("click"') && editorJs.includes('status(t(button.dataset.helpZh'), "all action help must use the shared status line");
assert.match(editorCss, /body\.canvas-fullscreen\.canvas-interacting \.fullscreen-bottom\{opacity:0;/);
assert.match(editorCss, /body\.canvas-fullscreen\.fullscreen-tools-collapsed \.fullscreen-bottom\{[^}]*background:none;[^}]*pointer-events:none/);
assert.match(editorCss, /body\.canvas-fullscreen \.fullscreen-tools-toggle\{[^}]*top:36px;[^}]*width:48px;height:38px;[^}]*border-radius:9px 9px 0 0;[^}]*backdrop-filter:blur\(16px\)/);
assert.match(editorCss, /body\.canvas-fullscreen \.fullscreen-bottom>\.drawing-dock\{[^}]*background:rgba[^}]*backdrop-filter:blur\(18px\)[^}]*contrast\(1\.24\)/, "fullscreen tools must use a translucent frosted-glass surface");
assert.match(editorCss, /body\.canvas-fullscreen\.fullscreen-tools-collapsed \.fullscreen-bottom>\.drawing-dock[^}]*display:none/);
// Collapsing the bottom tools must clear the top of the screen as well, and it has to be a
// real hide: the base rule sets `display:flex`, so anything short of `display:none` leaves an
// invisible bar that still swallows taps on the canvas behind it.
assert.match(editorCss, /body\.canvas-fullscreen\.fullscreen-tools-collapsed \.canvas-bar\{display:none\}/, "collapsing the bottom tools must take the top canvas bar with it");
assert.ok(!/fullscreen-tools-collapsed[^{]*\.canvas-bar\{[^}]*display:(?!none)/.test(editorCss), "no collapsed-state rule may put the top bar back on screen");
assert.ok(html.includes('data-en="Collapse the bottom tools and the top bar"'), "the collapse handle must say that it clears the top bar too");
assert.match(editorCss, /body\.canvas-fullscreen #canvas-fullscreen\{background:var\(--accent\);color:#fff/);
assert.ok(canvasJs.includes('app.events.emit("canvas:interaction"') && editorJs.includes('app.events.on("canvas:interaction"'), "fullscreen chrome must follow canvas interaction lifecycle");
assert.match(componentsCss, /\.modal-actions\{[^}]*flex:0 0 auto/);
assert.match(componentsCss, /\.work-settings-sheet\{height:88vh\}/);
assert.ok(settingsJs.includes('sheetClass: "work-settings-sheet"') && settingsJs.includes('footerHtml: footer(') && !settingsJs.includes('mode: "center", contentClass: "work-settings-content"'), "artwork settings must use a bottom sheet with external fixed actions");
assert.ok(!settingsJs.includes('range("colorStrength"') && settingsJs.includes('绘制稿保留强度'), "artwork settings must expose one preservation control without a separate color control");
assert.ok(canvasJs.includes('"colorStrength"'), "color strength must be restored with artwork canvas state");
assert.ok(html.includes('id="stroke-opacity"'), "drawing tools must expose direct stroke opacity");
assert.ok(html.includes('id="background-color"') && html.includes('<span aria-hidden="true">BG</span>') && editorCss.includes('.bg-control span{'), "background color control must show a centered BG label");
assert.ok(html.includes('id="status-line"') && (html.match(/data-help-zh=/g) || []).length >= 20 && editorJs.includes('function bindActionHelp()'), "canvas, drawing, and generation actions must explain their effect in the shared status line");
assert.ok(editorJs.includes('app.state.layerOpacity = 0.2') && editorJs.includes('Number(app.state.layerOpacity) < 0.2'), "Canvas interaction must restore a hidden overlay drawing layer to 20% visibility");
assert.ok(editorJs.includes('function animateResultOpacityFloor()') && editorJs.includes('duration = 500') && editorJs.includes('app.state.resultOpacity = from +'), "Fast and rolled-seed results must animate opacity back to 20% when hidden");
assert.match(editorCss, /\.stage-busy\{[^}]*pointer-events:none\}/, "Generation wait layer must pass pointer input through to the canvas");
assert.ok(componentsCss.includes(".render-preview{position:fixed;z-index:1000") && componentsCss.includes(".render-preview{position:fixed!important") && componentsCss.includes("width:100vw!important") && componentsCss.includes(".render-preview-stage{position:absolute!important;inset:0!important") && componentsCss.includes("height:100%!important") && componentsCss.includes(".render-preview-tools .icon-button+.icon-button{margin-left:10px!important}") && componentsCss.includes("background:transparent!important") && componentsCss.includes("backdrop-filter:blur(16px) saturate(1.1) brightness(.58)"), "fullscreen render preview must stay above app chrome with a fixed darkened toolbar");
// This device runs Chrome 83, which predates flex gap: a flex row spaced with `gap`
// silently collapses into touching children, which is exactly how the preview toolbar
// and the main prompt row shipped broken. Spacing in a flex row must be an adjacent
// sibling margin. Grid gap is fine and is left alone.
[["render preview toolbar", componentsCss, /\.render-preview-tools\{[^}]*gap:/], ["render preview prompt bar", componentsCss, /\.render-preview-promptbar\{[^}]*gap:/], ["render preview weight", componentsCss, /\.render-preview-weight\{[^}]*gap:/], ["main prompt row", editorCss, /\.prompt-panel\{[^}]*gap:/]].forEach(([label, css, pattern]) => {
  assert.ok(!pattern.test(css), label + " must space its flex children with a margin: this WebView drops flex gap");
});
assert.ok(componentsCss.includes(".render-preview-weight{margin-left:8px;width:calc(34% - 8px)}") && editorCss.includes("height:32px;margin-left:8px}"), "the preview weight box and the main weight control must claim their 8px through a margin");
assert.ok(componentsCss.includes(".render-preview-adjust-actions{grid-column:1/-1;display:flex;align-items:center;justify-content:flex-start;padding-top:4px}") && componentsCss.includes(".render-preview-adjust-actions .button{min-height:34px;padding:6px 15px;font-size:11.5px}"), "the adjustment actions must be left-aligned full-size buttons");
assert.ok(editorCss.includes("contrast(2) brightness(1)!important") && !componentsCss.includes("contrast(2) brightness(1)!important"), "the canvas fullscreen chrome keeps its high-contrast 2.0 glass; the render preview alone dims below 1, so no brightness(1) override may reappear there");
assert.ok(html.includes('class="fullscreen-pan-thumb"') && editorJs.includes("bindFullscreenPanToggle") && editorJs.includes("canvasPanLimit") && editorJs.includes("is-pan-scrollbar"), "Fullscreen toggle must support long-press horizontal canvas panning");
assert.ok(settingsJs.includes('range("colorOpacity"') && settingsJs.includes('object.opacity = opacity') && settingsJs.includes('app.state.opacity = opacity'), "color dialogs must apply opacity to the active stroke tool or selected strokes");
assert.match(componentsCss, /\.color-slider-stack \.field\{margin-bottom:5px\}/, "color sliders must use the compact vertical stack");
assert.ok(!html.includes('id="brush-more"'), "stroke opacity must not be hidden behind a modal button");
assert.ok(html.includes('id="selection-canvas"'), "selection chrome must have its own overlay");
assert.match(editorCss, /\.draft-canvas\{z-index:2;/);
assert.match(editorCss, /\.selection-canvas\{z-index:3;[^}]*pointer-events:none/);
assert.match(editorCss, /\.result-image\{z-index:4;[^}]*pointer-events:none;touch-action:none/);
assert.ok(!html.includes('id="stage-badge"'), "canvas must not show a preview badge");
assert.ok(runtimeJs.includes("function createFrameTask") && runtimeJs.includes("function createLru"), "runtime must provide shared frame scheduling and bounded caches");
assert.ok(drawingJs.includes("function cloneObjects") && drawingJs.includes("function estimateWeight"), "drawing data operations must avoid JSON cloning and support bounded history");
assert.ok(canvasJs.includes("contentCanvas") && canvasJs.includes("scheduleRender") && canvasJs.includes("HISTORY_MAX_WEIGHT"), "canvas must use cached content, frame scheduling, and bounded undo history");
// Generated images join the undo journal, so 120 consecutive generations must be
// 120 steps back. The journal carries the result by reference, is tagged by kind,
// and stays in memory: it is never part of an artwork record.
assert.ok(canvasJs.includes("var HISTORY_MAX_UNDO_STEPS = 120") && canvasJs.includes("var HISTORY_MAX_ENTRIES = HISTORY_MAX_UNDO_STEPS + 1") && canvasJs.includes("HISTORY_MAX_RESULT_CHARS"), "the undo journal must allow 120 steps, one entry per step plus the current state, with a bound on the images it holds");
assert.ok(canvasJs.includes("_resultChars: result && result.src") && canvasJs.includes('app.events.emit("result:changed")'), "a journal entry must carry the generated result, so one undo steps the result back to the previous image");
assert.ok(canvasJs.includes('function commitResult() { commitEntry("result"); }') && canvasJs.includes("next._kind = kind") && canvasJs.includes('{ schedule: undone._kind !== "result" }'), "a finished generation must be a journal step of its own, and undoing it must not immediately regenerate over the recovered image");
assert.ok(canvasJs.includes("state.result = data.result ? { src: data.result.src") && canvasJs.includes("logicalFileId: data.result.logicalFileId") && !/state\.result = data\.result \|\| null/.test(canvasJs), "stepping a result back must rebuild it without the stored file reference that the save-time cleanup reclaimed while it was history");
// Stepping the journal emits the change; something has to repaint the stage. With no
// listener the state is right and the screen is stale, which is exactly how a working
// undo looks broken, so the pairing is asserted rather than assumed.
assert.ok(canvasJs.includes('app.events.emit("result:changed")') && editorJs.includes('app.events.on("result:changed"'), "the result-changed notification must have a listener, or stepping the result back would leave the stage on the newer image");
assert.ok(editorJs.slice(editorJs.indexOf('app.events.on("result:changed"')).slice(0, 400).includes("syncCanvas()"), "the result-changed listener must repaint the stage");
const generationDoneBody = editorJs.slice(editorJs.indexOf('app.events.on("generation:done"'), editorJs.indexOf('app.events.on("generation:progress"'));
assert.ok(generationDoneBody.includes("canvas.commitResult()") && generationDoneBody.indexOf("canvas.commitResult()") > generationDoneBody.indexOf('result.slot === "upscale"'), "only a Fast or local-redraw result may join the undo journal; a render must stay out of it");
assert.ok(storeJs.includes("snapshot.render = storedImage(app.state.renderResult)") && storeJs.includes("if (copy.render && copy.render.asset)") && storeJs.includes("render: snapshot && snapshot.render") && storeJs.includes("render.asset = await app.services.assets.persist(render.src, null)"), "the last render must be saved with the artwork and read back from its files on load");
assert.ok(canvasJs.includes("state.renderResult = saved.render || null"), "loading an artwork must put its last render back into the state, or the saved render is unreachable");
assert.ok(assetsJs.includes("snapshot && snapshot.render ? [snapshot.render] : []"), "the asset cleanup must keep the files of the artwork's last render");
assert.ok(!/history/.test(storeJs), "the undo journal must stay in memory and never enter an artwork record");
// Layering a group. The old mutator opened with `selectionIds().length !== 1`, so a group
// (whose members all arrive selected at once) could not be layered at all, and the same
// single-object test armed the two arrows. Both halves have to move together or the arrow
// is live while the mutator ignores it, which looks exactly like a broken button.
const layerBody = canvasJs.slice(canvasJs.indexOf("function canMoveLayer"), canvasJs.indexOf("function scaleSelected"));
assert.ok(!layerBody.includes("length !== 1") && !layerBody.includes("selectionIds().length !=="), "layering must not require a single-object selection");
assert.ok(layerBody.includes("ids.has(state.objects[index + 1].id)") && layerBody.includes("ids.has(state.objects[index - 1].id)"), "each selected object must test the neighbour it is about to pass, which is what keeps a group from being split apart");
assert.ok(canvasJs.includes("canMoveLayer: canMoveLayer") && editorJs.includes('node("layer-down").disabled = !canvas.canMoveLayer(-1)') && editorJs.includes('node("layer-up").disabled = !canvas.canMoveLayer(1)'), "the arrows must be armed by the canvas's own predicate rather than by a second copy of the rule");
assert.ok(!editorJs.includes("canLayerDown") && !/ids\.length !== 1 \|\| selected/.test(editorJs), "the duplicated single-object arming rule must be gone from the editor");
assert.ok(!html.includes("把单个所选对象"), "the layer arrows must not keep promising that only a single object moves");
// Gallery thumbnails must reach the edges of the card. A card is wider than it is tall while
// the thumbnail is a square 288px bitmap, so containing the canvas left a pale band down both
// sides of every card — and the rendered image was contained inside that square as well,
// which put the same band one level further in. Both levels have to cover, or either one of
// them brings the bars back.
assert.match(componentsCss, /\.art-preview canvas\{[^}]*width:100%;height:100%;object-fit:cover/, "the gallery thumbnail must cover its card rather than leave side bands");
assert.ok(!/\.art-preview canvas\{[^}]*object-fit:contain/.test(componentsCss), "no rule may contain the gallery thumbnail again");
const coveredBody = canvasJs.slice(canvasJs.indexOf("function drawCovered"), canvasJs.indexOf("function drawImageObject"));
assert.match(coveredBody, /Math\.max\(/, "filling a frame means scaling by the larger of the two ratios");
assert.ok(!coveredBody.includes("Math.min("), "drawCovered must not quietly behave like drawContained");
const thumbnailBody = canvasJs.slice(canvasJs.indexOf("async function thumbnail"), canvasJs.indexOf("app.components.canvas = {"));
assert.ok(thumbnailBody.includes("drawCovered(ctx, result, size, size)") && !thumbnailBody.includes("drawContained(ctx, result"), "the thumbnail bitmap must fill its own square too, or a non-square render comes back as a band inside the card");
// The history card is drawn from the artwork's cover: the last generated picture, held as
// a reference into Haminn's file store. Reaching that needs four things at once, and
// dropping any one of them silently loses the card's image — the picture is filed when it
// arrives rather than at the next autosave, the record stores the reference, the thumbnail
// reads it first, and cleanup counts it among the artwork's references.
assert.ok(imageEngineJs.includes("await app.services.assets.coverFrom(generated)") && imageEngineJs.includes("app.state.cover = "), "a finished generation must be filed into Haminn's file store at once and become the document's cover");
assert.match(imageEngineJs, /else app\.state\.result = generated;[\s\S]*?coverFrom\(generated\)/, "the cover must be built from the very object the stage shows, so the card and the canvas can never disagree about which picture was generated last");
assert.match(storeJs, /snapshot\.cover = storedImage\(app\.state\.cover\)/, "the cover must be kept in the record as a reference, exactly like the result, never as bytes");
assert.ok(storeJs.includes("cover: snapshot && snapshot.cover ?"), "the cover must join the persisted-snapshot model too, or the saved cover keeps looking like a change that was never written");
assert.ok(storeJs.includes("copy.cover.src = await app.services.assets.resolve(copy.cover.asset)"), "restoring an artwork must resolve the cover's file reference");
const referencesBody = assetsJs.slice(assetsJs.indexOf("function references("), assetsJs.indexOf("async function cleanup("));
assert.ok(referencesBody.includes("snapshot.cover"), "cleanup must treat the cover as a reference, or the card's chunks are reclaimed the first time anything else about the artwork changes");
assert.ok(canvasJs.includes("state.cover = saved.cover || null"), "loading an artwork must bring its cover back, including one whose result was cleared");
assert.match(thumbnailBody, /if \(saved\.cover && saved\.cover\.asset\) \{[\s\S]*?if \(saved\.result && saved\.result\.asset\)/, "the card must try the cover before the result, for a cover is the newer picture by definition");
// The history list has to stay usable with a few hundred works, and on this host that is a
// limit problem twice over. Cards must arrive a page at a time, and covers must be fetched
// one at a time: firing the visible cards together made the device answer `Too many
// concurrent Haminn requests`, and `loadPreview` recorded that as a permanent error, so the
// affected cards stayed blank for good. Each half of the fix is asserted on its own, because
// losing either one brings the same blank cards back.
assert.ok(galleryJs.includes("list.slice(shown, shown + PAGE_SIZE)") && galleryJs.includes("PAGE_SIZE = 12"), "the gallery must build its grid a page at a time, not one innerHTML for every work");
assert.ok(!galleryJs.includes("grid.innerHTML = list.map") && galleryJs.includes("gallery-sentinel"), "the whole grid must never be rendered in one pass; the sentinel is what asks for the next page");
assert.match(componentsCss, /\.gallery-sentinel\{[^}]*height:1px/, "the sentinel must be a laid-out element the observer can watch");
const observerBody = galleryJs.slice(galleryJs.indexOf("function createPreviewObserver"), galleryJs.indexOf("function offScreen"));
assert.ok(observerBody.includes("enqueuePreview(") && !observerBody.includes("loadPreview("), "a card coming into view must join the queue rather than start a load of its own");
assert.ok(observerBody.includes('rootMargin: "180px 0px"'), "a cover may only be fetched once its card is near the viewport");
assert.equal(galleryJs.split("await loadPreview(").length, 2, "covers must be drawn from the single queue; a second caller would put the burst back");
assert.ok(!galleryJs.includes("worker(); worker();"), "the two-worker preview pool must stay gone");
assert.ok(galleryJs.includes("if (observer) observer.observe(card); else enqueuePreview(grid, item, token);"), "with no IntersectionObserver the fallback still has to reach the queue rather than draw on the spot");
assert.match(galleryJs, /for \(var attempt = 0; attempt < PREVIEW_ATTEMPTS/, "a failed cover must be retried, or a transient host collision leaves the card blank forever");
assert.ok(galleryJs.includes("MAX_LIVE_PREVIEWS") && galleryJs.includes("drawnPreviews.length > MAX_LIVE_PREVIEWS") && galleryJs.includes("target.width = 0"), "drawn covers must be given back past the cap, or a long list holds one bitmap per work");
assert.ok(galleryJs.includes("function offScreen(card)") && galleryJs.includes("drawnPreviews.filter(offScreen)[0]"), "only a cover that has scrolled away may be released, or the list redraws what the user is looking at");
assert.ok(html.includes("成图最多可回退 120 张") && html.includes("Up to 120 results can be stepped back"), "the undo help must state how far the generated-image journal reaches");
const references = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)].map(match => match[1]);
for (const reference of references) {
  if (reference.startsWith("/__haminn/") || reference.startsWith("data:")) continue;
  assert.ok(!/^https?:/i.test(reference), `runtime remote dependency: ${reference}`);
  assert.ok(fs.existsSync(path.join(root, reference.replace(/^\.\//, ""))), `missing reference: ${reference}`);
}

const scriptOrder = references.filter(value => value.endsWith(".js"));
assert.equal(scriptOrder[0], "./app/core/namespace.js");
assert.ok(scriptOrder.indexOf("./app/core/runtime.js") < scriptOrder.indexOf("./app/services/assets.js"));
assert.ok(scriptOrder.indexOf("./app/core/drawing.js") < scriptOrder.indexOf("./app/components/canvas.js"));
assert.equal(scriptOrder.at(-1), "./app/app.js");

const sourceFiles = [];
function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(?:js|html|css)$/.test(entry.name)) sourceFiles.push(full);
  }
}
walk(path.join(root, "app"));
walk(path.join(root, "styles"));
sourceFiles.push(path.join(root, "index.html"));

for (const file of sourceFiles) {
  const source = fs.readFileSync(file, "utf8");
  assert.ok(!/\b(?:import|export)\s+(?:\{|default|from)/.test(source), `ES module syntax in ${file}`);
  assert.ok(!/\?\.|\?\?|&&=|\|\|=/.test(source), `unsupported modern syntax in ${file}`);
  assert.ok(!/https?:\/\/(?:cdn|unpkg|jsdelivr)/i.test(source), `CDN dependency in ${file}`);
  if (file.endsWith(".js")) childProcess.execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

childProcess.execFileSync(process.execPath, [path.join(root, "tests/providers.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/workspace.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/performance.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/assets.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/layer.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/rotation.test.mjs")], { stdio: "inherit" });
childProcess.execFileSync(process.execPath, [path.join(root, "tests/cover.test.mjs")], { stdio: "inherit" });
if (!process.argv.includes("--source-only") && fs.existsSync(path.join(root, "haminn-install.json"))) {
  childProcess.execFileSync("python3", [path.join(root, "tools/package.py"), "--check"], { stdio: "inherit" });
}
console.log(`verify.mjs: ok (${sourceFiles.length} runtime files)`);
