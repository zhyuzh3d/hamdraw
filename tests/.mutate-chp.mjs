// Mutate providers.js's chp/2 client and require providers.test.mjs to catch each
// change *by name*.
//
// A mutation that leaves the suite green means the assertion that names the rule is
// not actually guarding it — so that counts as a failure of this script, not a pass.
// Requiring the failing assertion's own words (and not merely "something went red") is
// what keeps a rule that a whole test file happens to break from being mistaken for
// the one that was caught. Run it after touching the CHP client:
//   node tests/.mutate-chp.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "app/services/providers.js");
const original = fs.readFileSync(target, "utf8");

const mutations = [
  // The plan's own criterion: the app must read the frame's *label*. A ratio in this
  // contract is a name its author chose, so searching for two equal numbers is
  // computing the label instead of reading it.
  ["the square frame is found by comparing its numbers",
    '      if (String(frames[index].ratio || "") !== "1:1") continue;\n      var pair = chpPair((frames[index].resolution || [])[0]);\n      if (pair[0] > 0 && pair[1] > 0) return pair;',
    '      var pair = chpPair((frames[index].resolution || [])[0]);\n      if (pair[0] > 0 && pair[0] === pair[1]) return pair;',
    "the frame labelled 1:1 is the app's canvas"],
  // Back to taking whatever the list happens to put first.
  ["the canvas comes from the front of the list",
    "var canvas = chpSquare(category), strength = chpDefault(category, \"ref_strength\");",
    "var canvas = chpSizes(category)[0] || null, strength = chpDefault(category, \"ref_strength\");",
    "a 4:3 frame listed first must not become the app's canvas"],
  // Back to the last resolution of the frame instead of the first.
  ["the last resolution of the square frame is taken",
    "var pair = chpPair((frames[index].resolution || [])[0]);",
    "var pair = chpPair((frames[index].resolution || [])[0]);\n      pair = chpPair((frames[index].resolution || []).slice(-1)[0]);",
    "the square frame's first resolution is the one taken"],
  // Back to the v1 fallback: no square published means take what the plugin offers.
  ["a category with no 1:1 frame falls back to its first frame",
    "      if (pair[0] > 0 && pair[1] > 0) return pair;\n    }\n    return null;",
    "      if (pair[0] > 0 && pair[1] > 0) return pair;\n    }\n    return chpSizes(name)[0] || null;",
    "a category with no 1:1 frame locks no canvas"],
  // Back to letting a stored `capability` / `task` name the category.
  ["a stored capability field wins over the slot",
    'return CHP_CATEGORY[(config && config.slot) || ""] || "fast";',
    'return CHP_CATEGORY[(config && (config.capability || config.task || config.slot)) || ""] || "fast";',
    "the retired task/capability fields must not win over the slot"],
  // Back to a category alias. These two are the words chp/1 published as aliases, and
  // honouring one is how a client submits a category the server refuses while reading
  // another entry's frames on the way there.
  ["the old `qwen` alias is honoured again",
    'var wanted = String(name == null ? "" : name).toLowerCase(), list = (chpInfo && chpInfo.rules) || [];',
    'var wanted = String(name == null ? "" : name).toLowerCase(); if (wanted === "qwen") wanted = "render";\n    var list = (chpInfo && chpInfo.rules) || [];',
    "a category must not be found through an alias"],
  ["the old slot name is honoured as a category",
    'var wanted = String(name == null ? "" : name).toLowerCase(), list = (chpInfo && chpInfo.rules) || [];',
    'var wanted = String(name == null ? "" : name).toLowerCase(); if (wanted === "quick") wanted = "fast";\n    var list = (chpInfo && chpInfo.rules) || [];',
    "`quick` is a slot, not a category"],
  // Back to assembling the job path by hand instead of reading `endpoints`.
  ["the job address is assembled instead of read",
    'var published = chpInfo && chpInfo.endpoints ? chpInfo.endpoints[name] : "";',
    'var published = "";',
    "/chp/api/jobs"],
  // Back to carrying the password in a header on a request that already has a body.
  ["the password is also sent as a header",
    'var requestHeaders = chpHeaders(config, "application/json");',
    'var requestHeaders = headers(config, "application/json");',
    "must not also carry it in a header"],
  // Back to the resolution as an array.
  ["the resolution travels as a pair of numbers",
    'resolution: canvas[0] + "x" + canvas[1],',
    "resolution: canvas,",
    "the resolution travels as the string the plugin published"],
  // Back to dropping the model-layer extensions on the floor.
  ["the model-layer extensions are not carried",
    "var ext = { step: Number(config.steps) || 8 };",
    "var ext = {};",
    "the step count and the negative prompt are model-layer extensions"],
  // Back to an empty password being spelled out, which the plugin would compare.
  ["an empty password is carried anyway",
    "if (config.apiKey) body.chp_params = { password: config.apiKey };",
    'body.chp_params = { password: config.apiKey || "" };',
    "an empty password is nothing to carry"],
  // Back to judging readiness off the category instead of the ability that answers it.
  ["readiness is ignored, so an unstalled model passes the test",
    "if (!ability.ready) throw new Error(t(",
    "if (false) throw new Error(t(",
    "Missing expected rejection"],
];

const escaped = [];
try {
  for (const [name, find, replace, expect] of mutations) {
    if (!original.includes(find)) {
      escaped.push(name + " (anchor not found, cannot mutate)");
      console.log("SKIP  " + name);
      continue;
    }
    fs.writeFileSync(target, original.replace(find, replace));
    let text = "";
    try {
      execFileSync(process.execPath, [path.join(root, "tests/providers.test.mjs")], { stdio: "pipe" });
    } catch (error) {
      text = String(error.stderr || "") + String(error.stdout || "");
    }
    const caught = expect ? text.includes(expect) : Boolean(text);
    const line = text.split("\n").find(row => row.includes("AssertionError") || /^Error: /.test(row.trim())) ||
      text.trim().split("\n").pop() || "";
    console.log((caught ? "CAUGHT" : "ESCAPED") + " " + name + (caught ? "" : "\n      expected to see: " + expect + "\n      got: " + line.trim()));
    if (!caught) escaped.push(name);
  }
} finally {
  fs.writeFileSync(target, original);
  if (fs.readFileSync(target, "utf8") !== original) throw new Error("providers.js was not restored");
}

if (escaped.length) {
  console.log("\nchp client mutation check FAILED: " + escaped.join("; "));
  process.exit(1);
}
console.log("\nchp client mutation check: ok (" + mutations.length + " mutations, every one caught by the assertion it names)");
