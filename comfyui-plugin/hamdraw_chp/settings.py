"""Persistent settings for the ComfyUI plugin.

Settings are written by the ``HamDrawConfig`` node when the user queues it once,
so a user can configure the password and the models from inside ComfyUI without
editing JSON by hand.  The HTTP layer reads them on every request, so a change
takes effect immediately and never needs a ComfyUI restart.

Resolution order for the password:
    1. ``HAMDRAW_PASSWORD`` environment variable (keeps secrets out of the graph)
    2. the password stored by the config node
    3. empty -> authentication disabled, and the document reports it

Nothing here may carry a default that only fits one machine.  A translation
backend address, a cache dtype chosen for a memory-starved box, a model file name
— all of those are deployment decisions and all of them default to "unset".
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from . import capabilities

SCHEMA = "hamdraw-comfy-settings/v1"
ENVIRONMENT_PASSWORD = "HAMDRAW_PASSWORD"
ENVIRONMENT_FILE = "HAMDRAW_SETTINGS"
ENVIRONMENT_TRANSLATE_URL = "HAMDRAW_TRANSLATE_URL"
ENVIRONMENT_TRANSLATE_MODEL = "HAMDRAW_TRANSLATE_MODEL"
ENVIRONMENT_TRANSLATE_DISABLED = "HAMDRAW_TRANSLATE_DISABLED"

#: Driven by the category table, so a category added there is configurable
#: here without a second list to keep in step.
TASKS: tuple[str, ...] = tuple(capabilities.categories())

#: Files a non-checkpoint task needs.  Qwen-Image 2.1 is published as three
#: separate files (diffusion model, text encoder, VAE) instead of one
#: checkpoint, so those tasks name each of them here rather than a checkpoint.
MODEL_ROLES = ("unet", "clip", "vae")

#: The checkpoint the plugin suggests for the realtime category.  A suggestion,
#: not a requirement — the config node falls back to whatever is installed.
RECOMMENDED_CHECKPOINT = "DreamShaper8_LCM.safetensors"

#: Translation is off until an address is given: there is no default backend, and
#: picking one would hard-code a single deployment into the plugin.  ``enabled``
#: is the operator's intent; the effective switch is also gated on ``url``.
TRANSLATE_TIMEOUT_RANGE = (3.0, 120.0)
TRANSLATE_MEMORY_RANGE = (0, 200000)

#: 加速 LoRA 的强度。0 等于不挂, 2 已经是能把图拧坏的上限 —— 这里只挡住明显的手滑。
ACCELERATOR_STRENGTH_RANGE = (0.0, 2.0)

#: 哪几个类别走"三件套"而不是单个 checkpoint —— 由类别表的 roles 算出来, 不另写一份。
TRIPLE_TASKS: tuple[str, ...] = tuple(
    name for name in TASKS if "checkpoint" not in capabilities.CATEGORY_TABLE[name]["roles"])

#: 每个类别的采样默认值。checkpoint 那一族是 LCM 快手（cfg 2.0 才有作用）;
#: Qwen 那一族是 flow 模型, cfg 1.0 就是"不做 classifier-free guidance", 这也是它的
#: negative prompt 不起作用的原因 —— cfg 1 时没有可绕开的方向。
SAMPLING_DEFAULTS: dict[str, dict[str, Any]] = {
    "fast": {"sampler": "lcm", "scheduler": "sgm_uniform", "cfg": 2.0},
    "inpaint": {"sampler": "lcm", "scheduler": "sgm_uniform", "cfg": 2.0},
    "upscale": {"sampler": "lcm", "scheduler": "sgm_uniform", "cfg": 2.0},
    "render": {"sampler": "euler", "scheduler": "simple", "cfg": 1.0},
    "generate": {"sampler": "euler", "scheduler": "simple", "cfg": 1.0},
}

DEFAULTS: dict[str, Any] = {
    "schema": SCHEMA,
    "password": "",
    "checkpoints": {name: RECOMMENDED_CHECKPOINT if name == "fast" else "" for name in TASKS},
    "models": {name: {role: "" for role in capabilities.CATEGORY_TABLE[name]["roles"]}
               for name in TRIPLE_TASKS},
    "sampling": {name: dict(SAMPLING_DEFAULTS[name]) for name in TASKS},
    # 加速档案: 按类别配, 出厂**留空**。这不是省事, 是这份文件的规矩 —— 一个"4 步蒸馏
    # LoRA"的文件名只对装了它的那台机器成立, 写进出厂默认就是把一台机器的权宜值当成了
    # 所有人的契约（同 ``translate.url`` 与 ``cache_dtype``）。哪台机器想快, 就在它自己的
    # ``hamdraw_settings.json`` 里写:
    #     "accelerators": {"render": {"lora": "acc_pdd_4step_comfy.safetensors",
    #                                 "strength": 1.0,
    #                                 "sigmas": "1.0, 0.9169867038726807, 0.7861579060554504,
    #                                            0.5494909882545471, 0.0"}}
    # ``sigmas`` 的长度就是它的步数加一 —— 加速只在那一档步数上成立, 见 families/qwen_image.py。
    "accelerators": {},
    # Per-family knobs that are genuinely deployment tuning rather than contract.
    # The shipped defaults carry no deployment: ``auto`` and the node's own
    # ``reference_edge`` are what the model's author would pick, and a box that
    # is short on memory writes ``int8`` / a smaller encode budget here instead
    # of the plugin assuming it.  (``reference_edge`` 是参考图的编码面积预算,
    # 原生引擎管它叫 ``reference_resolution``: 参考图缩到"约 edge² 像素"再进编码器,
    # **出图画幅不受它影响**。)
    "families": {
        "qwen_image_21": {"cache_device": "auto", "cache_dtype": "default", "reference_edge": "1024"},
    },
    "translate": {
        "enabled": True,
        "url": "",
        "model": "qwen3-0.6b",
        "timeout": 25.0,
        "memory_limit": 4000,
    },
}

_LOCK = threading.RLock()


def path() -> Path:
    override = os.environ.get(ENVIRONMENT_FILE, "").strip()
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parent / "hamdraw_settings.json"


def _read() -> dict[str, Any]:
    try:
        stored = json.loads(path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return stored if isinstance(stored, dict) else {}


def _number(value: Any, fallback: float, limits: tuple[float, float]) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    low, high = limits
    return min(max(float(value), low), high)


def _merge(base: dict[str, Any], stored: dict[str, Any]) -> dict[str, Any]:
    if isinstance(stored.get("password"), str):
        base["password"] = stored["password"]

    checkpoints = stored.get("checkpoints")
    if isinstance(checkpoints, dict):
        for name in TASKS:
            value = checkpoints.get(name)
            if isinstance(value, str):
                base["checkpoints"][name] = value.strip()

    models = stored.get("models")
    if isinstance(models, dict):
        for name in TASKS:
            entry = models.get(name)
            if not isinstance(entry, dict):
                continue
            slot = base["models"].setdefault(name, {})
            for role in MODEL_ROLES:
                value = entry.get(role)
                if isinstance(value, str):
                    slot[role] = value.strip()

    sampling = stored.get("sampling")
    if isinstance(sampling, dict):
        for name in TASKS:
            entry = sampling.get(name)
            if not isinstance(entry, dict):
                continue
            for key in ("sampler", "scheduler"):
                value = entry.get(key)
                if isinstance(value, str) and value.strip():
                    base["sampling"][name][key] = value.strip()
            value = entry.get("cfg")
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                base["sampling"][name]["cfg"] = float(value)

    stored_families = stored.get("families")
    if isinstance(stored_families, dict):
        for name, slot in base["families"].items():
            entry = stored_families.get(name)
            if not isinstance(entry, dict):
                continue
            for key in list(slot):
                value = entry.get(key)
                text = _family_option(value)
                if text:
                    slot[key] = text

    stored_accelerators = stored.get("accelerators")
    if isinstance(stored_accelerators, dict):
        for name in TASKS:
            entry = stored_accelerators.get(name)
            if not isinstance(entry, dict):
                continue
            merged = _accelerator_entry(entry)
            if merged:
                base["accelerators"][name] = merged

    translation = stored.get("translate")
    if isinstance(translation, dict):
        value = translation.get("enabled")
        if isinstance(value, bool):
            base["translate"]["enabled"] = value
        for key in ("url", "model"):
            value = translation.get(key)
            if isinstance(value, str):
                base["translate"][key] = value.strip()
        base["translate"]["timeout"] = _number(
            translation.get("timeout"), base["translate"]["timeout"], TRANSLATE_TIMEOUT_RANGE)
        base["translate"]["memory_limit"] = int(_number(
            translation.get("memory_limit"), base["translate"]["memory_limit"], TRANSLATE_MEMORY_RANGE))
    return base


def load() -> dict[str, Any]:
    with _LOCK:
        return _merge(json.loads(json.dumps(DEFAULTS)), _read())


def password() -> str:
    environment = os.environ.get(ENVIRONMENT_PASSWORD, "").strip()
    if environment:
        return environment
    return str(load().get("password") or "").strip()


def authorization_required() -> bool:
    return bool(password())


def _disabled_by_environment() -> bool:
    value = os.environ.get(ENVIRONMENT_TRANSLATE_DISABLED, "").strip().lower()
    return value not in ("", "0", "false", "no", "off")


def translate() -> dict[str, Any]:
    """Where to send a Chinese prompt, after the environment has had its say."""
    stored = load()["translate"]
    url = os.environ.get(ENVIRONMENT_TRANSLATE_URL, "").strip() or str(stored["url"])
    model = os.environ.get(ENVIRONMENT_TRANSLATE_MODEL, "").strip() or str(stored["model"])
    return {
        "enabled": bool(stored["enabled"]) and not _disabled_by_environment() and bool(url.strip()),
        "url": url.strip(),
        "model": model.strip(),
        "timeout": _number(stored["timeout"], 25.0, TRANSLATE_TIMEOUT_RANGE),
        "memory_limit": int(_number(stored["memory_limit"], 4000, TRANSLATE_MEMORY_RANGE)),
    }


def _family_option(value: Any) -> str:
    """One family option as text — the shape a node input takes.

    Numbers are welcome here because ``reference_edge`` reads far better as
    ``512`` than as ``"512"``; booleans are not, because they would silently
    become "True".
    """
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return ""
    return str(value).strip()


def family_options(name: str) -> dict[str, str]:
    """Deployment tuning for one family, as ``{option: value}``."""
    stored = load().get("families") or {}
    entry = stored.get(str(name or "").strip())
    if not isinstance(entry, dict):
        return {}
    return {key: text for key, text in ((key, _family_option(value)) for key, value in entry.items()) if text}


def _sigmas(value: Any) -> list[float]:
    """一张 sigma 表: 逗号串或数组都收, 有一个读不出来就整张作废。

    "整张作废"是有意的 —— 一张砍掉中间某个数的表仍然是一张**能跑**的表, 只是它调度的
    不是那个 LoRA 训练时的噪声水平, 出图只是"稍微不一样"。这种错没人看得出来, 所以宁可
    不加速, 也不能拿一张残表去采样。
    """
    if isinstance(value, str):
        parts: list[Any] = value.replace("\n", " ").split(",")
    elif isinstance(value, (list, tuple)):
        parts = list(value)
    else:
        return []
    values: list[float] = []
    for part in parts:
        try:
            values.append(float(str(part).strip()))
        except (TypeError, ValueError):
            return []
    return values


def _accelerator_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """One stored ``accelerators.<category>`` entry, normalised; ``{}`` if unusable."""
    lora = str(entry.get("lora") or "").strip()
    sigmas = _sigmas(entry.get("sigmas"))
    if not lora or len(sigmas) < 2:
        return {}
    return {"lora": lora,
            "strength": _number(entry.get("strength"), 1.0, ACCELERATOR_STRENGTH_RANGE),
            "sigmas": sigmas}


def accelerator(category: str) -> dict[str, Any]:
    """One category's acceleration profile, or ``{}`` when this box has none.

    ``{}`` 是**正常状态**, 不是错误: 出厂默认就是没有加速档案, 因为一个 LoRA 的文件名
    只对装了它的那台机器成立。有档案时返回 ``{lora, strength, sigmas}`` —— 步数不在里面,
    它是 ``len(sigmas) - 1``, 由调用方一起算出来的东西不该有第二份。
    """
    stored = (load().get("accelerators") or {}).get(str(category or "").strip().lower())
    return _accelerator_entry(stored) if isinstance(stored, dict) else {}


def update(**fields: Any) -> dict[str, Any]:
    """Merge a partial settings patch into the stored file and return the result."""
    with _LOCK:
        stored = _read()
        if isinstance(fields.get("password"), str):
            stored["password"] = fields["password"]

        checkpoints = fields.get("checkpoints")
        if isinstance(checkpoints, dict):
            target = stored.setdefault("checkpoints", {})
            if not isinstance(target, dict):
                target = stored["checkpoints"] = {}
            for name in TASKS:
                value = checkpoints.get(name)
                if isinstance(value, str):
                    target[name] = value

        models = fields.get("models")
        if isinstance(models, dict):
            target = stored.setdefault("models", {})
            if not isinstance(target, dict):
                target = stored["models"] = {}
            for name in TASKS:
                entry = models.get(name)
                if not isinstance(entry, dict):
                    continue
                slot = target.setdefault(name, {})
                if not isinstance(slot, dict):
                    slot = target[name] = {}
                for role in MODEL_ROLES:
                    value = entry.get(role)
                    if isinstance(value, str):
                        slot[role] = value.strip()

        sampling = fields.get("sampling")
        if isinstance(sampling, dict):
            target = stored.setdefault("sampling", {})
            if not isinstance(target, dict):
                target = stored["sampling"] = {}
            for name in TASKS:
                entry = sampling.get(name)
                if not isinstance(entry, dict):
                    continue
                slot = target.setdefault(name, {})
                if not isinstance(slot, dict):
                    slot = target[name] = {}
                slot.update(entry)

        families = fields.get("families")
        if isinstance(families, dict):
            target = stored.setdefault("families", {})
            if not isinstance(target, dict):
                target = stored["families"] = {}
            for name, entry in families.items():
                if not isinstance(entry, dict):
                    continue
                slot = target.setdefault(str(name), {})
                if not isinstance(slot, dict):
                    slot = target[str(name)] = {}
                for key, value in entry.items():
                    text = _family_option(value)
                    if text:
                        slot[str(key)] = text

        accelerators = fields.get("accelerators")
        if isinstance(accelerators, dict):
            target = stored.setdefault("accelerators", {})
            if not isinstance(target, dict):
                target = stored["accelerators"] = {}
            for name in TASKS:
                entry = accelerators.get(name)
                if not isinstance(entry, dict):
                    continue
                # 空表 = **撤掉**这台机器的加速档案（回到"没有加速"那条路）, 而不是
                # 留一个半成品: 一个只写了一半的档案会让默认步数算不出来。
                merged = _accelerator_entry(entry)
                if merged:
                    slot = dict(entry)
                    slot["sigmas"] = list(merged["sigmas"])
                    target[name] = slot
                else:
                    target.pop(name, None)

        translation = fields.get("translate")
        if isinstance(translation, dict):
            target = stored.setdefault("translate", {})
            if not isinstance(target, dict):
                target = stored["translate"] = {}
            value = translation.get("enabled")
            if isinstance(value, bool):
                target["enabled"] = value
            for key in ("url", "model"):
                value = translation.get(key)
                if isinstance(value, str):
                    target[key] = value.strip()
            if "timeout" in translation:
                target["timeout"] = _number(translation["timeout"], 25.0, TRANSLATE_TIMEOUT_RANGE)
            if "memory_limit" in translation:
                target["memory_limit"] = int(_number(
                    translation["memory_limit"], 4000, TRANSLATE_MEMORY_RANGE))

        stored["schema"] = SCHEMA
        destination = path()
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(stored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(destination)
        return _merge(json.loads(json.dumps(DEFAULTS)), stored)


def checkpoint(task: str) -> str:
    """That category's checkpoint, falling back to the ``fast`` slot when empty.

    The fallback is what makes one configured checkpoint serve three categories
    without the operator filling in the same name three times, and it is the
    same value the graph would use — so a job submitted against it is not
    refused as if a model were missing.
    """
    settings = load()
    value = str(settings["checkpoints"].get(str(task or "").strip()) or "").strip()
    if value:
        return value
    return str(settings["checkpoints"].get("fast") or "").strip()


def model_files(task: str) -> dict[str, str]:
    """The unet / clip / vae triple for a non-checkpoint category (empty when unset).

    No fallback to another category's files on purpose: mixing a text encoder
    with a different diffusion model is not a configuration the graph can run,
    and silently substituting one would produce a confusing ``no_model`` much
    later instead of right here.
    """
    settings = load()
    stored = settings.get("models") or {}
    entry = stored.get(str(task or "").strip().lower())
    entry = entry if isinstance(entry, dict) else {}
    return {role: str(entry.get(role) or "").strip() for role in MODEL_ROLES}
