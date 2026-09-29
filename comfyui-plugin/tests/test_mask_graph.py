#!/usr/bin/env python3
"""对 checkpoint.build 的 masked 图做结构断言（离线，stub 同 test_spec）。"""
import sys
import types
import inspect
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _stub(name, **attributes):
    if name in sys.modules:
        return
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules[name] = module


_stub("aiohttp", ClientSession=object, ClientTimeout=object, web=types.SimpleNamespace())
_stub("folder_paths",
      get_filename_list=lambda folder: [],
      get_annotated_filepath=lambda name: name,
      get_input_directory=lambda: "/tmp",
      get_output_directory=lambda: "/tmp",
      get_temp_directory=lambda: "/tmp")
_stub("nodes", SaveImage=type("SaveImage", (), {}))

from hamdraw_chp import families  # noqa: E402
from hamdraw_chp.families import checkpoint  # noqa: E402

g = checkpoint.build(
    models={"checkpoint": "DreamShaper8_LCM.safetensors"},
    image="hamdraw/ref.jpg", masked=True, mask="hamdraw/mask.png",
    prompt="test", seed=1, step=6, size=(512, 512), sampling={},
    ref_strength=0.5)

ids = [g[n]["class_type"] for n in g]
assert "VAEEncodeForInpaint" not in ids, "VAEEncodeForInpaint 的 round 灰化正是硬边根因，不得再用"
assert g["4"]["class_type"] == "VAEEncode" and g["4"]["inputs"]["pixels"] == ["3", 0], \
    "蒙版重绘必须编码未经灰化的参考图: 灰底会让模型在灰块上作画, 蒙版内近半像素变成低饱和灰"
assert not any(g[n]["class_type"] in ("SolidMask", "MaskToImage", "ImageCompositeMasked") for n in g), \
    "任何形式的灰化都要不得: 连续灰化同样留下灰色光晕"
assert g["13"]["class_type"] == "SetLatentNoiseMask" and g["13"]["inputs"]["mask"] == ["11", 0]
assert g["7"]["inputs"]["latent_image"] == ["13", 0], "采样器拿到的是挂了连续噪声蒙版的 latent"
# `grow_mask_by` 曾是一条"播报、夹边界、传下来、没人用"的死参数：外扩在客户端做
# （providers.js 把笔迹加粗），服务端膨胀会把羽化边重新压平。整条链路已删，这里钉住
# 它不许回来 —— 原来的写法是断言 `g["4"]["inputs"]` 里没有它，参数一删那条就永远红不了，
# 所以改成直接钉签名：加回来就红。
assert "grow_mask_by" not in inspect.signature(checkpoint.build).parameters, \
    "checkpoint.build 的 grow_mask_by 已删，不许再加回来"
assert "grow_mask_by" not in inspect.signature(families.build).parameters, \
    "families.build 的 grow_mask_by 已删，不许再加回来"
# `steps` 这一轮改名 `step` 并搬进扩展通道（ext_params）：两个签名上都不该再有旧名，
# 而"改完名之后还有没有人读它"要另一条断言管 —— 见下面的 g3。
assert "steps" not in inspect.signature(checkpoint.build).parameters, \
    "checkpoint.build 的 steps 已改名 step，不许留旧名"
assert "steps" not in inspect.signature(families.build).parameters, \
    "families.build 的 steps 已搬进 ext_params，不许再是形参"
# 改名最怕的是"接上了但没人读"：step 必须真的落进采样器，而且不能是别处的默认值串味。
g3 = checkpoint.build(
    models={"checkpoint": "DreamShaper8_LCM.safetensors"}, image="hamdraw/ref.jpg",
    masked=False, prompt="t", seed=1, step=4, size=(512, 512), sampling={}, ref_strength=0.5)
assert g3["7"]["inputs"]["steps"] == 4, \
    f'step 要进 KSampler，得到 {g3["7"]["inputs"]["steps"]}'
assert g3["7"]["inputs"]["seed"] == 1 and g3["7"]["inputs"]["latent_image"] == ["4", 0], \
    "非蒙版图里采样器直接吃编码后的 latent"

g2 = checkpoint.build(
    models={"checkpoint": "DreamShaper8_LCM.safetensors"}, image="hamdraw/ref.jpg",
    masked=False, prompt="t", seed=1, step=6, size=(768, 768), sampling={}, ref_strength=0.5)
assert g2["4"]["class_type"] == "VAEEncode" and "16" not in g2, "非蒙版图不含灰化支路"

# 节点 3 是 crop:"disabled" 的**硬框**：参考图的形状和这个框不一致就是拉伸，而且成图上
# 完全看不出来 —— 画幅是对的，画面被压扁了。这里的断言分两半：判据本身，和"它确实接在
# build 上"。只断前半句会漏掉"函数算得对但没人调用"。
assert checkpoint.reference_canvas((512, 512)) == (512, 512)
assert checkpoint.reference_canvas((2048, 2048)) == (1024, 1024), "2048 的任务按 1024 编码，之后再放大 latent"
assert checkpoint.reference_canvas((2048, 1024)) == (1024, 1024), "上下限是分别夹的：这道闸能改形状，不只是改大小"

assert checkpoint.reference_fits(None, (512, 512)) is True, "量不到就放行 —— 这是示警，不是闸门"
assert checkpoint.reference_fits((512, 512), (512, 512)) is True
assert checkpoint.reference_fits((576, 384), (512, 512)) is False, "4:3 的参考图进 1:1 的任务就是拉伸"
assert checkpoint.reference_fits((384, 576), (512, 512)) is False
assert checkpoint.reference_fits((2048, 2048), (2048, 2048)) is True, "2048 的任务按 1024 编码，比例没变就仍然合适"
assert checkpoint.reference_fits((1024, 1024), (2048, 1024)) is True, "2048×1024 的任务被夹成 1024×1024，方形参考图才是对的"
assert checkpoint.reference_fits((2048, 1024), (2048, 1024)) is False, "夹过之后比例变了，和任务同形状的参考图反而不合适"

_reader, _fired = checkpoint.reference_pixels, False
try:
    checkpoint.reference_pixels = lambda image: (576, 384)
    try:
        checkpoint.build(models={"checkpoint": "x.safetensors"}, image="hamdraw/ref.jpg", masked=False,
                         prompt="t", seed=1, step=6, size=(512, 512), sampling={}, ref_strength=0.5)
    except ValueError as error:
        _fired = str(error) == "stretched_reference"
        assert _fired, "形状不符必须报 stretched_reference，实际是 " + str(error)
    assert _fired, "形状不符的参考图必须被 build 拒绝，否则插件会默默把它拉伸"
    checkpoint.reference_pixels = lambda image: (512, 512)
    checkpoint.build(models={"checkpoint": "x.safetensors"}, image="hamdraw/ref.jpg", masked=False,
                     prompt="t", seed=1, step=6, size=(512, 512), sampling={}, ref_strength=0.5)
finally:
    checkpoint.reference_pixels = _reader

print("test-mask-graph: ok (无灰化, 原图直接编码 + 连续噪声蒙版; 参考图形状不符即拒绝)")
