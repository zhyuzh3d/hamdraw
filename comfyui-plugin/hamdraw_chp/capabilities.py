"""The CHP category table, and the one document that describes it.

This module is the single source of truth for *what this server can do*.  The
HTTP layer, the config node and the offline tests all read it; adding a category
here makes it appear in the discovery document, in the config node's validation,
and to every client, with no second table to forget.

Four ideas hold it together:

* **A category declares a contract, not an implementation.**  ``needs`` /
  ``prompt`` / ``defaults`` narrow what a client may send and are published;
  which model runs behind it is the ``roles`` / ``family`` pair, and those are
  not.
* **The document is two tables, not one.**  ``rules`` says what shape of input a
  category takes; ``abilities`` says which files can run it and which canvases
  it can produce.  A category is a thing a client *asks for*; an ability is a
  thing that *answers*, and one ability may answer for several categories.
* **IO rules are spelled out once.**  ``txt-ref-2-img`` is split on its literal
  ``-2-``, and the signature and the schema key are *derived* from the modality
  list — so a rule's spelling has one source, and four categories cannot each
  drift from it by hand.
* **Canvases are a hand-written table** (:data:`FRAMES`), and the order in it is
  part of the contract: the first frame of a category is that category's
  default.  Nothing computes a canvas, so nothing can compute a different one
  than the client was offered.

The meanings of the fields themselves live in :data:`INPUT_SCHEMAS` and in
``plans/chp-spec.md``; nothing here may invent a per-category meaning for a
shared field.
"""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any, Callable

from .version import __version__

#: The protocol version.  It is reported in the document and never in a path —
#: see the spec's principle 2.  A client that does not recognise it must say so
#: rather than guess, because this version promises nothing about the last one.
SPEC = "chp/2"

API_ROOT = "/chp"

PLUGIN_ID = "hamdraw_chp"
PLUGIN_LABEL = {"zh": "CHP 插件（ComfyUI Haminn Protocol）",
                "en": "CHP plugin (ComfyUI Haminn Protocol)"}

#: The relative paths a client should use.  Given here so a client never has to
#: assemble one itself — reading them is a rule, not a courtesy.
ENDPOINTS: dict[str, str] = {
    "info": f"{API_ROOT}/info",
    "jobs": f"{API_ROOT}/jobs",
    "job": f"{API_ROOT}/jobs/{{job_id}}",
    "progress": f"{API_ROOT}/jobs/{{job_id}}/progress",
    "output": f"{API_ROOT}/jobs/{{job_id}}/output/{{index}}",
    "cancel": f"{API_ROOT}/jobs/{{job_id}}/cancel",
    "translate": f"{API_ROOT}/translate",
}

#: The IO rule table.  Two rules, and their modalities are written in the
#: canonical order (``txt`` first, ``ref`` last) so a rule name can be compared
#: as a string instead of being parsed.
#:
#: Nothing else spells a rule out: :func:`signature_of` and :func:`input_of`
#: derive everything a client reads from the modality list below.
RULES: dict[str, dict[str, Any]] = {
    "txt-ref-2-img": {"modalities": ("txt", "ref"), "output": "img"},
    "txt-msk-ref-2-img": {"modalities": ("txt", "msk", "ref"), "output": "img"},
}


def signature_of(rule: str) -> str:
    """``txt-ref-2-img`` — the modality list joined by the rule's own separator."""
    entry = RULES[str(rule)]
    return "-".join((*entry["modalities"], "2", entry["output"]))


def input_of(rule: str) -> str:
    """The shared schema key a rule uses: one rule, one schema, one spelling."""
    return f"{rule}/v1"


#: The domain of ``ref_strength``, everywhere, for every category.  It is a
#: direction ("higher = closer to the reference"), not a mechanism: one family
#: implements it as a denoise floor, another by softening the reference, and
#: both are compliant.  Out-of-range values are clamped, not rejected.
REF_STRENGTH_RANGE = (0.05, 0.95)

