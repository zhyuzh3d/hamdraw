import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console, URL, Uint8Array, TextEncoder, setTimeout, clearTimeout, btoa, atob };
context.window = context;
context.addEventListener = () => {};
context.navigator = {};
vm.createContext(context);
function load(name) { vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name }); }
load("app/core/namespace.js"); load("app/core/utils.js");
const app = context.hamdraw;
app.events = { emit: () => {}, on: () => {} };

// The host refuses a bridge message over 256 KiB without a reply or an error,
// which is why a large body has to leave the message entirely: it is filed in
// the host file store and handed over as a logicalFileId instead.
const MAX_CHUNK_BYTES = 64 * 1024;
const requests = [], deleted = [], finished = [];
const chunksByWrite = new Map();
let writeSeq = 0, aborting = false, failChunkAt = 0;
context.haminn = {
  isReady: true,
  network: { request: async params => { requests.push(params); return { status: 200, headers: {}, url: params.url, bodyText: "{\"ok\":true}" }; } },
  files: {
    beginWrite: async ({ name, mime }) => {
      if (aborting) throw new Error("beginWrite refused");
      const writeId = "w" + ++writeSeq;
      chunksByWrite.set(writeId, []);
      return { writeId, maxChunkBytes: MAX_CHUNK_BYTES };
    },
    appendBytes: async ({ writeId, chunkBase64 }) => {
      const chunks = chunksByWrite.get(writeId);
      assert.ok(chunks, "a chunk must land in a write that is still open");
      const bytes = Buffer.from(chunkBase64, "base64");
      assert.ok(bytes.length <= MAX_CHUNK_BYTES, "a chunk must respect the host's 64 KiB block limit: " + bytes.length);
      // Each chunk is a bridge message of its own, and a message over 256 KiB is
      // dropped in silence — so the base64 of a chunk is a hard ceiling too.
      assert.ok(chunkBase64.length <= 256 * 1024, "a chunk must still fit one bridge message as base64: " + chunkBase64.length);
      if (failChunkAt && chunks.length + 1 === failChunkAt) throw new Error("chunk refused");
      chunks.push(bytes);
      return { writeId, receivedBytes: chunks.reduce((sum, part) => sum + part.length, 0), maxChunkBytes: MAX_CHUNK_BYTES };
    },
    finishWrite: async ({ writeId }) => {
      const chunks = chunksByWrite.get(writeId);
      finished.push({ writeId, text: Buffer.concat(chunks).toString("utf8") });
      chunksByWrite.delete(writeId);
      return { logicalFileId: "file-" + writeId, name: "hamdraw-request.json", mime: "application/json", size: chunks.reduce((sum, part) => sum + part.length, 0) };
    },
    abortWrite: async ({ writeId }) => { chunksByWrite.delete(writeId); return { writeId, aborted: true }; },
    delete: async ({ logicalFileId }) => { deleted.push(logicalFileId); return { deleted: true }; }
  }
};
load("app/platform/haminn.js");
const platform = app.platform.haminn;
const url = "http://192.168.124.31:8189/chp/generate";

// A body that still fits one bridge message is inlined exactly as before: the
// file round trip would only add latency to every ordinary request.
const small = JSON.stringify({ prompt: "a fox" });
await platform.request({ url, method: "POST", bodyText: small });
assert.equal(requests.at(-1).bodyText, small, "a small body must still be sent inline");
assert.equal(requests.at(-1).bodyLogicalFileId, undefined, "a small body must not be filed");
assert.equal(finished.length + deleted.length, 0, "a small body must not touch the file store");

// This is the size that used to fail: a feathered mask over a large sweep is a
// gradient, does not compress like a flat mask, and pushed the message past
// 256 KiB — 295 KB, in the report that started this.
const big = JSON.stringify({ imageDataUrl: "data:image/jpeg;base64," + "A".repeat(180000), maskDataUrl: "data:image/png;base64," + "B".repeat(120000), prompt: "局部重绘 a golden crown 🖌" });
assert.ok(Buffer.byteLength(big, "utf8") > 256 * 1024, "the fixture must be a body no single bridge message could carry: " + Buffer.byteLength(big, "utf8"));
await platform.request({ url, method: "POST", bodyText: big });
const filed = requests.at(-1);
assert.equal(filed.bodyText, undefined, "a large body must not be inlined alongside its own file reference");
assert.equal(filed.bodyLogicalFileId, "file-w1", "a large body must travel as a logical file id instead");
assert.equal(filed.contentType, "application/json", "the filed body must keep the content type it was sent with");

// The end-to-end check: what the host reads out of its file store has to be the
// body byte for byte, emoji and Chinese included — a chunk boundary that split a
// multi-byte character would corrupt the prompt rather than fail loudly.
assert.equal(finished.at(-1).text, big, "the filed body must reach the host unchanged, including multi-byte text");
assert.ok(finished.at(-1).text.includes("🖌"), "the filed body must survive chunking with a surrogate pair intact");
assert.equal(deleted.at(-1), "file-w1", "the filed body must be deleted once the request has been sent");

// A file round trip that never starts must not send the request at all.
aborting = true;
const beforeFailure = { deleted: deleted.length, requests: requests.length, finished: finished.length };
await assert.rejects(() => platform.request({ url, method: "POST", bodyText: big }), /beginWrite refused/);
aborting = false;
assert.equal(finished.length, beforeFailure.finished, "a failed file round trip must not finish a file that was never written");
assert.equal(deleted.length, beforeFailure.deleted, "a failed file round trip must not delete a file that was never created");
assert.equal(requests.length, beforeFailure.requests, "a failed file round trip must not send the request without its body");

// A file round trip that dies halfway must give the bytes back: the write is
// still open at that point, and leaving it open holds one of the host's two
// write handles until it is reaped two minutes later.
failChunkAt = 3;
const beforeHalf = { deleted: deleted.length, requests: requests.length, finished: finished.length };
await assert.rejects(() => platform.request({ url, method: "POST", bodyText: big }), /chunk refused/);
failChunkAt = 0;
assert.equal(finished.length, beforeHalf.finished, "a half-written file must not be finished and filed");
assert.equal(requests.length, beforeHalf.requests, "a half-written body must not be sent");
assert.equal(deleted.length, beforeHalf.deleted, "a half-written file must not be deleted as if it had been used");
assert.equal(chunksByWrite.size, 0, "a half-written file must be aborted so the host write handle is released");

// The inline path keeps its own guard: a host bridge message is still finite, so
// a body that is inlined rather than filed must not be allowed to grow past it.
await assert.rejects(() => platform.request({ url, method: "POST", bodyBytes: new Uint8Array(300 * 1024) }), /超过了宿主单次请求的上限/);

console.log("platform.test.mjs: ok (a " + Math.round(Buffer.byteLength(big, "utf8") / 1024) + " KB body is filed as a logical file and read back byte for byte)");
