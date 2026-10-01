"""Nodes for the HamDraw ComfyUI plugin.

``HamDrawConfig`` is the one node a user has to touch: it stores the shared
password, the checkpoint each category uses, the three files the Qwen categories
need (a diffusion model, a text encoder and a VAE — ``render`` and ``generate``
run the same one), the accelerator LoRA each of those two runs with, and the
address of the translator.  Queueing it once writes ``hamdraw_settings.json``
next to the plugin, so the HTTP API picks the values up immediately without
restarting ComfyUI.

The graphs themselves are built by :mod:`hamdraw_chp.families`, not here:
the HTTP layer is the only entry point, and it always uses those built-in
graphs.  ``HamDrawInput`` / ``HamDrawOutput`` are the two node classes those
graphs reference — a reader can put them in a window and see what HamDraw
hands an ordinary ComfyUI checkpoint — but nothing patches a user-supplied
workflow any more.
"""

from __future__ import annotations

from typing import Any

import folder_paths
import nodes

from . import capabilities as capabilities_module
from . import settings as settings_module
from .families.qwen_image import sigma_text

SAME_AS_FAST = "(same as fast)"

#: Taken from the category table rather than written out again, so the range
#: the node shows is the range the HTTP layer accepts.
REFERENCE_LOW, REFERENCE_HIGH = capabilities_module.REF_STRENGTH_RANGE
REFERENCE_DEFAULT = float(capabilities_module.CATEGORY_TABLE["fast"]["defaults"]["ref_strength"])

#: 加速 LoRA 的强度区间 —— 与 settings 里那道收口同源, 节点上旋不出去的数服务端也不会收。
ACCELERATOR_LOW, ACCELERATOR_HIGH = settings_module.ACCELERATOR_STRENGTH_RANGE


def _checkpoint_choices() -> list[str]:
    return _folder_choices("checkpoints")


def _folder_choices(folder: str) -> list[str]:
    try:
        return [str(name) for name in folder_paths.get_filename_list(folder)]
    except Exception:
        return []


def _choice_list() -> list[str]:
    choices = _checkpoint_choices()
    return [SAME_AS_FAST] + choices if choices else [SAME_AS_FAST]


def _fast_default(choices: list[str]) -> str:
    available = [name for name in choices if name != SAME_AS_FAST]
    recommended = settings_module.RECOMMENDED_CHECKPOINT
    if recommended in available:
        return recommended
    return available[0] if available else SAME_AS_FAST


def _resolve(value: str) -> str:
    text = str(value or "").strip()
    return "" if text == SAME_AS_FAST else text


