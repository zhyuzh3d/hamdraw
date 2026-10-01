// Mutate canvas-io.js's feather sizing and check mask.test.mjs goes red.
//
// Each row is (what changed, find, replace). A mutation that leaves the suite green
// means the assertions above it are not guarding the rule they name, so that counts
// as a failure of this script, not a pass. Run it after touching the ramp:
//   node tests/.mutate-mask.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = path.join(root, "app/components/canvas-io.js");
const original = fs.readFileSync(target, "utf8");

const mutations = [
  ["the ramp ignores the mark and sits at the ceiling", "0.22 * Math.sqrt(area / Math.PI)", "999"],
  ["the thin-mark guard is dropped", "Math.min(Math.max(drawn, FEATHER_MIN), 0.45 * span, FEATHER_MAX)", "Math.min(Math.max(drawn, FEATHER_MIN), FEATHER_MAX)"],
  ["the ceiling is lifted", "var FEATHER_MAX = 10;", "var FEATHER_MAX = 40;"],
  // `!area` and `maxX < 0` are the same condition twice, so keeping only one of them
  // is an equivalent mutation and no assertion could catch it. The mutation that
  // matters is losing the verdict for an empty mask altogether.
  ["an empty mask falls through to the ramp", "if (!area || maxX < 0) return 0;", ""],
];

const escaped = [];
try {
  for (const [name, find, replace] of mutations) {
    if (!original.includes(find)) {
      escaped.push(name + " (anchor not found, cannot mutate)");
      console.log("SKIP  " + name);
      continue;
    }
    fs.writeFileSync(target, original.replace(find, replace));
    let red = false, why = "";
    try {
      execFileSync(process.execPath, [path.join(root, "tests/mask.test.mjs")], { stdio: "pipe" });
    } catch (error) {
      red = true;
      const text = String(error.stderr || "");
      const line = text.split("\n").find((row) => row.includes("AssertionError"));
      why = line ? line.trim() : text.trim().split("\n").pop();
    }
    console.log((red ? "RED   " : "GREEN ") + " " + name + (why ? "\n      " + why : ""));
    if (!red) escaped.push(name);
  }
} finally {
  fs.writeFileSync(target, original);
  if (fs.readFileSync(target, "utf8") !== original) throw new Error("canvas-io.js was not restored");
}

if (escaped.length) {
  console.log("\nmask mutation check FAILED: " + escaped.join("; "));
  process.exit(1);
}
console.log("\nmask mutation check: ok (" + mutations.length + " mutations, all caught)");