#: 画幅：**手写的表，顺序就是规范的一部分**。
#:
#: 每个类别下面按序排 `ratio` → 该比例下的分辨率；某个类别的默认画幅就是它的第一档。
#: 没有"域"，没有"域内自己算一张"—— 这张表就是全部合法值，校验是成员检查。业主定稿：
#: 客户端**只选不算**，所以服务端也不该允许它算出来的东西。
#:
#: `ratio` 是**标签**，不由数字反推：`768 × 1344` 的精确比是 4:7，叫它 9:16 是作者
#: 定的类目名（和相机的画幅档位一个道理）。
FRAMES: dict[str, list[dict[str, Any]]] = {
    "fast": [
        {"ratio": "1:1", "resolution": ["512x512"]},
        {"ratio": "4:3", "resolution": ["576x384"]},
        {"ratio": "3:4", "resolution": ["384x576"]},
    ],
    "inpaint": [
        # 与 fast 共用一族 checkpoint，蒙版必须与画布同尺寸，所以画幅表也一样。
        {"ratio": "1:1", "resolution": ["512x512"]},
        {"ratio": "4:3", "resolution": ["576x384"]},
        {"ratio": "3:4", "resolution": ["384x576"]},
    ],
    # 放大**只列 1:1**：三个客户端发过来的都是 1:1，所以今天不损失任何东西。
    # 真要放大竖幅就往这张表里加一档（例如 9:16 ["576x1024", "1152x2048"]）——
    # 加一档就是全部工作量，因为校验、默认值、菜单都只读这张表。
    "upscale": [
        {"ratio": "1:1", "resolution": ["1024x1024", "2048x2048"]},
    ],
    "render": [
        {"ratio": "1:1", "resolution": ["1024x1024"]},
        {"ratio": "9:16", "resolution": ["768x1344"]},
        {"ratio": "16:9", "resolution": ["1344x768"]},
        {"ratio": "3:4", "resolution": ["832x1152"]},
        {"ratio": "4:3", "resolution": ["1152x832"]},
        {"ratio": "2:3", "resolution": ["832x1216"]},
        {"ratio": "3:2", "resolution": ["1216x832"]},
        {"ratio": "21:9", "resolution": ["1536x640"]},
    ],
}

_FIELD_HELP = {
    "category": {
        "zh": "要哪个功能场景。取值见信息文档的 rules。",
        "en": "Which functional scenario. The information document's rules list them.",
    },
    "resolution": {
        "zh": "输出分辨率, 写成 \"宽x高\"(如 \"768x1344\")。只能取该类别帧表里列出的值; 省略取该类别第一档。",
        "en": "Output resolution as \"WxH\" (e.g. \"768x1344\"). Only the values in that category's frames; omitted takes the first.",
    },
    "prompt": {
        "zh": "画面描述。是否需要先译成英文由 rules[].prompt.language 决定。",
        "en": "What to draw. Whether it must be English first is the rule's prompt.language.",
    },
    "image_base64": {
        "zh": "参考图, PNG/JPEG 的 base64, 可直接给 data URL。",
        "en": "Reference image as base64 PNG/JPEG; a data URL is accepted as-is.",
    },
    "mask_base64": {
        "zh": "蒙版, 黑底白区, 白色 = 要重画。",
        "en": "Mask, black background with a white area; white means repaint.",
    },
    "seed": {
        "zh": "0 表示每张都不一样; 同一个值可以复现。",
        "en": "0 means a new seed each run; the same value reproduces.",
    },
    "ref_strength": {
        "zh": "0.05–0.95, 越大越贴近参考图, 越低越放手重画。越界会被夹到边界。",
        "en": "0.05–0.95. Higher stays closer to the reference, lower redraws more freely. Out of range is clamped.",
    },
    "ext_params": {
        "zh": "模型层的扩展参数, 原样携带、原样回显。规范不定义任何字段。",
        "en": "Model-layer extension parameters, carried and echoed verbatim. The spec defines no field in it.",
    },
    "chp_params": {
        "zh": "CHP 层的扩展参数。目前只有 password。",
        "en": "CHP-layer extension parameters. Today only password.",
    },
}

