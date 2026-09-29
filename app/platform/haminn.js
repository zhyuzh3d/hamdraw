(function (app) {
  "use strict";

  var ready = false;
  var waiters = [];

  // The page-to-host transport drops any single message larger than 256 KiB
  // without a reply or an error, which leaves the caller waiting for its own
  // timeout. Every inline request body therefore stays well below that.
  var MESSAGE_CHARS = 200000;
  // A body bigger than this is not lowered to fit — it is filed instead. The
  // host reads a request body straight out of its file store when the request
  // carries a logicalFileId, so the bytes never travel inside the bridge
  // message at all. The threshold is far below MESSAGE_CHARS so the envelope
  // around an inline body can never push the message over the transport limit.
  var BODY_FILE_THRESHOLD = 120000;

  function current() { return window.haminn && window.haminn.isReady ? window.haminn : null; }
  function markReady() {
    if (!current()) return;
    ready = true;
    waiters.splice(0).forEach(function (resolve) { resolve(true); });
    app.events.emit("platform:ready", true);
  }
  window.addEventListener("haminnready", markReady);
  if (current()) markReady();

  function awaitReady(timeoutMs) {
    if (ready || current()) { markReady(); return Promise.resolve(true); }
    return new Promise(function (resolve) {
      var done = false;
      function finish(value) { if (done) return; done = true; resolve(value); }
      waiters.push(finish);
      setTimeout(function () {
        waiters = waiters.filter(function (item) { return item !== finish; });
        finish(Boolean(current()));
      }, typeof timeoutMs === "number" ? timeoutMs : 1200);
    });
  }

  function localized(zh, en) { return app.i18n && app.i18n.text ? app.i18n.text(zh, en) : zh; }

  function checkBudget(options) {
    var size = typeof options.bodyText === "string" ? options.bodyText.length
      : options.bodyBytes ? Math.ceil(options.bodyBytes.length / 3) * 4 : 0;
    if (size <= MESSAGE_CHARS) return;
    var kb = Math.round(size / 1024);
    throw new Error(localized("这次要发送的数据有 " + kb + " KB，超过了宿主单次请求的上限。请减少画布上的图片元素，或改用更小的画幅后重试",
      "This request carries " + kb + " KB, above what the host accepts in one message. Remove image elements from the canvas or use a smaller size and retry."));
  }

  // Chunk sizes are quoted in bytes of file content, but each chunk crosses the
  // bridge inside its own message as base64, which is a third longer again.
  function chunkBytes(maxChunkBytes) {
    return Math.max(8192, Math.floor((Number(maxChunkBytes) || 65536) * 3 / 4) - 4096);
  }
  async function writeBodyFile(bridge, text, contentType) {
    var handle = await bridge.files.beginWrite({ name: "hamdraw-request.json", mime: contentType || "application/json" });
    var limit = chunkBytes(handle.maxChunkBytes), chunks;
    try {
      chunks = app.utils.utf8Chunks(text, limit);
      for (var index = 0; index < chunks.length; index += 1) {
        await bridge.files.appendBytes({ writeId: handle.writeId, chunkBase64: app.utils.bytesToBase64(app.utils.utf8Bytes(chunks[index])) });
      }
      var file = await bridge.files.finishWrite({ writeId: handle.writeId });
      return file.logicalFileId;
    } catch (error) {
      await bridge.files.abortWrite({ writeId: handle.writeId }).catch(function () {});
      throw error;
    }
  }

  async function request(options) {
    app.utils.validateEndpoint(options.url);
    var headers = options.headers || {};
    if (current() || await awaitReady(800)) {
      var bridge = current(), fileId = "", params = {
        url: options.url,
        method: String(options.method || "GET").toUpperCase(),
        headers: headers,
        timeoutMs: options.timeoutMs || 60000
      };
      if (options.bodyBytes) {
        checkBudget(options);
        params.bodyBase64 = app.utils.bytesToBase64(options.bodyBytes);
        params.contentType = options.contentType || "application/octet-stream";
      } else if (typeof options.bodyText === "string") {
        params.contentType = options.contentType || "application/json";
        // A large body is filed rather than shrunk: the host streams it out of
        // its file store, so neither the mask nor the reference picture has to
        // be degraded to fit a single bridge message.
        if (options.bodyText.length > BODY_FILE_THRESHOLD && bridge.files && bridge.files.beginWrite) {
          fileId = await writeBodyFile(bridge, options.bodyText, params.contentType);
          params.bodyLogicalFileId = fileId;
        } else {
          checkBudget(options);
          params.bodyText = options.bodyText;
        }
      }
      try {
        return await bridge.network.request(params);
      } finally {
        if (fileId) await bridge.files.delete({ logicalFileId: fileId }).catch(function () {});
      }
    }
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, options.timeoutMs || 60000) : null;
    try {
      var response = await fetch(options.url, {
        method: String(options.method || "GET").toUpperCase(),
        headers: headers,
        body: options.bodyBytes || options.bodyText,
        signal: controller ? controller.signal : undefined
      });
      var responseHeaders = {};
      response.headers.forEach(function (value, name) { responseHeaders[name] = value; });
      var type = response.headers.get("content-type") || "application/octet-stream";
      if (/json|text|xml/i.test(type)) return { status: response.status, headers: responseHeaders, url: response.url, bodyText: await response.text() };
      return { status: response.status, headers: responseHeaders, url: response.url, bodyBase64: app.utils.bytesToBase64(new Uint8Array(await response.arrayBuffer())) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function requestJson(options) {
    var response = await request(options), payload = app.utils.parseJson(response.bodyText || "", null);
    if (response.status < 200 || response.status >= 300) throw httpError(response, payload, options.headers);
    if (!payload) throw new Error("服务返回的不是有效 JSON");
    return { response: response, data: payload };
  }
  function httpError(response, payload, headers) {
    var detail = payload && (payload.error || payload.detail || payload.message) || response.bodyText || "服务未返回可读错误";
    if (detail && typeof detail === "object") detail = detail.message || detail.code || JSON.stringify(detail);
    Object.keys(headers || {}).forEach(function (name) {
      if (!/authorization|key|token|secret/i.test(name)) return;
      var secret = String(headers[name] || "").replace(/^Bearer\s+/i, "");
      if (secret.length > 3) detail = String(detail).split(secret).join("***");
    });
    var category = response.status === 401 ? "认证失败" : response.status === 403 ? "权限不足" : response.status === 429 ? "额度或频率限制" : response.status >= 500 ? "服务端错误" : "请求失败";
    var error = new Error(category + "（" + response.status + "）：" + String(detail).slice(0, 300));
    error.status = response.status;
    return error;
  }

  async function getData(collection, key) {
    if (current() || await awaitReady(800)) return current().data.get({ collection: collection, key: key });
    var stored = localStorage.getItem("hamdraw:" + collection + ":" + key);
    return stored ? { collection: collection, key: key, value: app.utils.parseJson(stored, null), revision: "browser" } : null;
  }
  async function putData(collection, key, value, expectedRevision) {
    if (current() || await awaitReady(800)) {
      var params = { collection: collection, key: key, value: value };
      if (expectedRevision) params.expectedRevision = expectedRevision;
      return current().data.put(params);
    }
    localStorage.setItem("hamdraw:" + collection + ":" + key, JSON.stringify(value));
    return { collection: collection, key: key, value: value, revision: "browser" };
  }
  async function pickImage() {
    if (current() || await awaitReady(500)) return current().files.pickImage({ maxDimension: 2048, maxBytes: 12 * 1024 * 1024 });
    return null;
  }
  async function deleteData(collection, key) {
    if (current() || await awaitReady(800)) return current().data.delete({ collection: collection, key: key });
    localStorage.removeItem("hamdraw:" + collection + ":" + key);
    return { deleted: true };
  }
  async function clipboardRead() {
    if (current() || await awaitReady(500)) {
      var result = await current().clipboard.read();
      return String(result && result.text || "");
    }
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.readText();
    throw new Error("当前环境不能读取剪贴板，请长按输入框粘贴");
  }
  async function reportTheme() {
    if (!(current() || await awaitReady(500))) return;
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    await current().appearance.reportTheme({ theme: dark ? "dark" : "light" }).catch(function () {});
  }
  async function appReady() {
    if (current() || await awaitReady(1000)) await current().app.ready().catch(function () {});
  }

  app.platform.haminn = {
    messageChars: MESSAGE_CHARS,
    current: current,
    available: function () { return Boolean(current()); },
    awaitReady: awaitReady,
    request: request,
    requestJson: requestJson,
    httpError: httpError,
    getData: getData,
    putData: putData,
    deleteData: deleteData,
    pickImage: pickImage,
    clipboardRead: clipboardRead,
    reportTheme: reportTheme,
    appReady: appReady
  };
})(window.hamdraw);
