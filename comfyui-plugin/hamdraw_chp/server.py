"""The CHP HTTP API — the reference implementation of ComfyUI Haminn Protocol.

Three kinds of endpoint, and nothing else:

    GET  /chp/info                        what this server can do        (public)
    POST /chp/jobs                        submit one job                 (Bearer)
    GET  /chp/jobs/{id}                   state, prompt, outputs         (Bearer)
    GET  /chp/jobs/{id}/progress          state only — the polling call  (Bearer)
    GET  /chp/jobs/{id}/output/{index}    fetch a finished image         (Bearer)
    POST /chp/jobs/{id}/cancel            drop a queued job              (Bearer)
    POST /chp/translate                   pre-translate a prompt         (Bearer)

``/chp/info`` is the one a client calls first, and it answers with the whole
contract — the rules (what shape of input each category takes), the abilities
(which model files can serve them, and which canvases they can make), and
whether the password that arrived was the right one.  It answers even when the
password is wrong on purpose: knowing *what* a server can do should not require
having already configured it, and one call then tells a client both "the address
is right" and "the password is not".  The contract itself is defined in
``plans/chp-spec.md``; the table it is built from lives in
:mod:`hamdraw_chp.capabilities`.

The paths never carry a version.  The protocol version travels in the document
as ``spec``, so a client never has to guess a newer path, and a server may add
categories and fields without breaking one that is already shipped: a client is
required to ignore what it does not know.

Roots
-----
``/chp`` is the only root.  ``/cvp`` — the root this plugin served before it was
renamed — is gone.  A client is required to read its addresses out of the
document's ``endpoints``, so a client that hardcoded a root is precisely the
client this version promises nothing to.  Nothing else is served either: the
``/hamdraw/v1`` projections went the same way when their only consumer moved.

Authentication
--------------
The password set in the ``HamDrawConfig`` node (or the ``HAMDRAW_PASSWORD``
environment variable) protects every job endpoint.  A request that carries a
body sends it in ``chp_params.password``; a ``GET``, and a ``POST`` with no body,
send it as ``Authorization: Bearer <password>`` instead — a password has no
business in a URL or a log line.  The header is still accepted everywhere, and
so are ``Basic`` and ``X-HamDraw-Password``.  A wrong password answers ``401
unauthorized`` and nothing is queued.  Leaving it empty disables the check and
``/chp/info`` says so through ``auth.required``.

Images are uploaded inline as base64 in the job body and are written into
``input/hamdraw/`` before the graph runs, so a built-in graph can reference
them through the ordinary ``LoadImage`` node.

Translation
-----------
A category whose text encoder only reads English declares
``prompt.language: "en"``.  When such a job arrives with a prompt that is not
pure ASCII, the server translates it itself — memory first, backend second, and
the original text if both fail — so a client that knows nothing but how to POST
a job cannot feed a model something it cannot read.  A client may translate
earlier and show the user the result; that is a recommendation, not a rule.
Every answer says which of the two happened through ``prompt`` /
``prompt_source`` / ``translated``.

Extension parameters
--------------------
Two channels, kept apart by *layer* rather than by who fills them in:
``ext_params`` is the model layer (the spec defines no field in it at all — it
is carried and echoed verbatim), ``chp_params`` is the CHP layer (today only
``password``).  This implementation reads two keys of its own out of
``ext_params``, ``step`` and ``negative_prompt``; that is its behaviour, not a
term of the contract, and it is written down in this plugin's README.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import inspect
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import folder_paths
from aiohttp import web

from . import capabilities as capabilities_module
from . import families
from . import settings as settings_module
from . import translate as translate_module
from .version import __version__

API_ROOT = capabilities_module.API_ROOT
INPUT_SUBFOLDER = "hamdraw"
CLIENT_ID = "hamdraw"

MAX_BODY_BYTES = 32 * 1024 * 1024
MAX_TRACKED_JOBS = 256
MAX_PENDING_JOBS = 8

AUTH_HINT = "密码在 ComfyUI 的 CHP 插件配置节点里设置。"

#: 顶层只认这些。其余顶层字段一律忽略，名字进 ``job.ignored`` —— 回执不是可选项：
#: 没有它，「``steps`` / ``negative_prompt`` 搬进 ``ext_params``」对客户端就是静默失效。
RECOGNISED_FIELDS = frozenset({
    "category", "resolution", "prompt", "seed", "ref_strength",
    "image_base64", "mask_base64", "ext_params", "chp_params",
})

ERROR_STATUS = {
    "unauthorized": 401,
    "bad_request": 400,
    "unsupported_category": 400,
    "unsupported_size": 400,
    "unsupported_steps": 400,
    "bad_image": 400,
    "bad_mask": 400,
    "stretched_reference": 400,
    "invalid_workflow": 400,
    "no_model": 409,
    "busy": 429,
    "not_found": 404,
    "internal": 500,
}

ERROR_MESSAGES = {
    "unauthorized": "访问密码不正确，请在 ComfyUI 的 CHP 插件配置节点里核对密码。",
    "bad_request": "请求体不是合法 JSON。",
    "unsupported_category": "不认识这个场景，请从信息接口的 rules 里取 category。",
    "unsupported_size": "该场景没有这个分辨率，请从它的帧表里挑一个。",
    "unsupported_steps": "这个步数不被接受。（step 是本实现自己的扩展参数，取值见插件 README。）",
    "bad_image": "参考图不是合法的 base64 PNG/JPEG。",
    "bad_mask": "局部重绘必须提供蒙版图。",
    "stretched_reference": "参考图的宽高比和这次任务的分辨率不一致：按分辨率缩放会把它压变形，而变形之后从成图上完全看不出来。请按任务分辨率合成参考图再提交。",
    "invalid_workflow": "内置工作流校验失败，可能是模型或节点缺失。",
    "no_model": "没有可用的模型，请先在 CHP 插件配置节点里选好这个场景要用的模型。",
    "busy": "队列已满，请稍后再试。",
    "not_found": "找不到这个任务。",
    "internal": "服务器内部错误。",
}

#: Enough to name the media type of an output without trusting a header.
MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

_JOBS: dict[str, dict[str, Any]] = {}
_JOBS_LOCK = threading.RLock()


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def _prompt_server():
    try:
        from server import PromptServer
    except Exception:
        return None
    return getattr(PromptServer, "instance", None)


def _json(payload: Any, status: int = 200) -> web.Response:
    return web.json_response(payload, status=status, dumps=lambda value: json.dumps(value, ensure_ascii=False))


def _fail(code: str, message: str = "", *, status: int | None = None, detail: Any = None) -> web.Response:
    payload: dict[str, Any] = {"error": code, "message": message or ERROR_MESSAGES.get(code, code)}
    if detail is not None:
        payload["detail"] = detail
    return _json(payload, status or ERROR_STATUS.get(code, 400))


def _password() -> str:
    try:
        return settings_module.password()
    except Exception:
        return ""


def _token_of(request: web.Request) -> str:
    header = str(request.headers.get("Authorization") or "").strip()
    lowered = header.lower()
    if lowered.startswith("bearer "):
        return header[7:].strip()
    if lowered.startswith("basic "):
        try:
            decoded = base64.b64decode(header[6:].strip()).decode("utf-8", "replace")
            return decoded.split(":", 1)[-1].strip()
        except (binascii.Error, ValueError):
            return ""
    return str(request.headers.get("X-HamDraw-Password") or "").strip()


def _body_token(body: Any) -> str:
    """``chp_params.password`` — the carrier a request that has a body uses."""
    if not isinstance(body, dict):
        return ""
    params = body.get("chp_params")
    if not isinstance(params, dict):
        return ""
    return str(params.get("password") or "").strip()


def _authorized(request: web.Request, body: Any = None) -> bool:
    """The header first, then the body's ``chp_params.password``.

    Both carriers are accepted — the header is what a ``GET`` and a ``POST``
    without a body *must* use, and what every client used before this version —
    but the contract asks a client to send one, not both, so that "which one was
    meant" never becomes a question.
    """
    expected = _password()
    if not expected:
        return True
    if hmac.compare_digest(_token_of(request), expected):
        return True
    token = _body_token(body)
    return bool(token) and hmac.compare_digest(token, expected)


# --------------------------------------------------------------------------- #
# models
# --------------------------------------------------------------------------- #

def _available_files(folder: str) -> list[str]:
    try:
        return [str(item) for item in folder_paths.get_filename_list(folder)]
    except Exception:
        return []


def _checkpoint(category: str) -> str:
    try:
        return settings_module.checkpoint(category)
    except Exception:
        return ""


def _model_files(category: str) -> dict[str, str]:
    try:
        return settings_module.model_files(category)
    except Exception:
        return {}


def _absent(folder: str, name: str) -> bool:
    """Is this file missing, from a folder whose listing we could actually read?

    An unreadable listing (ComfyUI still starting) means "cannot judge", not
    "missing": the first is a reason to let a job through, the second a reason
    to refuse it, and confusing them refuses work that would have run.
    """
    available = _available_files(folder)
    return bool(name) and bool(available) and name not in available


def _abilities_of(category: str) -> dict[str, Any]:
    """One category's model files, and whether they are installed.

    The shape the discovery document needs: never raises, because a document has
    to answer even when nothing is configured, and "not ready" *is* an answer.
    The same judgement :func:`_resolve_models` makes before queueing, so a
    client that configures itself from this document can never be surprised by
    ``no_model`` at submit time.
    """
    entry = capabilities_module.CATEGORY_TABLE[str(category)]
    roles = [str(role) for role in entry.get("roles") or []]
    files: dict[str, str] = {}
    missing: list[str] = []
    if "checkpoint" in roles:
        name = _checkpoint(str(category))
        files["checkpoint"] = name
        if not name or _absent("checkpoints", name):
            missing.append("checkpoint")
        return {"files": files, "ready": not missing, "missing": missing}
    stored = _model_files(str(category))
    for role in roles:
        name = str(stored.get(role) or "").strip()
        files[role] = name
        if not name or _absent(capabilities_module.ROLE_FOLDERS.get(role, ""), name):
            missing.append(role)
    return {"files": files, "ready": not missing, "missing": missing}


# --------------------------------------------------------------------------- #
# request body
# --------------------------------------------------------------------------- #

def _body_size(bytes_count: int) -> None:
    if bytes_count > MAX_BODY_BYTES:
        raise ValueError("bad_request")


def _decode_image(payload: Any, code: str) -> bytes:
    text = str(payload or "").strip()
    if not text:
        raise ValueError(code)
    if text[:5].lower() == "data:" and "," in text[:96]:
        text = text.split(",", 1)[1]
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError(code) from None
    if not raw:
        raise ValueError(code)
    _body_size(len(raw))
    return raw


def _extension(raw: bytes) -> str:
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if raw[:2] == b"\xff\xd8":
        return ".jpg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp"
    return ".png"


def _store_image(payload: Any, code: str) -> str:
    raw = _decode_image(payload, code)
    name = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:10]}{_extension(raw)}"
    directory = Path(folder_paths.get_input_directory()) / INPUT_SUBFOLDER
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_bytes(raw)
    return f"{INPUT_SUBFOLDER}/{name}"


def _number_of(value: Any, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        return value
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return fallback


def _provided(value: Any) -> bool:
    """Did the client actually send this field, rather than spell out an empty one?"""
    return value not in (None, "", [], {})


def _sent(body: dict[str, Any], *names: str) -> bool:
    return any(_provided(body.get(name)) for name in names)


# --------------------------------------------------------------------------- #
# job bookkeeping
# --------------------------------------------------------------------------- #

def _track(job: dict[str, Any]) -> None:
    with _JOBS_LOCK:
        _JOBS[job["id"]] = job
        if len(_JOBS) > MAX_TRACKED_JOBS:
            for key in sorted(_JOBS, key=lambda item: float(_JOBS[item]["created"]))[: len(_JOBS) - MAX_TRACKED_JOBS]:
                _JOBS.pop(key, None)


def _tracked(job_id: str) -> dict[str, Any] | None:
    with _JOBS_LOCK:
        return _JOBS.get(job_id)


def _queue_snapshot() -> tuple[list[str], list[str]]:
    server = _prompt_server()
    queue = getattr(server, "prompt_queue", None) if server is not None else None
    if queue is None:
        return [], []
    try:
        running, pending = queue.get_current_queue()
    except Exception:
        return [], []
    return [_item_id(item) for item in running], [_item_id(item) for item in pending]


def _item_id(item: Any) -> str:
    try:
        return str(item[1])
    except (TypeError, IndexError, KeyError):
        return ""


def _history_entry(prompt_id: str) -> dict[str, Any] | None:
    server = _prompt_server()
    queue = getattr(server, "prompt_queue", None) if server is not None else None
    if queue is None:
        return None
    try:
        found = queue.get_history(prompt_id=prompt_id)
    except Exception:
        return None
    if isinstance(found, dict):
        entry = found.get(prompt_id)
        if isinstance(entry, dict):
            return entry
        if found and isinstance(next(iter(found.values())), dict):
            return next(iter(found.values()))
    return None


def _status_of(entry: dict[str, Any] | None) -> str:
    if not isinstance(entry, dict):
        return ""
    status = entry.get("status")
    if not isinstance(status, dict):
        return ""
    return str(status.get("status_str") or "")


def _error_of(entry: dict[str, Any] | None) -> str:
    if not isinstance(entry, dict):
        return ""
    status = entry.get("status")
    messages = status.get("messages") if isinstance(status, dict) else None
    for entry_message in messages or []:
        if isinstance(entry_message, (list, tuple)) and len(entry_message) >= 2 and entry_message[0] == "execution_error":
            data = entry_message[1] if isinstance(entry_message[1], dict) else {}
            detail = str(data.get("exception_message") or data.get("exception_type") or "").strip()
            node = str(data.get("node_type") or "").strip()
            return f"{node}: {detail}".strip(": ") if node or detail else "execution_error"
    return ""


def _outputs_of(prompt_id: str, entry: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Finished images, as paths a client can fetch — never a base to re-join.

    The URL is built from :data:`API_ROOT`, which is the same root
    ``endpoints.output`` publishes, so the address a client reads out of the
    document and the address it is handed back here are the same string.  There
    is no second root to be relative to, so nothing here reads the request.
    """
    if not isinstance(entry, dict):
        return []
    outputs = entry.get("outputs")
    if not isinstance(outputs, dict):
        return []
    files: list[dict[str, Any]] = []
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        for image in node_output.get("images") or []:
            if not isinstance(image, dict):
                continue
            filename = str(image.get("filename") or "").strip()
            if not filename:
                continue
            suffix = Path(filename).suffix.lower()
            files.append(
                {
                    "index": len(files),
                    "filename": filename,
                    "subfolder": str(image.get("subfolder") or ""),
                    "type": str(image.get("type") or "output"),
                    "media_type": MEDIA_TYPES.get(suffix, "image/png"),
                    "url": f"{API_ROOT}/jobs/{prompt_id}/output/{len(files)}",
                }
            )
    return files


