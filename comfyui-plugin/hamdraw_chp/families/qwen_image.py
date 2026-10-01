"""The Qwen-Image 2.1 family: a diffusion model + text encoder + VAE triple.

这个家族服务**两个类别**, 而它们的区别来自模型自己、不是来自实现:

* **``render``（``txt-ref-2-img``）** —— 参考图与提示词一起进编码器, 再作为 reference
  latent 拼进序列, 这就是参考图编辑。
* **``generate``（``txt-2-img``）** —— 纯文生图。核心节点 ``TextEncodeQwenImage21`` 的
  ``images`` 输入 ``min = 0``, 空着是它明确支持的路径, 所以这里不需要拿一张白图去凑;
  而不带参考图时**不建** LoadImage / ImageScaleToTotalPixels / ImageBlur 那一串。

采样永远从空 latent 起步、``denoise = 1``(见下面对 ref_strength 的说明)。

**★ 加速档案（2026-10-01 新增）** —— 这是本家族跟别的家族唯一的形状差别。

Qwen-Image 2.1 有四支"少步数"蒸馏 LoRA（PDD 4 步 / Pruna 8 步 / Viggle 6 步…）。实测
结论写在技能 ``a1x-comfy-device`` §4.18 里, 一句话是: **它们不省时间, 买的是"4 步别糊"**。
要挂它们, 图必须换两处, 而两处都属于"实现细节"、不属于契约:

1. 加速 LoRA 插在 ``UNETLoader`` 之后、``QwenImage21Cache`` 之前（``LoraLoaderModelOnly``）;
2. **sigma 表必须显式给** —— 本机 QwenImage 走 ``ModelSamplingFlux``, ``KSampler=simple``
   出的是位移表（4 步 ``[1.0, 0.90453, …, 0.0]``）, 与 PDD 训练用的那张不同。所以要把
   ``KSampler`` 换成 ``KSamplerSelect + ManualSigmas + RandomNoise + CFGGuider →
   SamplerCustomAdvanced`` 这五件套。

档案从部署侧（``hamdraw_settings.json`` 的 ``accelerators``）交进来, 不走 HTTP。它只在
**自己那档步数**上成立 —— sigma 表的长度就是它的步数加一, 对不上就不挂 LoRA、
老老实实走 ``KSampler``。所以一个客户端把 ``ext_params.step`` 改成别的数, 拿到的是
"没有加速的这张图", 而不是"挂着一份用错的 sigma 表的图"。

This is a *reference-conditioned* generator, not img2img, and that changes what
the reference-strength knob has to mean.  Sampling always starts from an empty
latent at ``denoise = 1`` and the reference picture is spliced into the token
sequence, so there is no encoded reference latent to keep — "denoise less" has
nothing to hold on to.  The family therefore applies the same knob to the
reference itself: it softens the picture by an amount that grows as the strength
falls, which is as close as this model gets to being told to stop copying the
composition.

The direction is the same as the checkpoint family's ("higher = closer to the
reference"), which is all the contract asks for: the mechanism is free.
"""

from __future__ import annotations

from typing import Any

from ..capabilities import REF_STRENGTH_RANGE
from . import graph

#: Model roles this family needs configured.
ROLES: tuple[str, ...] = ("unet", "clip", "vae")

#: Extra knobs this family takes from the settings file.  Declared so the
#: dispatcher can hand a family its own options and nothing else.
OPTIONS: tuple[str, ...] = ("cache_device", "cache_dtype", "reference_edge")

#: This family can be handed an acceleration profile.  The dispatcher passes
#: one only to families that say so here — a family with no use for it never
#: sees an argument it cannot name.
ACCELERATOR = True

#: Extension keys this family understands, out of the caller's ``ext_params``.
#: Same pair as the checkpoint family; ``step`` is this implementation's own key,
#: so its enumeration and default live in the category table.
EXT: tuple[str, ...] = ("step", "negative_prompt")

#: The Qwen text encoder is loaded through ``CLIPLoader`` with this type.
CLIP_TYPE = "qwen_image"