#: The request body every category shares, written once.  A rule whose modalities
#: include ``msk`` additionally requires ``mask_base64``; that second schema is
#: *generated* from this one rather than typed out, so the two can never drift.
_BASE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["category"],
    "properties": {
        "category": {
            "type": "string",
            "title": {"zh": "场景", "en": "Category"},
            "help": _FIELD_HELP["category"],
        },
        "resolution": {
            "type": "string", "pattern": r"^\d+x\d+$",
            "title": {"zh": "分辨率", "en": "Resolution"}, "help": _FIELD_HELP["resolution"],
        },
        "prompt": {
            "type": "string", "default": "",
            "title": {"zh": "提示词", "en": "Prompt"}, "help": _FIELD_HELP["prompt"],
        },
        "seed": {
            "type": "integer", "minimum": 0, "default": 0, "recommended": True,
            "title": {"zh": "随机种子", "en": "Seed"}, "help": _FIELD_HELP["seed"],
        },
        "ref_strength": {
            "type": "number", "minimum": REF_STRENGTH_RANGE[0], "maximum": REF_STRENGTH_RANGE[1],
            "title": {"zh": "参考图权重", "en": "Reference influence"}, "help": _FIELD_HELP["ref_strength"],
        },
        "image_base64": {
            "type": "string", "format": "base64-image",
            "title": {"zh": "参考图", "en": "Reference"}, "help": _FIELD_HELP["image_base64"],
        },
        "mask_base64": {
            "type": "string", "format": "base64-image",
            "title": {"zh": "蒙版", "en": "Mask"}, "help": _FIELD_HELP["mask_base64"],
        },
        "ext_params": {
            "type": "object", "additionalProperties": True, "default": {},
            "title": {"zh": "模型扩展参数", "en": "Model extensions"}, "help": _FIELD_HELP["ext_params"],
        },
        "chp_params": {
            "type": "object", "additionalProperties": True, "default": {},
            "title": {"zh": "CHP 扩展参数", "en": "CHP extensions"}, "help": _FIELD_HELP["chp_params"],
        },
    },
}


def _masked(schema: dict[str, Any]) -> dict[str, Any]:
    """The same schema, with ``mask_base64`` required as well.

    A copy, not a second literal: "write the client once and it calls every
    rule" is the point of sharing a schema, and that promise dies the moment a
    second one is typed out by hand.
    """
    copy = deepcopy(schema)
    copy["required"] = [*schema["required"], "mask_base64"]
    return copy


INPUT_SCHEMAS: dict[str, dict[str, Any]] = {
    input_of(rule): (_masked(_BASE_SCHEMA) if "msk" in entry["modalities"] else deepcopy(_BASE_SCHEMA))
    for rule, entry in RULES.items()
}

#: The category table: one entry per scenario a client can ask for.
#:
#: ``roles`` / ``family`` / ``steps`` are **implementation** and are not
#: published — the first says which model slots must be configured, the second
#: says which module under ``families/`` builds the graph, and the third is this
#: implementation's own enumeration for the ``step`` extension parameter.
CATEGORY_TABLE: dict[str, dict[str, Any]] = {
    "fast": {
        "category": "fast",
        "rule": "txt-ref-2-img",
        "label": {"zh": "快速生图", "en": "Quick draw"},
        "description": {
            "zh": "把画布当作参考图重绘一张 512 × 512 的速写稿。",
            "en": "Redraw the canvas as a 512 × 512 sketch.",
        },
        "prompt": {"language": "en"},
        "needs": {"prompt": True, "image": True, "mask": False},
        "defaults": {"ref_strength": 0.55},
        "typical_seconds": 1.2,
        "roles": ["checkpoint"],
        "family": "checkpoint",
        "steps": {"values": (2, 4, 6, 8), "default": 8},
    },
    "inpaint": {
        "category": "inpaint",
        "rule": "txt-msk-ref-2-img",
        "label": {"zh": "局部重绘", "en": "Local redraw"},
        "description": {
            "zh": "只重画白色蒙版覆盖的区域, 其余部分原样保留。",
            "en": "Repaint only the white mask area and keep everything else.",
        },
        "prompt": {"language": "en"},
        "needs": {"prompt": True, "image": True, "mask": True},
        "defaults": {"ref_strength": 0.30},
        "typical_seconds": 2.6,
        "roles": ["checkpoint"],
        "family": "checkpoint",
        "steps": {"values": (4, 6, 8, 12), "default": 6},
    },
    "upscale": {
        "category": "upscale",
        "rule": "txt-ref-2-img",
        "label": {"zh": "图像放大", "en": "Upscale"},
        "description": {
            "zh": "把画布放大到 1024 或 2048 并补细节。",
            "en": "Upscale the canvas to 1024 or 2048 and add detail.",
        },
        "prompt": {"language": "en"},
        "needs": {"prompt": True, "image": True, "mask": False},
        "defaults": {"ref_strength": 0.75},
        "typical_seconds": 6.0,
        "roles": ["checkpoint"],
        "family": "checkpoint",
        "steps": {"values": (4, 8, 12, 16, 20), "default": 8},
    },
    "render": {
        "category": "render",
        "rule": "txt-ref-2-img",
        "label": {"zh": "高质量生图", "en": "High quality render"},
        "description": {
            "zh": "重画成一张 1024 以内的成品图。比速写模型重得多, 单张要几十秒。",
            "en": "Repaint the canvas into a finished picture up to 1024 px. Far heavier than a sketch model.",
        },
        "prompt": {"language": "any"},
        # 带参考图就是参考图编辑, 不带就是纯文生图 —— 同一个类别的两种用法，
        # 不是两个类别。底层 TextEncodeQwenImage21 的 images 输入 min=0，所以
        # "没有参考图"是它明确支持的路径。
        "needs": {"prompt": True, "image": False, "mask": False},
        "defaults": {"ref_strength": 0.95},
        "typical_seconds": 45.0,
        "roles": ["unet", "clip", "vae"],
        "family": "qwen_image_21",
        "steps": {"values": (12, 16, 20, 25, 30, 40), "default": 20},
    },
}

