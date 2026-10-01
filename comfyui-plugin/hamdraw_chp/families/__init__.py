"""Builders, one per model family, plus the one function that dispatches to them.

A family answers three questions and nothing else:

1. which model roles it needs configured (:data:`ROLES` on each module);
2. how (prompt, reference, size, step, reference strength) become a graph;
3. what the reference-strength knob means *internally*.

The last one is the reason this package exists.  The contract fixes only the
direction and the domain of that knob ("higher = closer to the reference",
0.05–0.95); whether a family implements it as a denoise floor or by softening
the reference is its own business.  Swapping a model is adding a module and one
line below — not editing the HTTP layer, the discovery document and the config
node.

Two channels reach a family and they are deliberately not the same thing:

* ``ext`` — the **model layer**: whatever the caller put in ``ext_params``, plus
  this implementation's own reading of the keys it recognises.  A family
  declares which keys it understands (:data:`EXT`), and the dispatcher hands it
  exactly those.  The spec defines no field in here.
* ``options`` — **deployment tuning**: values an operator writes in
  ``hamdraw_settings.json`` on that one machine.  They never travel over HTTP.

第三个入口 ``accelerator`` 是 2026-10-01 加的, 性质与 ``options`` 相同（部署侧的
东西, 不走 HTTP），但它带**一个类别自己那一份** —— 加速档案是按类别配的, 而
``render`` 与 ``generate`` 共用一个家族。家族要用它就先声明 :data:`ACCELERATOR`,
没声明的家族连这个参数都收不到。
"""

from __future__ import annotations

from typing import Any

from . import checkpoint
from . import qwen_image

#: Explicit on purpose.  Two families do not need a registry, a decorator or an
#: import-time scan; a reader can see every family in one screen.
FAMILIES: dict[str, Any] = {
    "checkpoint": checkpoint,
    "qwen_image_21": qwen_image,
}


def get(name: str) -> Any:
    module = FAMILIES.get(str(name or "").strip())
    if module is None:
        raise ValueError("unsupported_category")
    return module


def _declared(module: Any, attribute: str, values: dict[str, Any]) -> dict[str, Any]:
    """Hand a family only the knobs it declared, and nothing else."""
    return {key: values[key] for key in getattr(module, attribute, ()) if key in values}


def _profile_of(module: Any, accelerator: Any) -> dict[str, Any]:
    """Normalise one category's acceleration profile, or ``{}`` if it has none.

    只交给声明了 ``ACCELERATOR`` 的家族, 而且 ``lora`` 与 ``sigmas`` 缺一不可 ——
    少任何一半都构不成"加速", 交一个半成品给家族只会让它自己再判一遍。
    """
    if not getattr(module, "ACCELERATOR", False):
        return {}
    raw = accelerator if isinstance(accelerator, dict) else {}
    lora = str(raw.get("lora") or "").strip()
    sigmas = [float(value) for value in (raw.get("sigmas") or [])]
    if not lora or len(sigmas) < 2:
        return {}
    return {"lora": lora,
            "strength": float(raw.get("strength", 1.0)),
            "steps": len(sigmas) - 1,
            "sigmas": sigmas}


def build(
    *,
    spec: dict[str, Any],
    models: dict[str, Any],
    sampling: dict[str, Any],
    image: str,
    mask: str = "",
    prompt: str = "",
    seed: int = 0,
    size: list[int] | tuple[int, int],
    ref_strength: float,
    ext: dict[str, Any] | None = None,
    options: dict[str, Any] | None = None,
    accelerator: dict[str, Any] | None = None,
    filename_prefix: str = "hamdraw/hamdraw",
) -> dict[str, Any]:
    """Build the graph for one already-validated request.

    ``spec`` comes from the category table, so the category and the resolution
    were checked before anything here runs; this function's only job is picking
    the family and shaping the arguments.

    The step count is read from ``ext`` here rather than in the HTTP layer
    because the enumeration belongs to the category, and the default belongs to
    it too (``fast`` 8, ``inpaint`` 6, …).  An unknown or out-of-range step is
    still refused — that is this implementation's behaviour for the one
    extension key it recognises, and the spec's error table says so.

    **客户端没发 ``step`` 时, 默认步数取加速档案自己那一档**（若这台机器配了加速
    档案）—— 因为那才是这条链路实际上会跑的东西。类别表里那个 ``steps.default`` 是
    "没有加速档案时的正经挡位", 拿它当默认会让一台配好加速的机器默认跑在 20 步上,
    而客户端以为自己拿到的是最快的那条路。
    """
    from .. import capabilities as capabilities_module

    module = get(spec["family"])
    known = _declared(module, "EXT", dict(ext or {}))
    profile = _profile_of(module, accelerator)
    name = str(spec["category"])

    requested = known.get("step")
    if requested is None and profile:
        step = int(profile["steps"])
        # 档案自己那一档必须也在枚举里, 否则它就是个客户端永远说不出、服务端又默认
        # 去跑的数 —— 那种不一致只会在某天被误当成"步数校验坏了"。
        step = capabilities_module.validate_step(name, step)
    else:
        step = capabilities_module.validate_step(name, requested)

    arguments: dict[str, Any] = {
        "models": dict(models or {}),
        "image": str(image),
        "masked": bool(spec["needs"].get("mask")),
        "mask": str(mask or "") if spec["needs"].get("mask") else "",
        "prompt": str(prompt or ""),
        "negative_prompt": str(known.get("negative_prompt") or ""),
        "seed": int(seed),
        "step": step,
        "size": (int(size[0]), int(size[1])),
        "sampling": dict(sampling or {}),
        "ref_strength": float(ref_strength),
        "filename_prefix": str(filename_prefix),
        **_declared(module, "OPTIONS", dict(options or {})),
    }
    if profile:
        arguments["accelerator"] = profile
    return module.build(**arguments)


__all__ = ["FAMILIES", "build", "get"]