#: How much a reference may be softened when the strength is turned down.
#: ``ImageBlur`` caps ``blur_radius`` at 31 and ``sigma`` at 10.
FADE_MAX = 0.85
BLUR_RADIUS_MAX = 31
BLUR_SIGMA_MAX = 10.0

#: 参考图送进编码器之前缩到多大。原生引擎管这一项叫 ``reference_resolution``, 语义是
#: "约 edge × edge 像素"的面积预算(保持比例、对齐到 32), 核心节点自己就是这么算的。
#: 这里的默认值取核心节点的默认值(1024)：出厂默认不带部署选择, 哪台机器想省算力就在
#: ``hamdraw_settings.json`` 的 ``families.qwen_image_21.reference_edge`` 里写小一点。
#: **它不影响出图画幅** —— 画幅由能力表的 size 域和客户端选的那个值决定。
REFERENCE_EDGE = 1024
REFERENCE_EDGE_RANGE = (128, 2048)

#: 核心节点 ``TextEncodeQwenImage21`` 把参考图对齐到这个步长(它自己的 step 就是 32)。
#: 我们的预缩也对齐到同一档, 于是它拿到手就是它自己会算的那个尺寸, 不再缩第二次。
REFERENCE_STEP = 32


def clamped_edge(raw: Any, fallback: float = REFERENCE_EDGE) -> int:
    """设置文件里那一项是文本(见 settings.family_options), 所以这里自己收口。

    名字不能叫 ``reference_edge`` —— 那是 ``build`` 的同名参数, 会把这层遮掉。
    """
    low, high = REFERENCE_EDGE_RANGE
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        value = int(fallback)
    return int(min(max(value, low), high))


def reference_megapixels(edge: int) -> float:
    """「约 edge × edge 像素」换算成**面积预算** —— 核心节点自己就是这么解释 ``resolution`` 的。

    参考图只能按面积缩: 给一个硬目标框(``ImageScale``)就必然要在比例不符时拉伸, 而定妆照
    是 9:16, 用户手上那张老照片可能是 3:4, 两者都不该被压进画幅的比例里 —— 生图画幅已经
    由采样 latent 定死了(见 capabilities 的 size 域), 参考图只管"长什么样"。
    """
    return round(edge * edge / (1024.0 * 1024.0), 4)


def reference_fade(ref_strength: float) -> float:
    """How far the reference is softened before it reaches the encoder.

    Measured on the reference box: asking this model for a partial denoise over a
    reference latent makes it hand the latent back almost untouched (0.45 and
    even 0.70 came back as the reference with a slight blur, only 0.95 really
    repainted).  So the knob moves to the reference instead.

    The blur is deliberately *not* a blend towards a flat grey — that tinted the
    whole render, because the model happily painted the grey back out as a
    washed-out background.
    """
    low, high = REF_STRENGTH_RANGE
    span = high - low
    normalized = (max(low, min(high, float(ref_strength))) - low) / span
    return round(FADE_MAX * (1.0 - normalized), 3)


def _reference_blur(fade: float) -> dict[str, Any]:
    """The blur that turns a fade amount into ``ImageBlur`` settings.

    ``blur_radius`` only goes up to 31, so the radius and the sigma are moved
    together: a wide radius on its own rings around the edges of a 1024 px
    picture, and a large sigma on its own leaves a visible ghost of the original
    silhouette, which is exactly the thing a low strength is trying to remove.
    """
    radius = int(round(1 + fade * (BLUR_RADIUS_MAX - 1)))
    sigma = round(0.1 + fade * (BLUR_SIGMA_MAX - 0.1), 1)
    return {"class_type": "ImageBlur",
            "inputs": {"image": ["11", 0], "blur_radius": radius, "sigma": sigma},
            "_meta": {"title": "HamDraw reference strength"}}