#: Which model role lives in which ComfyUI folder.  Kept beside the resolver so
#: "is this file installed" is answered per role, exactly as submission does it.
ROLE_FOLDERS = {"checkpoint": "checkpoints", "unet": "diffusion_models",
                "clip": "text_encoders", "vae": "vae"}

#: How an ability introduces itself when no single file can name it.  A
#: one-checkpoint ability is named by its checkpoint; the render triple has no
#: one file to point at, so it uses the model family's own name.
ABILITY_NAMES = {"qwen_image_21": "qwen2.1"}


def check_frames(frames: dict[str, list[dict[str, Any]]] | None = None) -> None:
    """The two assembly-time assertions of the spec's frames section.

    Both are facts about *this* table, not about a request: a category with no
    frame is a document that offers a scenario nothing can serve, and a repeated
    ``(category, resolution)`` is two abilities claiming the same answer to the
    only question a client asks.  Neither can be caught per request, because
    neither depends on the request — so they are raised when the plugin loads,
    where the person who can fix them is looking.
    """
    table = FRAMES if frames is None else frames
    for category in CATEGORY_TABLE:
        # 数的是**分辨率**不是帧条目: 一档帧却一条分辨率都没有, 客户端照样无从下
        # 手, 而那正是这条断言要挡的东西。missing 的键、空表、空 resolution 三种
        # 写法都要落到同一个结论上。
        frames = table.get(category) or []
        canvases = sum(len(entry.get("resolution") or [])
                       for entry in frames if isinstance(entry, dict))
        if not canvases:
            raise ValueError(f"类别 {category} 在 FRAMES 里没有任何帧")
    seen: set[tuple[str, str]] = set()
    for category, entries in table.items():
        for entry in entries or []:
            for resolution in (entry or {}).get("resolution") or []:
                key = (str(category), str(resolution))
                if key in seen:
                    raise ValueError(f"FRAMES 里 ({category}, {resolution}) 出现了两次")
                seen.add(key)


check_frames()


def categories() -> list[str]:
    return list(CATEGORY_TABLE)


def category_of(name: Any) -> dict[str, Any]:
    """Resolve a submitted ``category``, or raise ``unsupported_category``.

    There are no aliases: a category is named by the one word the document
    published, and a client that sends another word is told so instead of being
    quietly served something else.
    """
    entry = CATEGORY_TABLE.get(str(name or "").strip().lower())
    if entry is None:
        raise ValueError("unsupported_category")
    return entry


def family_of(category: str) -> str:
    return str(CATEGORY_TABLE[str(category)]["family"])