def _state_of(job: dict[str, Any], running: list[str], pending: list[str], entry: dict[str, Any] | None) -> str:
    if job.get("cancelled"):
        return "cancelled"
    outcome = _status_of(entry)
    if outcome == "success":
        return "completed"
    if outcome:
        return "failed"
    if entry is not None:
        return "completed"
    job_id = job["id"]
    if job_id in running:
        return "running"
    if job_id in pending:
        return "queued"
    return "unknown"


def _queue_position(job_id: str, running: list[str], pending: list[str]) -> int | None:
    """How many jobs are ahead of this one; ``0`` while it is the one running.

    Unlike a percentage, this is a number every implementation can actually
    compute, which is why the progress endpoint reports it and not an estimate.
    """
    if job_id in running:
        return 0
    if job_id in pending:
        return pending.index(job_id)
    return None


def _describe(job: dict[str, Any], running: list[str], pending: list[str],
              entry: dict[str, Any] | None) -> dict[str, Any]:
    state = _state_of(job, running, pending, entry)
    job_id = str(job["id"])
    outputs = _outputs_of(job_id, entry)

    payload: dict[str, Any] = {
        "id": job_id,
        "category": str(job.get("category") or ""),
        "state": state,
        "queue_position": _queue_position(job_id, running, pending),
        # Never a fabricated number: the CHP contract allows null.
        "progress": None,
        "created": job.get("created"),
        "typical_seconds": job.get("typical_seconds"),
        # The effective values, echoed back: a client that asked for something
        # out of range must be able to read what it actually got instead of
        # assuming its own number took.
        "resolution": str(job.get("resolution") or ""),
        "seed": job.get("seed"),
        "ref_strength": job.get("ref_strength"),
        # Carried through verbatim, so a happ that put its own key in here can
        # read it back — including one the server did not understand.
        "ext_params": dict(job.get("ext_params") or {}),
        "prompt": str(job.get("prompt") or ""),
        "prompt_source": str(job.get("prompt_source") or ""),
        "translated": bool(job.get("translated")),
        "ignored": list(job.get("ignored") or []),
        "outputs": outputs,
    }
    if state == "failed":
        payload["error"] = _error_of(entry) or "execution_error"
    return payload