def sigma_text(values: Any) -> str:
    """把一张 sigma 表写成 ``ManualSigmas`` 吃的那种逗号串。

    ``repr`` 而不是 ``%.4f``: PDD 那张表是 ``0.9169867038726807`` 这种带着训练时的
    全精度的数, 截到四位小数就等于自己改了厂商的调度表 —— 而改动之后出图只是"略微
    不一样", 没人看得出来。
    """
    return ", ".join(repr(float(value)) for value in values)


def build(
    *,
    models: dict[str, Any],
    image: str,
    masked: bool = False,
    mask: str = "",
    prompt: str = "",
    negative_prompt: str = "",
    seed: int = 0,
    # 扩展参数，所以带默认值：真正的默认值按类别取自类别表，由 dispatcher 交进来；
    # 这个数是直接调用本函数时的兜底。
    step: int = 20,
    size: tuple[int, int],
    sampling: dict[str, Any],
    ref_strength: float,
    cache_device: str = "auto",
    cache_dtype: str = "default",
    reference_edge: Any = REFERENCE_EDGE,
    # 部署侧的加速档案: ``{lora, strength, steps, sigmas}``，空表 = 不加速。
    accelerator: dict[str, Any] | None = None,
    filename_prefix: str = "hamdraw/hamdraw",
) -> dict[str, Any]:
    """A graph that mirrors the model's own contract rather than pretending it is
    an ordinary checkpoint: ``UNETLoader`` + ``CLIPLoader(type=qwen_image)`` +
    ``VAELoader`` feed the KV-cache wrapper, ``TextEncodeQwenImage21`` turns
    prompt, negative prompt and — when there is one — the reference picture into
    a conditioning pair, and the sampler runs from an empty latent at
    ``denoise = 1``.

    ``image`` 为空就是纯文生图（``generate`` 那条规则）: 不建 LoadImage /
    ImageScaleToTotalPixels / ImageBlur, 也不给节点挂参考图输入。这不是特例分支, 而是
    这个模型本来就支持的两种用法之一 —— 两个类别共用这一个 builder, 正是因为它俩
    只差"有没有那张图"。

    带参考图时先按 ``reference_edge`` 把图缩到"约 edge² 像素"(按面积缩, **保持源图自己的
    比例**), 再把这个 edge 作为 ``resolution`` 交给它 —— 于是它拿到手就不会再缩第二次。
    画幅**不来自参考图**: 它由采样 latent 决定, 参考图只提供"长什么样"。

    ``accelerator`` 非空且它自己的步数正好等于 ``step`` 时, 图里多两样东西: 一个
    ``LoraLoaderModelOnly``, 以及用 ``ManualSigmas`` 顶掉 ``KSampler`` 的
    ``SamplerCustomAdvanced`` 五件套。理由见模块开头。**只在这一档步数上成立**: sigma
    表的长度就是它的步数加一, 对不上就整条不生效, 而不是拿一张用错的表去采样。
    """
    if masked:
        # The category declares needs.mask false, so the HTTP layer never
        # routes a mask here.  Refusing beats quietly ignoring one.
        raise ValueError("bad_mask")

    files = dict(models or {})
    unet = str(files.get("unet") or "").strip()
    clip = str(files.get("clip") or "").strip()
    vae = str(files.get("vae") or "").strip()
    if not (unet and clip and vae):
        raise ValueError("no_model")

    profile = dict(accelerator or {})
    sigmas = [float(value) for value in (profile.get("sigmas") or [])]
    accelerated = bool(str(profile.get("lora") or "").strip()) and len(sigmas) >= 2 \
        and len(sigmas) - 1 == int(step)

    width, height = int(size[0]), int(size[1])
    fade = reference_fade(ref_strength)
    reference = bool(str(image or "").strip())
    # 参考图永远不会被放大到比画布还大: 那既不会多出细节, 又要多算一遍。
    edge = min(clamped_edge(reference_edge, REFERENCE_EDGE), max(width, height))

    # 加速时模型链条多一跳: UNETLoader → LoRA → 缓存 → 采样。
    model_source: list[Any] = ["1a", 0] if accelerated else ["1", 0]

    nodes: dict[str, Any] = {
        "9": graph.output_node(["8", 0], filename_prefix),
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "6": {"class_type": "EmptyLatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "5": {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {
                "clip": ["2", 0],
                "prompt": str(prompt or ""),
                "negative_prompt": str(negative_prompt or ""),
                # 有参考图时这个数是它被编码到的面积预算; 没有参考图时它只决定节点那个
                # **用不到的**空 latent(我们的采样 latent 来自 "6"), 所以照画幅给。
                "resolution": edge if reference else max(width, height),
                "vae": ["3", 0],
            },
            "_meta": {"title": "HamDraw prompt and reference"},
        },
        "4": {"class_type": "QwenImage21Cache",
              "inputs": {"model": model_source, "device": str(cache_device or "auto"),
                         "dtype": str(cache_dtype or "default")},
              "_meta": {"title": "HamDraw text cache"}},
        "3": graph.vae_node(vae),
        "2": graph.clip_node(clip, CLIP_TYPE),
        "1": graph.unet_node(unet),
    }
    if accelerated:
        nodes["7"] = {
            "class_type": "SamplerCustomAdvanced",
            "inputs": {"noise": ["7c", 0], "guider": ["7d", 0], "sampler": ["7a", 0],
                       "sigmas": ["7b", 0], "latent_image": ["6", 0]},
            "_meta": {"title": "HamDraw sampler"},
        }
        nodes["7a"] = {"class_type": "KSamplerSelect",
                       "inputs": {"sampler_name": str(sampling.get("sampler") or "euler")},
                       "_meta": {"title": "HamDraw sampler kind"}}
        nodes["7b"] = {"class_type": "ManualSigmas", "inputs": {"sigmas": sigma_text(sigmas)},
                       "_meta": {"title": "HamDraw sigma schedule"}}
        nodes["7c"] = {"class_type": "RandomNoise", "inputs": {"noise_seed": int(seed)},
                       "_meta": {"title": "HamDraw noise"}}
        nodes["7d"] = {"class_type": "CFGGuider",
                       "inputs": {"model": model_source, "positive": ["5", 0],
                                  "negative": ["5", 1],
                                  "cfg": float(sampling.get("cfg", 1.0))},
                       "_meta": {"title": "HamDraw guidance"}}
        nodes["1a"] = {"class_type": "LoraLoaderModelOnly",
                       "inputs": {"model": ["1", 0],
                                  "lora_name": str(profile["lora"]).strip(),
                                  "strength_model": float(profile.get("strength", 1.0))},
                       "_meta": {"title": "HamDraw accelerator"}}
    else:
        nodes["7"] = graph.sampler(model_source, ["5", 0], ["5", 1], ["6", 0], seed, step,
                                   sampling, 1.0)
    if reference:
        # "10" loads the picture, "11" shrinks it to the reference budget, and "12"
        # is what the encoder actually sees: "11" as it is, or "11" softened by
        # the strength knob.  The soften step must live on its own id — reading
        # "11" and writing "11" is a dependency cycle and ComfyUI rejects the
        # whole prompt with "Dependency cycle detected".
        #
        # "11" 必须是 scale_to_pixels 而**不是** graph.scale: 后者吃硬目标框, 比例不符时
        # 会把定妆照拉变形, 而变形之后从图上完全看不出来(画幅是对的, 脸被拉长了)。
        nodes["5"]["inputs"]["images.image_1"] = ["12", 0] if fade > 0 else ["11", 0]
        nodes["10"] = graph.load_image(image, "HamDraw reference")
        nodes["11"] = graph.scale_to_pixels(["10", 0], reference_megapixels(edge), REFERENCE_STEP)
        if fade > 0:
            nodes["12"] = _reference_blur(fade)
    return nodes


__all__ = ["ACCELERATOR", "CLIP_TYPE", "OPTIONS", "REFERENCE_EDGE", "ROLES", "build",
           "clamped_edge", "reference_fade", "reference_megapixels", "sigma_text"]