def frames_of(category: str) -> list[dict[str, Any]]:
    """That category's frames, each stamped with its own category name."""
    return [{**deepcopy(entry), "category": str(category)}
            for entry in FRAMES.get(str(category)) or []]


def default_resolution(category: str) -> str:
    """The first frame's first resolution — the default is an entry in the table.

    Not a constant of its own: "the first one" and "the default" would otherwise
    be two facts to keep in step, and the whole point of a menu is that the
    thing it defaults to is on it.
    """
    entries = FRAMES.get(str(category)) or []
    for entry in entries:
        for resolution in entry.get("resolution") or []:
            return str(resolution)
    raise ValueError("unsupported_size")


def validate_resolution(category: str, resolution: Any) -> str:
    """A member check against the frames table, or ``unsupported_size``.

    Membership, not a numeric domain: ``896x1152`` used to be accepted because
    it was a legal canvas, and that is exactly the freedom this version removes.
    A client picks from the menu; nothing computes a shape the menu never
    offered.
    """
    wanted = str(resolution or "").strip()
    if not wanted:
        return default_resolution(category)
    allowed = {str(item) for entry in frames_of(category) for item in entry["resolution"]}
    if wanted not in allowed:
        raise ValueError("unsupported_size")
    return wanted


def validate_step(category: str, step: Any) -> int:
    """The reference implementation's own ``step`` enumeration.

    This is the plugin's behaviour, not a term of the contract: the spec defines
    no field inside ``ext_params`` at all.  It is written down here, next to the
    category it belongs to, and in the README.
    """
    entry = CATEGORY_TABLE[str(category)]
    allowed = [int(value) for value in entry["steps"]["values"]]
    if step is None:
        return int(entry["steps"]["default"])
    # ``int(20.5)`` 是 20 —— 直接取整会让一个小数步数被静默收下, 客户端以为
    # 自己发的值生效了。这里要求它本来就是个整数。
    try:
        number = float(step)
    except (TypeError, ValueError):
        raise ValueError("unsupported_steps") from None
    if number != number or number != int(number):
        raise ValueError("unsupported_steps")
    selected = int(number)
    if selected not in allowed:
        raise ValueError("unsupported_steps")
    return selected


def resolution_size(resolution: Any) -> tuple[int, int]:
    """``"768x1344"`` → ``(768, 1344)``; anything else is ``unsupported_size``."""
    parts = str(resolution or "").split("x")
    if len(parts) != 2:
        raise ValueError("unsupported_size")
    try:
        width, height = int(parts[0]), int(parts[1])
    except (TypeError, ValueError):
        raise ValueError("unsupported_size") from None
    if width <= 0 or height <= 0:
        raise ValueError("unsupported_size")
    return width, height


def clamp_ref_strength(value: Any, fallback: float) -> float:
    """Clamp a continuous knob to its declared domain.

    A resolution is a member of a list and an unknown one is refused; a
    continuous value is clamped and echoed back, because there is no plausible
    reason to fail a job over 0.96.
    """
    low, high = REF_STRENGTH_RANGE
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    if number != number:  # NaN
        return float(fallback)
    return round(min(max(number, low), high), 4)


def clean_defaults(category: dict[str, Any]) -> dict[str, Any]:
    """The defaults a client may rely on, as plain JSON."""
    return json.loads(json.dumps(category["defaults"]))


def rule_entry(category: str) -> dict[str, Any]:
    """One ``rules[]`` entry, as it appears in the document."""
    entry = CATEGORY_TABLE[str(category)]
    rule = str(entry["rule"])
    return {
        "category": str(category),
        "rule": rule,
        # 由规则表算出来，条目里没有第二份副本：改规则拼法只改一处。
        "signature": signature_of(rule),
        "input": input_of(rule),
        "label": deepcopy(entry["label"]),
        "description": deepcopy(entry["description"]),
        "needs": deepcopy(entry["needs"]),
        "prompt": deepcopy(entry["prompt"]),
        "defaults": clean_defaults(entry),
        "typical_seconds": entry["typical_seconds"],
    }


def rules() -> list[dict[str, Any]]:
    return [rule_entry(category) for category in CATEGORY_TABLE]