def _progress_payload(job_id: str, job: dict[str, Any] | None, entry: dict[str, Any] | None,
                      running: list[str], pending: list[str]) -> dict[str, Any]:
    """The light polling answer: state and position, never output parsing."""
    state = "unknown"
    if job is not None:
        state = _state_of(job, running, pending, entry)
    elif entry is not None:
        state = "completed" if not _status_of(entry) or _status_of(entry) == "success" else "failed"
    elif job_id in running:
        state = "running"
    elif job_id in pending:
        state = "queued"
    return {"id": job_id, "state": state,
            "queue_position": _queue_position(job_id, running, pending),
            "progress": None}


def _safe_output_path(kind: str, subfolder: str, filename: str) -> Path | None:
    roots = {
        "output": getattr(folder_paths, "get_output_directory", None),
        "temp": getattr(folder_paths, "get_temp_directory", None),
        "input": getattr(folder_paths, "get_input_directory", None),
    }
    getter = roots.get(kind) or roots["output"]
    if getter is None:
        return None
    try:
        root = Path(getter()).resolve()
    except Exception:
        return None
    parts = [part for part in str(subfolder or "").replace("\\", "/").split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        return None
    candidate = root.joinpath(*parts, str(filename or "").strip()).resolve()
    try:
        if os.path.commonpath([str(root), str(candidate)]) != str(root):
            return None
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _drop_pending(job_id: str) -> bool:
    server = _prompt_server()
    queue = getattr(server, "prompt_queue", None) if server is not None else None
    if queue is None:
        return False
    remover = getattr(queue, "delete_queue_item", None)
    if not callable(remover):
        return False
    try:
        return bool(await _maybe_await(remover(lambda item: _item_id(item) == job_id)))
    except Exception:
        return False


async def _interrupt_running() -> bool:
    server = _prompt_server()
    queue = getattr(server, "prompt_queue", None) if server is not None else None
    for owner in (queue, server):
        if owner is None:
            continue
        for name in ("interrupt_current_processing", "interrupt_processing"):
            action = getattr(owner, name, None)
            if not callable(action):
                continue
            try:
                await _maybe_await(action())
                return True
            except Exception:
                continue
    return False


# --------------------------------------------------------------------------- #
# information
# --------------------------------------------------------------------------- #

async def info(request: web.Request) -> web.Response:
    """``GET /chp/info`` — the whole contract, and deliberately public.

    A wrong password is not an error here: ``auth.authorized`` says which it was,
    which is what lets one call answer "is the address right" and "is the
    password right" at the same time.
    """
    return _json(
        capabilities_module.document(
            files_of=_abilities_of,
            authorized=_authorized(request),
            auth_required=bool(_password()),
            translation=translate_module.describe(),
            auth_hint=AUTH_HINT,
            errors=sorted(ERROR_STATUS),
        )
    )


# --------------------------------------------------------------------------- #
# jobs
# --------------------------------------------------------------------------- #

def _no_model(category: str, folder: str, name: str = "") -> web.Response:
    """The one ``no_model`` answer, from the one place that decides it.

    ``name`` empty means nothing is configured for that slot, which is a
    different sentence from "the file you picked is not installed" — the operator
    fixes the first in the config node and the second on disk.
    """
    if name:
        message = f"模型 {name} 不在 ComfyUI 的 {folder} 目录里。"
    else:
        message = f"这个场景还没有在 {folder} 里选模型。"
    return _fail("no_model", message=message,
                 detail={"category": category, "folder": folder,
                         "available": _available_files(folder)})


def _resolve_models(category: str) -> tuple[dict[str, str], web.Response | None]:
    """The files this category will run on, or the error to answer with.

    The judgement is :func:`_abilities_of`'s, not a second copy of it.  The
    information document tells a client which files are installed; if submission
    decided that separately the two could disagree, and a client configured from
    the document would be refused anyway — the one failure mode a discovery
    document exists to prevent.  One decision point, so they cannot.
    """
    resolved = _abilities_of(category)
    if resolved["ready"]:
        return resolved["files"], None
    role = str(resolved["missing"][0])
    folder = capabilities_module.ROLE_FOLDERS.get(role, role)
    name = str(resolved["files"].get(role) or "").strip()
    return {}, _no_model(category, folder, name)


async def create_job(request: web.Request) -> web.Response:
    # The body is read *before* the password is checked, because the password may
    # be in it: a request that carries a body sends ``chp_params.password``, and
    # a secret belongs in neither a URL nor a log line.  Reading it first costs
    # nothing — a successful request needed the body anyway, and aiohttp already
    # bounds it at ``MAX_BODY_BYTES``.
    try:
        body = await request.json()
    except Exception:
        return _fail("bad_request")
    if not isinstance(body, dict):
        return _fail("bad_request")
    if not _authorized(request, body):
        return _fail("unauthorized")

    # Every top-level field this version does not recognise, echoed back.  This
    # is the receipt that makes a rename visible instead of silent: a client
    # still sending ``capability`` / ``size`` / ``steps`` is told, in the one
    # response it was already reading, that those are no longer the field names.
    ignored = sorted(str(field) for field in body if field not in RECOGNISED_FIELDS)

    # ``category`` is the only spelling.  ``capability`` and ``task`` are not
    # aliases any more — a client that sends one instead is refused, and the
    # ``ignored`` list above says which field it should have used.
    try:
        category = capabilities_module.category_of(body.get("category"))
    except ValueError:
        return _fail("unsupported_category",
                     detail={"category": body.get("category"), "ignored": ignored})
    name = str(category["category"])

    # A member of the category's frame table, not a numeric domain: the client
    # picks from the menu the document published, and nothing computes a shape
    # the menu never offered.
    try:
        resolution = capabilities_module.validate_resolution(name, body.get("resolution"))
        width, height = capabilities_module.resolution_size(resolution)
    except ValueError as error:
        code = str(error)
        return _fail(code if code in ERROR_STATUS else "bad_request",
                     detail={"category": name, "resolution": body.get("resolution"),
                             "ignored": ignored})

    seed_value = _number_of(body.get("seed"), 0)
    seed = int(seed_value or 0)
    if seed < 0:
        return _fail("bad_request", "seed 不能是负数。", detail={"seed": seed_value})

    needs = category.get("needs") or {}
    if needs.get("mask") and not _sent(body, "mask_base64"):
        return _fail("bad_mask")
    if needs.get("image") and not _sent(body, "image_base64"):
        return _fail("bad_image")

    models, refused = _resolve_models(name)
    if refused is not None:
        return refused

    running, pending = _queue_snapshot()
    if len(pending) >= MAX_PENDING_JOBS:
        return _fail("busy", detail={"pending": len(pending)})

    try:
        # 参考图是可选的 —— 类别声明 needs.image=false 时, 不带它就是一次纯文生图,
        # 不是"漏了参数"。所以这里判的是"带了没带": 带了才落盘, 带了但不合法照样报
        # bad_image。needs.image 为真的类别在上面已经被拦下, 走不到这里。
        image_name = ""
        if _sent(body, "image_base64"):
            image_name = _store_image(body.get("image_base64"), "bad_image")
        mask_name = ""
        if needs.get("mask"):
            mask_name = _store_image(body.get("mask_base64"), "bad_mask")
    except ValueError as error:
        return _fail(str(error))

    # The model layer, carried and echoed verbatim — the spec defines no field in
    # it.  This implementation reads two keys of its own out of it, ``step`` and
    # ``negative_prompt``, and it reads them *here* rather than in ``families``
    # so that "what was echoed" and "what was used" are the same object.
    raw_ext = body.get("ext_params")
    ext = dict(raw_ext) if isinstance(raw_ext, dict) else {}

    prompt_source = str(body.get("prompt") or "")
    prompt_used, translated = prompt_source, False
    if needs.get("prompt") and str((category.get("prompt") or {}).get("language") or "") == "en":
        prompt_used, translated = await translate_module.ensure_english(prompt_source)

    settings = settings_module.load()
    sampling = settings["sampling"].get(name) or {}
    ref_strength = capabilities_module.clamp_ref_strength(
        body.get("ref_strength"), float(category["defaults"]["ref_strength"]))

    try:
        graph = families.build(
            spec=category,
            models=models,
            sampling=sampling,
            image=image_name,
            mask=mask_name,
            prompt=prompt_used,
            seed=seed,
            size=(width, height),
            ref_strength=ref_strength,
            ext=ext,
            options=settings_module.family_options(str(category.get("family") or "")),
            filename_prefix=f"hamdraw/{name}",
        )
    except ValueError as error:
        code = str(error)
        return _fail(code if code in ERROR_STATUS else "bad_request")
    except Exception:
        return _fail("internal", "内置工作流生成失败。")

    server = _prompt_server()
    if server is None:
        return _fail("internal", "ComfyUI 服务未就绪。")

    prompt_id = str(uuid.uuid4())
    try:
        import execution

        valid = await execution.validate_prompt(prompt_id, graph, ["9"])
    except Exception:
        return _fail("internal", "工作流校验无法执行。")

    if not valid or not valid[0]:
        reasons = valid[1] if valid and len(valid) > 1 else ""
        node_errors = valid[3] if valid and len(valid) > 3 else None
        text = reasons if isinstance(reasons, str) else json.dumps(reasons, ensure_ascii=False)
        return _fail("invalid_workflow", text or ERROR_MESSAGES["invalid_workflow"], detail={"node_errors": node_errors})

    outputs_to_execute = valid[2]
    queue = getattr(server, "prompt_queue", None)
    if queue is None:
        return _fail("internal", "ComfyUI 队列不可用。")

    try:
        number = int(getattr(server, "number", 0))
        server.number = number + 1
    except Exception:
        number = 0
    extra_data = {"client_id": CLIENT_ID, "create_time": int(time.time() * 1000)}
    try:
        queue.put((number, prompt_id, graph, extra_data, outputs_to_execute, {}))
    except Exception:
        return _fail("internal", "任务入队失败。")

    job = {
        "id": prompt_id,
        "category": name,
        "created": time.time(),
        "typical_seconds": category.get("typical_seconds"),
        "resolution": resolution,
        "seed": seed,
        "ref_strength": ref_strength,
        "ext_params": ext,
        "prompt": prompt_used,
        "prompt_source": prompt_source,
        "translated": translated,
        "ignored": ignored,
        "cancelled": False,
    }
    _track(job)
    return _json({"job": _describe(job, running, pending + [prompt_id], None)}, status=202)


async def job_status(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _fail("unauthorized")
    job_id = str(request.match_info.get("job_id") or "").strip()
    job = _tracked(job_id)
    entry = _history_entry(job_id)
    if job is None:
        if entry is None:
            return _fail("not_found")
        # A job submitted before this process started: the record is gone but
        # ComfyUI's history still has the outputs, so the job is described from
        # an empty shell rather than reported missing.
        job = {"id": job_id, "category": "", "created": time.time(), "cancelled": False}
    running, pending = _queue_snapshot()
    return _json({"job": _describe(job, running, pending, entry)})


async def job_progress(request: web.Request) -> web.Response:
    """``GET /chp/jobs/{id}/progress`` — what a client polls while it waits.

    Returns state and queue position only.  It reads the history entry because
    that is the only way to know whether a job that left the queue succeeded,
    but it never walks the outputs, which is the expensive half of the full
    status call.  ``progress`` is ``null``: the contract allows it, and inventing
    a number would be worse than admitting there is none.
    """
    if not _authorized(request):
        return _fail("unauthorized")
    job_id = str(request.match_info.get("job_id") or "").strip()
    job = _tracked(job_id)
    entry = _history_entry(job_id)
    running, pending = _queue_snapshot()
    if job is None and entry is None and job_id not in running and job_id not in pending:
        return _fail("not_found")
    return _json({"job": _progress_payload(job_id, job, entry, running, pending)})


async def job_output(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _fail("unauthorized")
    job_id = str(request.match_info.get("job_id") or "").strip()
    try:
        index = int(str(request.match_info.get("index") or "0"))
    except (TypeError, ValueError):
        return _fail("bad_request")
    files = _outputs_of(job_id, _history_entry(job_id))
    if index < 0 or index >= len(files):
        return _fail("not_found")
    chosen = files[index]
    path = _safe_output_path(chosen["type"], chosen["subfolder"], chosen["filename"])
    if path is None:
        return _fail("not_found")
    response = web.FileResponse(path)
    response.headers["Cache-Control"] = "private, max-age=3600"
    response.headers["Content-Disposition"] = f'inline; filename="{chosen["filename"]}"'
    return response


async def cancel_job(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _fail("unauthorized")
    job_id = str(request.match_info.get("job_id") or "").strip()
    job = _tracked(job_id)
    running, pending = _queue_snapshot()
    if job is None and job_id not in running and job_id not in pending:
        return _fail("not_found")
    dropped = False
    if job_id in pending:
        dropped = await _drop_pending(job_id)
    elif job_id in running:
        dropped = await _interrupt_running()
    if job is not None:
        job["cancelled"] = True
    elif dropped:
        job = {"id": job_id, "category": "", "created": time.time(), "cancelled": True}
        _track(job)
    if job is None:
        return _fail("not_found")
    running, pending = _queue_snapshot()
    return _json({"job": _describe(job, running, pending, _history_entry(job_id))})


async def translate_prompts(request: web.Request) -> web.Response:
    """Pre-translate a prompt so a client can show the user the English it will send.

    Optional — a job submitted with Chinese is translated on the way in anyway.
    A text without a non-ASCII character comes back untouched, and so does every
    text when the translator is off or unreachable: the caller decides what to
    do, it never has to handle an error.
    """
    try:
        body = await request.json()
    except Exception:
        return _fail("bad_request")
    if not isinstance(body, dict):
        return _fail("bad_request")
    if not _authorized(request, body):
        return _fail("unauthorized")
    raw = body.get("texts")
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list) or not raw:
        return _fail("bad_request")
    outcome = await translate_module.translate([item for item in raw], target=str(body.get("target") or "en"))
    return _json(outcome)


# --------------------------------------------------------------------------- #
# wiring
# --------------------------------------------------------------------------- #

def register_routes() -> bool:
    """Attach the API to the running ComfyUI server; safe to call once at import."""
    server = _prompt_server()
    if server is None:
        return False
    routes = getattr(server, "routes", None)
    if routes is None:
        return False
    application = getattr(server, "app", None)
    if application is not None:
        try:
            application._client_max_size = MAX_BODY_BYTES
        except Exception:
            pass

    # One root, spelled once.  The alias loop that used to be here existed so
    # ``/cvp`` could serve the same API; a client is now told to read its
    # addresses out of the document's ``endpoints``, so a second spelling of the
    # same thing is a promise this version deliberately stops making.
    routes.get(f"{API_ROOT}/info")(info)
    routes.post(f"{API_ROOT}/jobs")(create_job)
    routes.get(f"{API_ROOT}/jobs/{{job_id}}")(job_status)
    routes.get(f"{API_ROOT}/jobs/{{job_id}}/progress")(job_progress)
    routes.get(f"{API_ROOT}/jobs/{{job_id}}/output/{{index}}")(job_output)
    routes.post(f"{API_ROOT}/jobs/{{job_id}}/cancel")(cancel_job)
    routes.post(f"{API_ROOT}/translate")(translate_prompts)
    return True


__all__ = ["API_ROOT", "register_routes"]
