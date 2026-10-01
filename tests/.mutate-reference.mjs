// Mutate the local-redraw reference rule and check the gate goes red *for that rule*.
//
// Each row is (what changed, file, find, replace, the assertion that must fire). The
// last column is what makes this script honest: `tools/verify.mjs` also ends in a
// package check that is red on this machine while the release archive is deliberately
// not built, so "the gate failed" on its own proves nothing. A row counts as caught
// only when the run fails with the sentence that names the rule.
//   node tests/.mutate-reference.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const canvasIoPath = "app/components/canvas-io.js";
const selfTestPath = "app/features/self-test.js";

const mutations = [
  [
    "the reference stops asking for the ungraded picture",
    canvasIoPath,
    "options.withResult ? { localMode: true, originalResult: true } : null",
    "options.withResult ? { localMode: true } : null",
    "a local redraw must reference the decorated result on purpose"
  ],
  [
    "a snapshot starts asking for the ungraded picture",
    canvasIoPath,
    "  async function snapshotVisible() {\n    var composition = captureComposition();",
    "  async function snapshotVisible() {\n    var composition = captureComposition({ originalResult: true });",
    "a snapshot must still capture the graded picture that is on screen"
  ],
  [
    // The hole this script was written for: the switch is still named in the source
    // and the mapping still reads `original ? false : …`, so every text assertion in
    // verify.mjs stays green while the feature is gone. Only the behavioural reading
    // in tests/reference.test.mjs can see it.
    "the override is read and then thrown away",
    canvasIoPath,
    "var original = Boolean(overrides && overrides.originalResult);",
    "var original = false;",
    "the picture that leaves for a local redraw must be the one the model generated"
  ],
  [
    "the device self-test's reference check is renamed away",
    selfTestPath,
    "checks.localReferenceUngraded",
    "checks.localReferenceIsUngraded",
    "the self-test must read the local-redraw reference against the graded snapshot"
  ]
];

const restore = new Map();
const escaped = [];
const read = file => restore.has(file) ? restore.get(file) : fs.readFileSync(path.join(root, file), "utf8");
for (const [, file] of mutations) if (!restore.has(file)) restore.set(file, fs.readFileSync(path.join(root, file), "utf8"));

try {
  for (const [name, file, find, replace, expected] of mutations) {
    const original = read(file);
    if (!original.includes(find)) {
      escaped.push(name + " (anchor not found, cannot mutate)");
      console.log("SKIP  " + name);
      continue;
    }
    fs.writeFileSync(path.join(root, file), original.replace(find, replace));
    let output = "";
    try {
      execFileSync(process.execPath, [path.join(root, "tools/verify.mjs")], { stdio: "pipe" });
    } catch (error) {
      output = String(error.stdout || "") + String(error.stderr || "");
    }
    const caught = output.includes(expected);
    const actual = (output.split("\n").find(row => row.includes("AssertionError")) || "").trim();
    console.log((caught ? "CAUGHT" : output ? "ESCAPED" : "GREEN ") + " " + name + (actual ? "\n        " + actual : "\n        (no assertion failed)"));
    if (!caught) escaped.push(name + " — expected: " + expected);
    fs.writeFileSync(path.join(root, file), original);
  }
} finally {
  for (const [file, body] of restore) {
    fs.writeFileSync(path.join(root, file), body);
    if (fs.readFileSync(path.join(root, file), "utf8") !== body) throw new Error(file + " was not restored");
  }
}

if (escaped.length) {
  console.log("\nreference mutation check FAILED:\n  " + escaped.join("\n  "));
  process.exit(1);
}
console.log("\nreference mutation check: ok (" + mutations.length + " mutations, all caught by name)");