def _resolved_of(resolved: Any) -> dict[str, Any]:
    """Normalise whatever a caller's resolver returned."""
    if not isinstance(resolved, dict):
        resolved = {}
    files = resolved.get("files")
    files = {str(key): str(value) for key, value in files.items()} if isinstance(files, dict) else {}
    missing = [str(item) for item in (resolved.get("missing") or [])]
    return {"files": files, "ready": bool(resolved.get("ready")), "missing": missing}


def abilities(files_of: Callable[[str], Any]) -> list[dict[str, Any]]:
    """The model-file groups that can actually answer, and what each can make.

    Grouped by *the files it runs on* — ``fast`` / ``inpaint`` / ``upscale`` are
    three categories, but when they point at one checkpoint they are one
    ability, and the operator who gives ``inpaint`` its own checkpoint has two.
    Deriving the grouping instead of declaring it means the document can never
    claim a model that is not the one a job would use.

    The graph builder is part of the key as well.  In practice the files differ
    whenever the family does, so that part never decides anything today; it is
    there so that two families which happened to be configured with the same
    file names could never be merged into one entry claiming a single builder
    serves both — a claim that would be false the moment anyone read it.

    Order is preserved from the category table, so ``abilities[0]`` is the one
    holding the first category's frames.
    """
    groups: dict[tuple[str, tuple[tuple[str, str], ...]], dict[str, Any]] = {}
    for category in CATEGORY_TABLE:
        resolved = _resolved_of(files_of(category))
        key = (family_of(category), tuple(sorted(resolved["files"].items())))
        group = groups.get(key)
        if group is None:
            group = groups[key] = {
                "name": (resolved["files"].get("checkpoint")
                         or ABILITY_NAMES.get(family_of(category)) or family_of(category)),
                "files": resolved["files"],
                "ready": resolved["ready"],
                "missing": resolved["missing"],
                "frames": [],
            }
        if not resolved["ready"]:
            group["ready"] = False
        for role in resolved["missing"]:
            if role not in group["missing"]:
                group["missing"].append(role)
        group["frames"].extend(frames_of(category))
    return list(groups.values())


def document(*, files_of: Callable[[str], Any], authorized: bool, auth_required: bool,
             translation: dict[str, Any], auth_hint: str = "", errors: list[str] | None = None) -> dict[str, Any]:
    """The whole discovery document.

    Answers even when the password is wrong: ``auth.authorized`` says which it
    was, which is what lets a client tell "the address is right, the password is
    not" out of the one call it was going to make anyway.

    ``translation`` and ``files_of`` are supplied by the caller rather than read
    here: this module is the specification, and it must not depend on the parts
    of the server that touch the network or ComfyUI's model folders.
    """
    payload: dict[str, Any] = {
        "spec": SPEC,
        "plugin": {"id": PLUGIN_ID, "label": deepcopy(PLUGIN_LABEL), "version": __version__},
        "auth": {
            "required": bool(auth_required),
            "authorized": bool(authorized),
            "scheme": "Bearer",
            "header": "Authorization",
            "hint": auth_hint or "密码在 ComfyUI 的 CHP 插件配置节点里设置。",
        },
        "endpoints": dict(ENDPOINTS),
        "rules": rules(),
        "abilities": abilities(files_of),
        "input_schemas": deepcopy(INPUT_SCHEMAS),
        "translation": deepcopy(translation or {}),
    }
    if errors:
        # 参考实现多播报的一项：它认得的错误码。客户端据此把回执翻成人话；
        # 规范只要求「未知顶层键必须忽略」，所以这一项是可选的。
        payload["errors"] = sorted(str(code) for code in errors)
    return payload


__all__ = [
    "ABILITY_NAMES", "API_ROOT", "CATEGORY_TABLE", "ENDPOINTS", "FRAMES",
    "INPUT_SCHEMAS", "PLUGIN_ID", "PLUGIN_LABEL", "REF_STRENGTH_RANGE",
    "ROLE_FOLDERS", "RULES", "SPEC", "abilities", "categories", "category_of",
    "check_frames", "clamp_ref_strength", "clean_defaults", "default_resolution",
    "document", "family_of", "frames_of", "input_of", "resolution_size",
    "rule_entry", "rules", "signature_of", "validate_resolution", "validate_step",
]