class HamDrawConfig:
    """Store the plugin password, the checkpoints, the Qwen model triple and the translator address."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        choices = _choice_list()
        stored = settings_module.load()
        translation = settings_module.translate()
        triple: dict[str, str] = {}
        for name in settings_module.TRIPLE_TASKS:
            for role, value in settings_module.model_files(name).items():
                triple.setdefault(role, str(value or ""))
        fast_choices = [name for name in choices if name != SAME_AS_FAST]
        stored_fast = str(stored["checkpoints"].get("fast") or "").strip()
        loras = [""] + _folder_choices("loras")
        optional: dict[str, Any] = {
            "translate_prompts": ("BOOLEAN", {"default": bool(translation["enabled"])}),
            "translator_url": ("STRING", {"default": str(translation["url"] or ""), "multiline": False}),
            "qwen_unet": (_folder_choices("diffusion_models") or [""], {"default": str(triple.get("unet") or "")}),
            "qwen_text_encoder": (_folder_choices("text_encoders") or [""], {"default": str(triple.get("clip") or "")}),
            "qwen_vae": (_folder_choices("vae") or [""], {"default": str(triple.get("vae") or "")}),
        }
        # 加速档: 每个"三件套"类别一组（LoRA 文件 / 强度 / sigma 表）。分组而不是共用
        # 一组, 因为 render 与 generate 选的正是**不同的**两支加速 LoRA —— 那正是把这
        # 两个类别分开的原因之一。留空 = 这台机器不加速。
        for name in settings_module.TRIPLE_TASKS:
            profile = settings_module.accelerator(name)
            sigmas = profile.get("sigmas") or []
            optional[f"{name}_lora"] = (loras, {"default": str(profile.get("lora") or "")})
            optional[f"{name}_lora_strength"] = (
                "FLOAT", {"default": float(profile.get("strength", 1.0)),
                          "min": ACCELERATOR_LOW, "max": ACCELERATOR_HIGH, "step": 0.05})
            optional[f"{name}_sigmas"] = (
                "STRING", {"default": sigma_text(sigmas), "multiline": True})
        return {
            "required": {
                "password": ("STRING", {"default": str(stored.get("password") or ""), "multiline": False}),
                "fast_checkpoint": (fast_choices or [SAME_AS_FAST], {"default": stored_fast or _fast_default(choices)}),
                "inpaint_checkpoint": (choices, {"default": _resolve(stored["checkpoints"].get("inpaint", "")) or SAME_AS_FAST}),
                "upscale_checkpoint": (choices, {"default": _resolve(stored["checkpoints"].get("upscale", "")) or SAME_AS_FAST}),
            },
            # Optional so a graph saved before these existed still loads: the
            # Qwen triple and the accelerators are later arrivals, and an older
            # graph must not blank out a configuration written by hand.
            "optional": optional,
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("status",)
    FUNCTION = "apply"
    CATEGORY = "HamDraw"
    DESCRIPTION = (
        "Write the HamDraw password, checkpoints, the Qwen model triple, the accelerator LoRAs and the translator address. "
        "Queue this node once after every change; leaving the password empty disables authentication and lets anyone on your "
        "network draw. Set the HAMDRAW_PASSWORD environment variable instead to keep the password out of the graph. "
        "The translator turns a prompt a text encoder cannot read into English; it runs when a job is submitted, so a client "
        "that sends Chinese still gets a picture. Leave its address empty to switch it off. "
        "The three model fields configure both 参考图重绘 (render) and 纯文生图 (generate) — they run the same diffusion "
        "model, text encoder and VAE, and all three must be set before either can run. "
        "The accelerator fields take a few-step distillation LoRA (PDD 4-step, Viggle 6-step …) plus the exact sigma "
        "schedule it was distilled against: the schedule's length is the step count it applies at (N+1 numbers = N steps). "
        "Leave the LoRA empty to run without one. See the plugin README for the numbers to paste in."
    )
    OUTPUT_NODE = True

    def apply(
        self,
        password: str,
        fast_checkpoint: str,
        inpaint_checkpoint: str,
        upscale_checkpoint: str,
        translate_prompts: bool | None = None,
        translator_url: str | None = None,
        qwen_unet: str | None = None,
        qwen_text_encoder: str | None = None,
        qwen_vae: str | None = None,
        **accelerators: Any,
    ) -> tuple[str]:
        patch: dict[str, Any] = {
            "password": str(password or ""),
            "checkpoints": {
                "fast": str(fast_checkpoint or "").strip(),
                "inpaint": _resolve(inpaint_checkpoint),
                "upscale": _resolve(upscale_checkpoint),
            },
        }
        # Only write the Qwen triple when the node actually carried it: a graph
        # saved before those widgets existed must not blank out a configuration
        # that was written from a settings file.  The same three files go to
        # **every** triple category, because that is the truth — render and
        # generate run one diffusion model, not two.
        if qwen_unet is not None or qwen_text_encoder is not None or qwen_vae is not None:
            triple = {
                "unet": str(qwen_unet or "").strip(),
                "clip": str(qwen_text_encoder or "").strip(),
                "vae": str(qwen_vae or "").strip(),
            }
            patch["models"] = {name: dict(triple) for name in settings_module.TRIPLE_TASKS}
        profile_patch: dict[str, Any] = {}
        for name in settings_module.TRIPLE_TASKS:
            lora = accelerators.get(f"{name}_lora")
            if lora is None:
                continue
            profile_patch[name] = {
                "lora": str(lora or "").strip(),
                "strength": accelerators.get(f"{name}_lora_strength"),
                "sigmas": str(accelerators.get(f"{name}_sigmas") or "").strip(),
            }
        if profile_patch:
            patch["accelerators"] = profile_patch
        if translate_prompts is not None or translator_url is not None:
            patch["translate"] = {"enabled": True if translate_prompts is None else bool(translate_prompts)}
            # No default address exists on purpose: an older graph without the
            # widget must not overwrite whatever the operator configured, and a
            # fresh install starts with translation switched off rather than
            # pointed at some other machine's port.
            if translator_url is not None:
                patch["translate"]["url"] = str(translator_url).strip()
        saved = settings_module.update(**patch)
        environment = settings_module.password()
        if environment:
            protection = "密码来自 HAMDRAW_PASSWORD 环境变量"
        elif saved["password"]:
            protection = "已启用密码保护"
        else:
            protection = "未设密码，局域网内任何人都可以出图"
        translation = settings_module.translate()
        if translation["enabled"]:
            translating = f"中文自动译英 → {translation['url']}"
        else:
            translating = "翻译已关闭，需要英文提示词的类别将收到原文"
        states = []
        for name in settings_module.TRIPLE_TASKS:
            files = settings_module.model_files(name)
            profile = settings_module.accelerator(name)
            model = files.get("unet") if all(files.values()) else "未选"
            speed = f"{len(profile['sigmas']) - 1} 步加速" if profile else "未加速"
            states.append(f"{name} {model}/{speed}")
        return (f"CHP 插件设置已保存 · 快速 {saved['checkpoints']['fast'] or '未选'} · "
                f"{' · '.join(states)} · {translating} · {protection}",)


class HamDrawInput:
    """The semantic inputs a HamDraw graph starts from, as an ordinary node.

    A peeking node, not part of the HTTP contract: the graphs the API runs are
    built by :mod:`hamdraw_chp.families` and do not route through this class, so
    its widgets are free to be plain controls.  ``ref_strength`` is the one that
    must not drift — it is the same knob the contract fixes, so its bounds are
    read from the category table rather than written out here again (they had
    drifted, 0–2.0 against a contract of 0.05–0.95).
    """

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "negative_prompt": ("STRING", {"default": "", "multiline": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 9007199254740991}),
                "ref_strength": ("FLOAT", {"default": REFERENCE_DEFAULT, "min": REFERENCE_LOW,
                                           "max": REFERENCE_HIGH, "step": 0.01}),
                "steps": ("INT", {"default": 8, "min": 1, "max": 150}),
                "width": ("INT", {"default": 512, "min": 16, "max": 2048, "step": 8}),
                "height": ("INT", {"default": 512, "min": 16, "max": 2048, "step": 8}),
                "image_file": ("STRING", {"default": ""}),
                "mask_file": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "IMAGE", "MASK", "INT", "FLOAT", "INT", "INT", "INT")
    RETURN_NAMES = ("prompt", "negative_prompt", "image", "mask", "seed", "ref_strength", "steps", "width", "height")
    FUNCTION = "emit"
    CATEGORY = "HamDraw"

    def emit(
        self,
        prompt: str,
        negative_prompt: str,
        seed: int,
        ref_strength: float,
        steps: int,
        width: int,
        height: int,
        image_file: str,
        mask_file: str,
    ) -> tuple[Any, ...]:
        import torch
        from pathlib import Path

        import numpy as np
        from PIL import Image

        def empty_image() -> Any:
            return torch.zeros((1, 1, 1, 3), dtype=torch.float32)

        def empty_mask() -> Any:
            return torch.zeros((1, 1, 1), dtype=torch.float32)

        def resolve(name: str):
            if not name:
                return None
            try:
                path = Path(folder_paths.get_annotated_filepath(str(name)))
            except Exception:
                return None
            return path if path.is_file() else None

        image_path = resolve(image_file)
        if image_path is None:
            image, image_mask = empty_image(), empty_mask()
        else:
            try:
                loaded = Image.open(image_path).convert("RGB")
                pixels = np.asarray(loaded, dtype=np.float32) / 255.0
                image = torch.from_numpy(pixels)[None, ...]
                image_mask = torch.zeros((1, loaded.height, loaded.width), dtype=torch.float32)
            except Exception:
                image, image_mask = empty_image(), empty_mask()

        mask_path = resolve(mask_file)
        mask = image_mask
        if mask_path is not None:
            try:
                loaded_mask = Image.open(mask_path).convert("L")
                values = np.asarray(loaded_mask, dtype=np.float32) / 255.0
                mask = torch.from_numpy(values)[None, ...]
            except Exception:
                mask = image_mask

        return (
            str(prompt or ""),
            str(negative_prompt or ""),
            image,
            mask,
            int(seed),
            float(ref_strength),
            int(steps),
            int(width),
            int(height),
        )


class HamDrawOutput(nodes.SaveImage):
    """A named SaveImage node used as the unambiguous final output."""

    CATEGORY = "HamDraw"
    DESCRIPTION = "Save the final HamDraw image so the plugin can serve it over HTTP."


NODE_CLASS_MAPPINGS = {
    "HamDrawConfig": HamDrawConfig,
    "HamDrawInput": HamDrawInput,
    "HamDrawOutput": HamDrawOutput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "HamDrawConfig": "HamDraw 配置 (Config)",
    "HamDrawInput": "HamDraw Input",
    "HamDrawOutput": "HamDraw Output",
}
