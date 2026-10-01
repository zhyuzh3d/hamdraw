#!/usr/bin/env python3
"""Offline self-check for the CHP v2 contract.

Runs anywhere — no ComfyUI, no aiohttp, no network, no model files.  The three
things ComfyUI normally provides (``folder_paths``, ``nodes``, ``server``) plus
``aiohttp`` and ``execution`` are stubbed into ``sys.modules`` before the package
is imported: importing ``hamdraw_chp`` runs ``__init__.py``, which pulls in the
node definitions and registers the HTTP routes, and neither is needed to inspect
a document built purely from data.

    python3 tests/test_spec.py

What it locks down (plan §4 P5):

* the document is two tables — ``rules`` says what shape of input a category
  takes, ``abilities`` says which files can run it and which canvases it makes —
  and the eight top-level keys are exactly those eight;
* the rule table: three rules, canonical modality order, split on the literal
  ``-2-``, and the signature / schema key *derived* from the modality list
  (the digit ban v1 needed is gone with it); ``txt-2-img`` (纯文生图) is a rule
  of its own rather than a second use of ``txt-ref-2-img``, and "does this
  category take a reference picture" is read off the modality list instead of
  being declared a second time;
* the frames table: hand-written, ordered, string resolutions, membership
  validation, ``default = first entry``, and the two assembly-time assertions;
* the two extension channels: unknown top-level fields ignored *and named in
  ``job.ignored``*, ``ext_params`` echoed verbatim, ``chp_params.password``
  accepted as a carrier;
* the deletions — no ``aliases`` / ``ignores`` / ``task`` / ``/cvp`` / ``values``
  / ``size_domain`` / ``models.available`` / ``capabilities`` array;
* that the request path is actually driven, not merely inspected: the job record
  and the graph handed to ComfyUI are read back, so an assertion here can tell
  "the switch was read and then dropped" from "the switch took effect";
* the idempotency key: the same ``request_id`` with the same content answers the
  *same job* without queueing or writing a second reference image, a changed body
  under the same key is refused rather than silently dropped, and a submission
  that failed to queue gives its key back.
"""

from __future__ import annotations

import asyncio
import base64
import inspect
import json
import os
import sys
import tempfile
import types
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _stub(name: str, **attributes) -> None:
    """Put a stand-in module in place so the package imports outside ComfyUI."""
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules[name] = module


class FakeResponse:
    """The little of ``aiohttp.web.Response`` a handler's answer needs reading."""

    def __init__(self, payload: Any, status: int = 200) -> None:
        self.payload = payload
        self.status = status
        self.headers: dict[str, str] = {}


def _json_response(payload: Any, status: int = 200, dumps: Any = None) -> FakeResponse:
    # Round-tripping through text is deliberate: it is also the proof that the
    # document really is plain JSON and not a dict that merely looks like one.
    text = (dumps or (lambda value: json.dumps(value)))(payload)
    return FakeResponse(json.loads(text), status)


# translate.py imports aiohttp at module scope; server.py needs aiohttp.web for
# its annotations, which ``from __future__ import annotations`` never evaluates.
_stub("aiohttp", ClientSession=object, ClientTimeout=object,
      web=types.SimpleNamespace(json_response=_json_response, Response=FakeResponse))
# nodes.py imports these; the folder listing is a fixed little catalogue so the
# config node can be exercised without ComfyUI.
_MODEL_FILES = {"checkpoints": ["DreamShaper8_LCM.safetensors", "sd15-realistic.safetensors"]}
_stub("folder_paths",
      get_filename_list=lambda folder: list(_MODEL_FILES.get(folder, [])),
      get_annotated_filepath=lambda name: name,
      get_input_directory=lambda: tempfile.gettempdir(),
      get_output_directory=lambda: tempfile.gettempdir(),
      get_temp_directory=lambda: tempfile.gettempdir())
_stub("nodes", SaveImage=type("SaveImage", (), {}))

#: ComfyUI validates a queued graph before it runs.  The real one is an import
#: of ComfyUI's ``execution`` module; here it accepts anything, because what this
#: file wants to read is the graph the HTTP layer *built*, not ComfyUI's opinion
#: of it.
async def _validate_prompt(prompt_id: str, graph: dict, outputs: list) -> tuple:
    return (True, None, list(outputs), None)


_stub("execution", validate_prompt=_validate_prompt)

# The settings file and the translation memory live next to each other, so
# pointing the first at a scratch directory keeps this run out of the real
# install — and lets the memory test pretend the process restarted.
_SCRATCH = Path(tempfile.mkdtemp(prefix="chp-test-"))
os.environ["HAMDRAW_SETTINGS"] = str(_SCRATCH / "hamdraw_settings.json")
for _name in ("HAMDRAW_PASSWORD", "HAMDRAW_TRANSLATE_URL", "HAMDRAW_TRANSLATE_MODEL"):
    os.environ.pop(_name, None)

from hamdraw_chp import capabilities, families, server, settings, translate, version  # noqa: E402


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def forget_settings() -> None:
    """Drop the scratch settings file so the next test starts from the defaults."""
    settings.path().unlink(missing_ok=True)


#: The name the three checkpoint categories share, which is why they are *one*
#: ability and not three — the grouping is derived from the files, not declared.
SHARED_CHECKPOINT = "DreamShaper8_LCM.safetensors"


def fake_files(category: str, *, checkpoint: str = "", missing: tuple[str, ...] = ()) -> dict[str, Any]:
    """A resolver stand-in: this category's files are installed unless named."""
    entry = capabilities.CATEGORY_TABLE[str(category)]
    if "checkpoint" in entry["roles"]:
        files = {"checkpoint": checkpoint or SHARED_CHECKPOINT}
    else:
        files = {role: f"qwen-{role}.safetensors" for role in entry["roles"]}
    return {"files": files, "ready": not [r for r in missing if r in files],
            "missing": [r for r in missing if r in files]}


def collect_keys(value: Any) -> list[str]:
    """Every key at every depth — so "this field is gone" is checked by name."""
    found: list[str] = []
    if isinstance(value, dict):
        for key, item in value.items():
            found.append(str(key))
            found.extend(collect_keys(item))
    elif isinstance(value, list):
        for item in value:
            found.extend(collect_keys(item))
    return found


def document_of(files_of=fake_files, **overrides: Any) -> dict[str, Any]:
    arguments: dict[str, Any] = {
        "files_of": files_of,
        "authorized": True,
        "auth_required": True,
        "translation": translate.describe(),
        "errors": sorted(server.ERROR_STATUS),
    }
    arguments.update(overrides)
    return capabilities.document(**arguments)


# --------------------------------------------------------------------------- #
# the document
# --------------------------------------------------------------------------- #

TOP_LEVEL_KEYS = {"spec", "plugin", "auth", "endpoints", "rules", "abilities",
                  "input_schemas", "translation"}


def check_information_document() -> None:
    document = document_of()

    # 1) 协议版本在响应体里, 不在路径里; 而且文档播报的版本必须就是源码里的那个数。
    # 比的是 version.__version__ 而不是写死的一份拷贝 —— 写死的那种断言只会随每次
    # 升版本变红, 然后被顺手改成新数字, 而"文档说的"和"源码是的"是不是同一个数恰恰
    # 是它唯一想管的事。(2026-09-29: 它曾钉在 2.4.3 上, 源码升到 2.4.4 后一直红。)
    check(capabilities.SPEC == "chp/2", f"契约版本必须是 chp/2, 得到 {capabilities.SPEC}")
    check(document["spec"] == capabilities.SPEC, "文档要播报契约常量本身, 不是另一份字面量")
    check(document["plugin"]["id"] == capabilities.PLUGIN_ID, "实现的自称是 hamdraw_chp")
    check(document["plugin"]["version"] == version.__version__,
          "文档播报的插件版本必须就是源码里的版本")
    check(document["plugin"]["label"]["zh"] and document["plugin"]["label"]["en"], "自称要双语")

    # 2) 规范规定的八个键一个都不能少; 规范之外只许播报本实现自己的 errors
    check(TOP_LEVEL_KEYS <= set(document),
          f"八个规范键不许少: {sorted(TOP_LEVEL_KEYS - set(document))}")
    check(set(document) - TOP_LEVEL_KEYS <= {"errors"},
          f"规范之外只许 errors, 得到 {sorted(set(document) - TOP_LEVEL_KEYS)}")
    check(set(document_of(errors=[])) == TOP_LEVEL_KEYS,
          "不播报错误码时, 顶层就恰好是那八个")

    # 3) auth 如实反映传入值
    check(document["auth"]["required"] is True and document["auth"]["authorized"] is True,
          "auth 要如实反映传入值")
    check_document_auth_reports_both_states()

    # 4) rules: 五个类别, 同序同集合于类别表, 且 category / rule 是仅有的规范键
    categories = [entry["category"] for entry in document["rules"]]
    check(categories == list(capabilities.CATEGORY_TABLE), f"rules 必须与类别表同序, 得到 {categories}")
    check(categories == ["fast", "inpaint", "upscale", "render", "generate"],
          f"五个场景, 得到 {categories}")
    check("quick" not in categories and "qwen" not in categories, "旧名不许当类别")

    for entry in document["rules"]:
        name = entry["category"]
        internal = capabilities.CATEGORY_TABLE[name]
        check(entry["rule"] in capabilities.RULES, f"{name}: rule 必须在规则表里")
        # signature / input 是从 rule 算出来的, 条目里没有第二份副本。这条断言就是
        # "类别不再自己写 signature" 的判据 —— 一旦有人手抄一份覆盖, 它立刻红。
        check(entry["signature"] == capabilities.signature_of(entry["rule"]),
              f"{name}: signature 必须由 rule 算出来")
        check(entry["input"] == capabilities.input_of(entry["rule"]),
              f"{name}: input 必须由 rule 算出来")
        # 实现细节不许播报给客户端
        check("roles" not in entry and "family" not in entry and "steps" not in entry,
              f"{name}: roles/family/steps 是实现细节, 不许出现在文档里")
        check(set(entry["defaults"]) <= set(document["input_schemas"][entry["input"]]["properties"]),
              f"{name}: defaults 不许出现 schema 里没有的字段")
        check(entry["prompt"]["language"] in ("en", "any"), f"{name}: prompt.language 取值")
        check(set(entry["needs"]) == {"prompt", "image", "mask"}, f"{name}: needs 三项都要有")
        check(internal["family"] in families.FAMILIES, f"{name}: family 必须存在")
        check(set(internal["roles"]) <= set(capabilities.ROLE_FOLDERS), f"{name}: 角色要有目录")

    # 5) abilities: 一组能跑起来的模型文件, 画幅挂在它下面
    abilities = document["abilities"]
    check(len(abilities) == 2, f"checkpoint 一族 + render 一族 = 两条, 得到 {len(abilities)}")
    check(set(abilities[0]["files"]) == {"checkpoint"}, "第一条是 checkpoint 系")
    check(set(abilities[1]["files"]) == {"unet", "clip", "vae"}, "第二条是 Qwen 一族的三件套")
    check(abilities[0]["name"] == fake_files("fast")["files"]["checkpoint"],
          "单 checkpoint 的能力由那个文件命名")
    check(abilities[1]["name"] == capabilities.ABILITY_NAMES["qwen_image_21"],
          "三件套没有单个文件可指, 用家族的实现名")
    for ability in abilities:
        check(ability["ready"] is True and ability["missing"] == [], "解析成功的模型必须 ready")
        for frame in ability["frames"]:
            check(frame["ratio"] and frame["category"], "每一帧要有比例标签与它属于的类别")
            check(all(isinstance(item, str) for item in frame["resolution"]),
                  f"分辨率必须是字符串, 得到 {frame['resolution']}")

    # 6) 每个类别在文档里至少命中一帧 —— 规范两条装配期断言之一, 也是文档级的判据
    offered = {frame["category"] for ability in abilities for frame in ability["frames"]}
    check(offered == set(capabilities.CATEGORY_TABLE),
          f"每个类别至少一帧, 缺: {sorted(set(capabilities.CATEGORY_TABLE) - offered)}")

    # 7) input_schemas: 每条规则一份 —— 三份, 第三份是第二份 + 一个必填 mask_base64
    check(list(document["input_schemas"])
          == ["txt-2-img/v1", "txt-ref-2-img/v1", "txt-msk-ref-2-img/v1"],
          f"恰好三份 schema, 得到 {list(document['input_schemas'])}")
    plain = document["input_schemas"]["txt-ref-2-img/v1"]
    masked = document["input_schemas"]["txt-msk-ref-2-img/v1"]
    text_only = document["input_schemas"]["txt-2-img/v1"]
    # 2026-10-01: 画幅与种子成了必填 —— 它们是客户端唯一说得准的两件事, 其余旋钮
    # 都取部署侧的默认值。必填清单由 _BASE_SCHEMA 一处写, 三份 schema 从它派生。
    REQUIRED = ["category", "resolution", "seed"]
    check(plain["required"] == REQUIRED, f"必填项是 {REQUIRED}, 得到 {plain['required']}")
    check(text_only["required"] == REQUIRED, "纯文生图那条的必填项与别的规则一模一样")
    check(masked["required"] == [*REQUIRED, "mask_base64"], "蒙版那条只多一个必填 mask_base64")
    check({key: value for key, value in masked["properties"].items() if key != "mask_base64"}
          == {key: value for key, value in plain["properties"].items() if key != "mask_base64"},
          "两条 schema 的字段表必须逐字相同 —— 否则 client 写一次调所有的卖点就没了")
    check(text_only["properties"] == plain["properties"],
          "纯文生图那条也只有 required 与别人不同 —— 参考图那个字段它照旧公布, 只是不收")
    # 「由第一份生成」是断言得了的: 改坏第一份(原地)不许影响第二份。
    before = json.dumps(masked, ensure_ascii=False, sort_keys=True)
    plain["properties"]["category"]["type"] = "MUTATED"
    check(json.dumps(masked, ensure_ascii=False, sort_keys=True) == before,
          "第二条 schema 必须是深拷贝, 不是同一个对象")
    check(json.dumps(document_of(), ensure_ascii=False) != "", "重新取一份文档仍然可用")

    # 8) endpoints: 七个键, 值全部是根相对路径
    check(set(document["endpoints"]) == {"info", "jobs", "job", "progress", "output", "cancel", "translate"},
          f"endpoints 七个键, 得到 {sorted(document['endpoints'])}")
    for key, value in document["endpoints"].items():
        check(value.startswith("/"), f"endpoints.{key} 要以 / 开头(同源相对), 得到 {value}")

    # 9) 已删的东西一件都不许回来 —— 按**键**查, 不按字符串查: "available" 这样的
    #    词在别处仍有合法用途(翻译块就有一个), 用子串筛会把好人也一起冤枉。
    keys = set(collect_keys(document))
    for gone in ("aliases", "ignores", "size_domain", "values", "capabilities",
                 "models", "capability", "task", "size", "steps", "negative_prompt"):
        check(gone not in keys, f"v2 已删的键不许出现在文档里: {gone}")
    for gone in ("unsupported_task", "unsupported_capability"):
        check(gone not in document["errors"], f"{gone} 已从错误表里删掉")

    # 10) 纯 JSON, 稳定往返
    encoded = json.dumps(document, ensure_ascii=False)
    restored = json.loads(encoded)
    check(restored["plugin"]["id"] == capabilities.PLUGIN_ID, "要能穿过 JSON 往返")
    check(json.dumps(restored, ensure_ascii=False) == encoded, "文档要能稳定往返")


def check_document_auth_reports_both_states() -> bool:
    """一个接口同时回答"地址对不对"和"密码对不对" —— 错密码不是错误。"""
    wrong = document_of(authorized=False, auth_required=True)
    open_ = document_of(authorized=True, auth_required=False)
    check(wrong["auth"]["authorized"] is False and wrong["auth"]["required"] is True,
          "密码错: authorized=false 但仍然给全文档")
    check(open_["auth"]["required"] is False, "没设密码时 required=false")
    check(len(wrong["rules"]) == len(open_["rules"]) == 5, "密码错也要播报完整契约")
    return True


# --------------------------------------------------------------------------- #
# rules
# --------------------------------------------------------------------------- #

#: 规范序: txt 开头, ref 接在 -2- 前面, msk 夹在中间。
CANONICAL = {"txt": 0, "msk": 1, "ref": 2}
MODALITIES = {"txt", "ref", "msk", "img", "glb", "3dgs"}


def check_rules_table() -> None:
    # 每条规则的结构先判, 而且按"最具体的毛病"排在最前: 一条被写错顺序的规则
    # 应当被报成"顺序错了", 而不是被下面那条"名字对不上"的长清单笼统盖过去。
    for rule, entry in capabilities.RULES.items():
        check(rule.count("-2-") == 1, f"{rule}: 规则名必须有且只有一个 -2-")
        head, _, tail = rule.partition("-2-")
        inputs = head.split("-")
        check(all(item in MODALITIES for item in inputs + [tail]),
              f"{rule}: 模态必须在 {sorted(MODALITIES)} 里")
        check(tuple(inputs) == tuple(entry["modalities"]), f"{rule}: 名字里的模态要与表里一致")
        check(tail == entry["output"], f"{rule}: 输出的模态要与表里一致")
        # 规范序不是"另一种写法", 是合法性本身: 规则名要被当字符串相等比较。
        ranks = [CANONICAL[item] for item in entry["modalities"]]
        check(ranks == sorted(ranks), f"{rule}: 模态必须按规范序写 (txt [msk] ref), 得到 {ranks}")
        check(tuple(entry["modalities"]) == tuple(
            sorted(entry["modalities"], key=lambda item: CANONICAL[item])), f"{rule}: 规范序")
        check(capabilities.signature_of(rule) == rule,
              f"{rule}: 签名就是规则名自己 —— 只写一处, 没有第二份副本")
        check(capabilities.input_of(rule) == f"{rule}/v1", f"{rule}: schema 键由规则名加 /v1")

    # 现役那三条的名字也钉住: 上面那些判的是"结构对不对", 这条判的是"就是这三条"
    check(list(capabilities.RULES) == ["txt-2-img", "txt-ref-2-img", "txt-msk-ref-2-img"],
          f"规则恰好三条, 得到 {list(capabilities.RULES)}")

    # 「收不收参考图」是从模态表算出来的, 不是另写一份 needs —— 两份迟早会不一致,
    # 而那种不一致的表现是"服务端收了却不用", 客户端看不出任何区别。
    for rule in capabilities.RULES:
        check(capabilities.has_reference(rule) == ("ref" in capabilities.RULES[rule]["modalities"]),
              f"{rule}: has_reference 必须由模态表算出来")
    check(capabilities.has_reference("txt-2-img") is False, "纯文生图那条不收参考图")
    check(capabilities.accepts_image("generate") is False, "generate 不收参考图")
    check(capabilities.accepts_image("render") is True, "render 收参考图")
    check(capabilities.needs_image("render") is True, "render 必须带参考图")
    check(capabilities.needs_image("generate") is False, "generate 必须不带参考图")
    for name in capabilities.CATEGORY_TABLE:
        check(capabilities.needs_image(name) <= capabilities.accepts_image(name),
              f"{name}: 必填参考图的场景必须收参考图 —— 否则那条要求永远满足不了")

    # v1 那条"签名里除分隔符 2 外不许出现数字"现在删掉了: 按字面 -2- 切分就够了。
    for sample, expected in (("txt-ref-2-3dgs", ("txt-ref", "3dgs")),
                             ("txt-msk-ref-2-img", ("txt-msk-ref", "img")),
                             ("ref2img-2-glb", ("ref2img", "glb"))):
        check(sample.partition("-2-")[::2] == expected, f"{sample} 必须按字面 -2- 切分")

    # 非法排序要被认出来: 规范序判据本身得能证伪
    check([CANONICAL[item] for item in ("msk", "ref", "txt")] != sorted(CANONICAL[item] for item in ("msk", "ref", "txt")),
          "规范序判据必须能把 msk-ref-txt 判成非法")

    for name in capabilities.CATEGORY_TABLE:
        check(capabilities.CATEGORY_TABLE[name]["rule"] in capabilities.RULES,
              f"{name}: 类别只能引用规则表里的规则")
        check("signature" not in capabilities.CATEGORY_TABLE[name]
              and "input" not in capabilities.CATEGORY_TABLE[name],
              f"{name}: 类别条目不许手写 signature / input")
        check("aliases" not in capabilities.CATEGORY_TABLE[name], f"{name}: 别名机制已删")


def check_category_lookup() -> None:
    check(capabilities.category_of("fast")["category"] == "fast", "本名能解析")
    check(capabilities.category_of("FAST")["category"] == "fast", "大小写不敏感")
    check(capabilities.category_of(" render ")["category"] == "render", "两侧空白不算")
    for gone in ("quick", "qwen", "edit", "realtime", "", None, "nope"):
        try:
            capabilities.category_of(gone)
            raise AssertionError(f"别名与旧拼写一律不认: {gone!r}")
        except ValueError as error:
            check(str(error) == "unsupported_category", f"错误码要是 unsupported_category, 得到 {error}")

    check(capabilities.categories() == ["fast", "inpaint", "upscale", "render", "generate"],
          "类别集合与顺序")
    check(capabilities.family_of("fast") == "checkpoint", "fast 走 checkpoint 一族")
    check(capabilities.family_of("render") == "qwen_image_21", "render 走 qwen 一族")
    check(capabilities.family_of("generate") == "qwen_image_21", "generate 与 render 同一族")
    check(families.get("qwen_image_21").ROLES == ("unet", "clip", "vae"), "render 一族要三个槽位")
    check(families.get("checkpoint").ROLES == ("checkpoint",), "checkpoint 一族只要一个槽位")
    try:
        families.get("nope")
        raise AssertionError("不认识的家族必须抛错")
    except ValueError as error:
        check(str(error) == "unsupported_category", f"错误码要是 unsupported_category, 得到 {error}")
    # 家族的表要被 dispatcher 读, 而不是被写第二遍
    for name, entry in capabilities.CATEGORY_TABLE.items():
        module = families.get(entry["family"])
        check(set(entry["roles"]) == set(module.ROLES), f"{name}: roles 要与家族声明一致")
        # dispatcher 只把家族声明过的键交出去, 而 step / negative_prompt 是本实现
        # 唯二会读的扩展键 —— 家族漏声明一个, 那个键就会被静默丢掉。
        check({"step", "negative_prompt"} <= set(module.EXT),
              f"{name}: EXT 必须声明 step 与 negative_prompt, 得到 {getattr(module, 'EXT', None)}")
        check(set(getattr(module, "OPTIONS", ())) == set(settings.DEFAULTS["families"].get(entry["family"], {})),
              f"{entry['family']}: family 的可调项要与设置默认值一致")
    check(set(settings.DEFAULTS["families"]) <= set(families.FAMILIES),
          "设置里不许有指向不存在家族的槽位")

    # 两个通道分开, 而且 steps 已经改名 step 并搬进扩展通道
    parameters = set(inspect.signature(families.build).parameters)
    check({"ext", "options"} <= parameters,
          f"families.build 要有 ext 与 options 两个入口, 得到 {sorted(parameters)}")
    for moved in ("steps", "negative_prompt"):
        check(moved not in parameters, f"{moved} 已搬进 ext_params, 不许再是 families.build 的形参")
    for entry in capabilities.CATEGORY_TABLE.values():
        family_parameters = set(inspect.signature(families.get(entry["family"]).build).parameters)
        check("steps" not in family_parameters,
              f"{entry['family']}.build: steps 已改名 step(扩展参数), 不许留旧名")
        check("step" in family_parameters and "negative_prompt" in family_parameters,
              f"{entry['family']}.build 要接受 step 与 negative_prompt")


# --------------------------------------------------------------------------- #
# frames
# --------------------------------------------------------------------------- #

#: 现役实现的取值, 逐项钉住 —— 表变了就要有人来解释为什么。
#:
#: 2026-10-01: ``render`` 那张八比例的表换成**只留 9:16 的三档**, 而这三档是
#: Qwen-Image 2.1 自己的 9:16 几何（768:1344 = 1536:2688 = 4:7）。``generate`` 与它
#: 同一张表 —— 同一族模型的两条路, 画幅没有理由不一样。
NINE_SIXTEEN = ["768x1344", "512x896", "896x1568"]
FRAME_TABLE = {
    "fast": [("1:1", ["512x512"]), ("4:3", ["576x384"]), ("3:4", ["384x576"])],
    "inpaint": [("1:1", ["512x512"]), ("4:3", ["576x384"]), ("3:4", ["384x576"])],
    "upscale": [("1:1", ["1024x1024", "2048x2048"])],
    "render": [("9:16", NINE_SIXTEEN)],
    "generate": [("9:16", NINE_SIXTEEN)],
}


def check_frames_table() -> None:
    check(set(capabilities.FRAMES) == set(capabilities.CATEGORY_TABLE),
          "每个类别都要有自己的帧表")

    # 顺序是规范的一部分: 默认 = 该类别第一档, 不是一个自己另写的常量
    for category in capabilities.FRAMES:
        first = capabilities.FRAMES[category][0]["resolution"][0]
        check(capabilities.default_resolution(category) == first,
              f"{category}: 默认画幅必须是第一档 {first}")
        check(capabilities.validate_resolution(category, None) == first,
              f"{category}: 省略 resolution 取第一档")
        check(capabilities.validate_resolution(category, "") == first,
              f"{category}: 空串等同于省略")

    # 9:16 是标签不是算出来的比例: 768x1344 的真实比是 4:7, 表里就叫它 9:16。
    # 这一档有**三条**分辨率（低/中/高），而**默认是该档的第 0 条** —— 所以这里连顺序
    # 一起钉住: 加档要往末尾追加, 往前面插一条就会把每个客户端的默认画幅悄悄换掉,
    # 而那种改动在别处一点痕迹都没有。
    nine_sixteen = [entry for entry in capabilities.FRAMES["render"] if entry["ratio"] == "9:16"][0]
    check(nine_sixteen["resolution"] == NINE_SIXTEEN,
          f"9:16 那一档给的是 {NINE_SIXTEEN}（中档在最前, 它才是默认）, 得到 {nine_sixteen['resolution']}")
    check(768 * 16 != 1344 * 9, "9:16 不是从数字反推出来的 —— 正因如此才要手写标签")

    # 业主 2026-10-01 定的两条硬边界: 高档的高不许超过 1600（再大 16 GB 卡跑不动),
    # 低档的高不许低于 500（再小脸就看不清了)。钉在这里, 因为"换一批分辨率"正是
    # 最容易越界、又最不容易被发现的一类改动。
    bounds = []
    for category in ("render", "generate"):
        resolutions = [item for entry in capabilities.FRAMES[category] for item in entry["resolution"]]
        heights = [int(value.split("x")[1]) for value in resolutions]
        widths = [int(value.split("x")[0]) for value in resolutions]
        bounds.append((category, resolutions, heights, widths))
        check(len(resolutions) == 3, f"{category}: 恰好低中高三档, 得到 {resolutions}")
        check(max(heights) <= 1600, f"{category}: 高档高不许超过 1600, 得到 {max(heights)}")
        check(min(heights) >= 500, f"{category}: 低档高不许低于 500, 得到 {min(heights)}")
        # 三条边都要落在 16 的倍数上（Qwen 的 VAE 压缩倍率）, 否则最后会被截掉几像素,
        # 而出图只是"稍微不一样", 没人看得出来。
        for width, height in zip(widths, heights):
            check(width % 16 == 0 and height % 16 == 0, f"{category}: {width}x{height} 的两条边都要是 16 的倍数")
        # 高:中:低 的高度要**递减**, 而且中档就是 Qwen 公布的那一档 1K 9:16。
        check("768x1344" in resolutions, f"{category}: 三档里要有 Qwen 2.1 公布的 1K 9:16")
    check([item[0] for item in bounds] == ["render", "generate"], "render 与 generate 都要按这两条边界判")

    # 逐项快照**排在具体的诊断之后**: 它会把任何改动都抓成同一句"帧表变了", 所以越界、
    # 顺序这两件事必须先判 —— 否则改坏一条边界, 报出来的是"表变了", 而读的人分不清这是
    # "改错了一档"还是"整张表被换掉了"。而排在成员校验之前, 是为了让一句断言说话: 表改坏
    # 之后成员校验会从 validate_resolution 里抛一个裸的 ValueError, 那句报错读不出位置。
    #
    # （2026-10-01 曾有第三条断言"render 与 generate 必须共用同一张表", 已删: 单改任一张表
    #   都会先撞上它, 于是它自己永远不是那句报出来的话, 而一条永远不会被人读到具体原因的
    #   断言与没有它没有区别。两族同表这件事由下面这份快照守着: 两份期望共用同一个
    #   NINE_SIXTEEN, 想分家就必须手写第二个常量。）
    for category, expected in FRAME_TABLE.items():
        actual = [(entry["ratio"], list(entry["resolution"])) for entry in capabilities.FRAMES[category]]
        check(actual == expected, f"{category} 的帧表变了: {actual}")

    # frames_of 给每一帧盖上它自己的类别名, 客户端靠这个把两类标签对上
    for category in capabilities.FRAMES:
        for frame in capabilities.frames_of(category):
            check(frame["category"] == category, "frames_of 要盖类别名")
    check(capabilities.frames_of("fast")[0] is not capabilities.FRAMES["fast"][0],
          "frames_of 必须给副本, 不许让调用方改到表本身")

    # 成员校验: 表里的一律收, 一个都不许丢
    for category, expected in FRAME_TABLE.items():
        for _ratio, resolutions in expected:
            for resolution in resolutions:
                check(capabilities.validate_resolution(category, resolution) == resolution,
                      f"{category}: 表里的 {resolution} 必须收下")

    # 表外的合法数字一律拒 —— 这是收紧的判据, v1 的 fits() 会放行 896x1152。
    for category, rejected in (
        ("fast", ["1024x1024", "768x768", "896x1152", "513x513", "512X512", "512", "512x", "x512",
                  "512x512x512", "-512x512", "0x0"]),
        ("render", ["768x768", "896x1152", "1024x768", "512x512"]),
        ("upscale", ["768x1344", "512x512"]),
    ):
        for resolution in rejected:
            try:
                capabilities.validate_resolution(category, resolution)
                raise AssertionError(f"{category} 必须拒掉帧外的 {resolution!r}")
            except ValueError as error:
                check(str(error) == "unsupported_size", f"{resolution!r} 该报 unsupported_size, 得到 {error}")

    # 一对数字不是字符串 —— 请求字段 retired 之后不许有人留后门
    for value in ([512, 512], (512, 512), 512, {"x": 1}, 512.0):
        try:
            capabilities.validate_resolution("fast", value)
            raise AssertionError(f"非字符串必须拒: {value!r}")
        except ValueError as error:
            check(str(error) == "unsupported_size", f"{value!r} 该报 unsupported_size")

    check(capabilities.resolution_size("768x1344") == (768, 1344), "字符串切成一对整数")
    check(capabilities.resolution_size("2048x2048") == (2048, 2048), "2048 也要能切")
    for bad in ("768", "x", "768x", "axb", "768x1344x1", "", None, [768, 1344]):
        try:
            capabilities.resolution_size(bad)
            raise AssertionError(f"resolution_size 必须拒: {bad!r}")
        except ValueError as error:
            check(str(error) == "unsupported_size", f"{bad!r} 该报 unsupported_size")

    # 放大今天只列 1:1(上一条待定已结清): 竖幅放大不再支持, 加一档就是全部工作量。
    check(capabilities.frames_of("upscale") == [{"ratio": "1:1", "category": "upscale",
                                                "resolution": ["1024x1024", "2048x2048"]}],
          "放大只列 1:1 两个档位")
    # 旧域算得出来的画幅现在必须被拒 —— 判据是"每个都必须 400", 不是"至少一个"。
    legacy_accepted = ["768x768", "896x1152", "1024x768", "1280x720"]
    for resolution in legacy_accepted:
        try:
            capabilities.validate_resolution("render", resolution)
            raise AssertionError(f"旧域会放行的 {resolution} 现在必须拒")
        except ValueError:
            pass
    check(len(legacy_accepted) == 4, "旧域的样本要保持在四条以上")


def _frames_of(**overrides: Any) -> dict[str, list[dict[str, Any]]]:
    """A table with one frame for every category, patched by the caller.

    ``check_frames`` is a fact about the whole document, so a table missing a
    category is already a failure — a stub with one category would go red for
    the wrong reason and prove nothing.
    """
    table = {category: [{"ratio": "1:1", "resolution": ["512x512"]}]
             for category in capabilities.CATEGORY_TABLE}
    table.update(overrides)
    return table


def check_frames_assembly_assertions() -> None:
    """两条装配期断言: 不是运行期分支, 是"发布不出一份坏文档"。"""
    check(capabilities.check_frames(_frames_of()) is None, "合法表不报错")

    # 1) 每个类别至少一档
    for category in capabilities.CATEGORY_TABLE:
        for broken in ([], [{"ratio": "1:1", "resolution": []}], [{"ratio": "1:1"}]):
            try:
                capabilities.check_frames(_frames_of(**{category: broken}))
                raise AssertionError(f"{category} 没有帧必须装配期就报错: {broken}")
            except ValueError as error:
                check("没有任何帧" in str(error), f"报错要说明白, 得到 {error}")

    # 2) (category, resolution) 唯一 —— 在同一个类别里重复也不行
    try:
        capabilities.check_frames(_frames_of(render=[{"ratio": "1:1", "resolution": ["512x512"]},
                                                      {"ratio": "9:16", "resolution": ["512x512"]}]))
        raise AssertionError("重复的 (category, resolution) 必须在装配期就报错")
    except ValueError as error:
        check("出现了两次" in str(error), f"报错要说明白, 得到 {error}")
    # 同一个分辨率出现在**不同**类别里是完全合法的(两个类别各有一档 512x512)
    check(capabilities.check_frames(_frames_of(upscale=[{"ratio": "1:1", "resolution": ["512x512"]}])) is None,
          "跨类别撞同一个分辨率不算重复")

    # 现役表通过, 而且它真的被调用过(import 时跑一遍, 坏表根本进不来)
    check(capabilities.check_frames() is None, "现役帧表必须通过装配期断言")


# --------------------------------------------------------------------------- #
# abilities
# --------------------------------------------------------------------------- #

def check_abilities_grouping() -> None:
    """一组能力 = 一组能跑起来的文件, 不是按家族声明的 —— 是派生的。"""
    shared = document_of()["abilities"]
    check(len(shared) == 2, "三族共用一个 checkpoint ⇒ 一条; render 另有一条")
    check([frame["category"] for frame in shared[0]["frames"]]
          == ["fast", "fast", "fast", "inpaint", "inpaint", "inpaint", "upscale"],
          "第一条按类别表顺序收 fast/inpaint/upscale 的帧")
    # 一条帧记录 = 一个比例, 三档低/中/高装在它的 resolution 列表里 —— 所以
    # 只剩 9:16 的 render / generate 各是**一条**, 不是各三条。
    check([frame["category"] for frame in shared[1]["frames"]] == ["render", "generate"],
          "render 与 generate 都落在第二条, 各自一条 9:16")
    check(all(frame["ratio"] == "9:16" for frame in shared[1]["frames"]),
          "第二条两帧都是 9:16")

    # 给 inpaint 一个自己的 checkpoint ⇒ 立刻变成三条。
    # 这是"派生而非声明"的判据: 没有一张表要人去同步。
    def split(category: str) -> dict[str, Any]:
        return fake_files(category, checkpoint="inpaint-only.safetensors" if category == "inpaint" else "")

    split_abilities = capabilities.abilities(split)
    check(len(split_abilities) == 3, f"inpaint 独立后应是三条, 得到 {len(split_abilities)}")
    check(split_abilities[1]["name"] == "inpaint-only.safetensors", "第二条由它自己的文件命名")
    check([frame["category"] for frame in split_abilities[1]["frames"]] == ["inpaint"] * 3,
          "第二条只装 inpaint 的帧")

    # 分组键是 (家族, 文件)。三个 checkpoint 类别靠同一个文件合成一条 —— 这就是
    # "一组能力 = 一组能跑起来的文件"; 而 render 即使被塞成同一组文件也不会并进来,
    # 因为一个图构建器跑不了另一个家族的模型, 合并只会产出一份骗人的文档。
    same_files = capabilities.abilities(lambda _category: {"files": {"checkpoint": "one.safetensors"},
                                                           "ready": True, "missing": []})
    check(len(same_files) == 2, f"跨家族不许合并, 得到 {len(same_files)}")
    check(len(same_files[0]["frames"]) == 7, "checkpoint 那三个类别合成一条, 共七帧")
    check([frame["category"] for frame in same_files[1]["frames"]] == ["render", "generate"],
          "render 与 generate 仍然自己一条")

    # 缺件: ready=false 且 missing 点名
    short = capabilities.abilities(lambda category: fake_files(category, missing=("vae",)))
    check(short[-1]["ready"] is False and short[-1]["missing"] == ["vae"],
          f"缺 vae 要 ready=false 并点名, 得到 {short[-1]}")
    check(short[0]["ready"] is True and short[0]["missing"] == [],
          "checkpoint 那条不受 render 缺件影响")

    # 顺序保持: abilities[0] 装第一个类别的帧 —— 全局默认画幅由此可读
    check(shared[0]["frames"][0] == {"ratio": "1:1", "category": "fast", "resolution": ["512x512"]},
          "abilities[0].frames[0] 就是全局默认画幅")
    # 分辨率的键由 resolver 决定, 文档不许自己编一个名字
    renamed = capabilities.abilities(lambda _category: {"files": {"checkpoint": "x.safetensors"},
                                                        "ready": True, "missing": []})
    check(renamed[0]["name"] == "x.safetensors", "名字取的是那个文件, 不是类别名")


# --------------------------------------------------------------------------- #
# translation memory
# --------------------------------------------------------------------------- #

def check_translation_memory() -> None:
    # 触发条件: 不是"含中文", 而是"不是全 ASCII"
    check(translate.needs_translation("hello world") is False, "纯 ASCII 不翻")
    check(translate.needs_translation("  \n\t ") is False, "空白不算")
    check(translate.needs_translation("") is False, "空串不翻")
    check(translate.needs_translation("一只猫") is True, "中文要翻")
    check(translate.needs_translation("Привет") is True, "俄语同样要翻, 不能只认中日韩")
    check(translate.needs_translation("γειά") is True, "希腊语同样要翻")

    source = "一只猫在沙发上"
    check(translate.memory_path().name == "hamdraw_translations.json", "记忆库文件名")
    check(translate.memory_path().parent == _SCRATCH, "记忆库必须落在设置同目录")

    check(translate.memory_size() == 0, "起步时记忆库是空的")
    check(translate.remember([(source, "a cat on a sofa", "engine-a")]) == 1, "写入一条")
    check(translate.recall(source) == "a cat on a sofa", "立刻命中")
    check(translate.memory_size() == 1, "只该有一条")

    # 键 = 原文 + 目标语言, 与引擎无关: 换个引擎写同一条, 仍是同一条, 但引擎留作旁注
    check(translate.remember([(source, "a cat on a sofa v2", "engine-b")]) == 1, "换引擎再写一次")
    check(translate.memory_size() == 1, "键不含引擎, 换引擎不许产生第二条")
    check(translate.recall(source) == "a cat on a sofa v2", "后写的覆盖先写的")
    entries = json.loads(translate.memory_path().read_text(encoding="utf-8"))
    check(entries["schema"] == "chp-translation-memory/v1", "记忆库要有自己的 schema")
    entry = list(entries["entries"].values())[0]
    check(entry["engine"] == "engine-b", "引擎要作为旁注记下来, 便于将来重刷")
    check(entry["source"] == source and entry["target"] == "en", "条目要记得原文与目标语言")
    check(translate._key(source, "en") != translate._key(source, "zh"), "键含目标语言")

    check(translate.recall(source, "zh") == "", "别的目标语言是另一条事实")

    # 重启进程: 内存丢掉, 文件还在
    translate._MEMORY = None
    check(translate.memory_size() == 1, "重启后条数不变")
    check(translate.recall(source) == "a cat on a sofa v2", "重启后仍然命中")

    described = translate.describe()
    check(described["mode"] == "auto-on-submit", "翻译是提交时兜底")
    check(described["available"] is False, "没配地址就是不可用")
    check(described["memory"]["entries"] == 1, "条数要播报")
    check("http" not in json.dumps(described), "不许播报后端地址")
    check(translate.enabled() is False, "没有地址就是关闭")


# --------------------------------------------------------------------------- #
# settings
# --------------------------------------------------------------------------- #

def check_settings() -> None:
    check(settings.TASKS == tuple(capabilities.categories()), "设置的任务集合必须等于类别表")
    check(set(settings.DEFAULTS["checkpoints"]) == set(capabilities.categories()),
          "每个类别都要有 checkpoint 槽位")
    check(set(settings.DEFAULTS["sampling"]) == set(capabilities.categories()),
          "每个类别都要有采样设置")
    check("quick" not in settings.DEFAULTS["checkpoints"], "quick 槽位已改名 fast")
    check(not hasattr(settings, "RENAMED"), "RENAMED 与 _keys() 机制已删(不留兼容层)")

    check(settings.DEFAULTS["translate"]["url"] == "", "默认翻译地址必须是空")
    check(settings.path().name == "hamdraw_settings.json", "设置文件名(盘上格式标识不动)")
    check(settings.DEFAULTS["checkpoints"]["fast"] == settings.RECOMMENDED_CHECKPOINT,
          "推荐 checkpoint 只有一处常量")
    check(settings.DEFAULTS["families"]["qwen_image_21"]["cache_dtype"] == "default",
          "缓存 dtype 的默认值取模型作者的建议, 不是某台机器的权宜值")

    # 共用一个 checkpoint 是"一个文件服务三个类别"的来源: 空槽位回落到 fast
    settings.update(checkpoints={"fast": "a.safetensors", "inpaint": "", "upscale": ""})
    check(settings.checkpoint("fast") == "a.safetensors", "fast 用自己的")
    check(settings.checkpoint("inpaint") == "a.safetensors", "空槽位回落到 fast")
    check(settings.checkpoint("upscale") == "a.safetensors", "空槽位回落到 fast")
    settings.update(checkpoints={"inpaint": "b.safetensors"})
    check(settings.checkpoint("inpaint") == "b.safetensors", "填了就用自己的")
    check(settings.checkpoint("upscale") == "a.safetensors", "别的槽位不受影响")

    # render 的三件套没有回落: 混用不同的文本编码器不是这张图能跑的组合
    check(settings.model_files("render") == {"unet": "", "clip": "", "vae": ""},
          "三件套默认全空, 不回落")
    check(set(settings.DEFAULTS["models"]) == set(settings.TRIPLE_TASKS),
          "每一个走三件套的类别都要有它自己的槽位")
    check(settings.TRIPLE_TASKS == ("render", "generate"),
          f"走三件套的是 render 与 generate, 得到 {settings.TRIPLE_TASKS}")
    check(settings.model_files("generate") == {"unet": "", "clip": "", "vae": ""},
          "纯文生图同样要三件套, 默认全空")
    settings.update(models={"render": {"unet": "u.safetensors", "clip": "c.safetensors",
                                      "vae": "v.safetensors"}})
    check(settings.model_files("render")["unet"] == "u.safetensors", "三件套写进去要读得出来")
    check(settings.model_files("generate")["unet"] == "", "填 render 不许串到 generate")
    settings.update(models={"generate": {"unet": "gu.safetensors", "clip": "gc.safetensors",
                                         "vae": "gv.safetensors"}})
    check(settings.model_files("generate")["vae"] == "gv.safetensors", "generate 自己那套要独立可配")
    forget_settings()

    # 加速档案: 出厂为空是**规矩**而不是省事 —— 一个 4 步蒸馏 LoRA 的文件名只对装了它的
    # 那台机器成立。写进去了才读得出来, 而 sigma 表的长度就是它的步数加一。
    check(settings.DEFAULTS["accelerators"] == {}, "出厂不许带任何一台机器的加速档案")
    check(settings.accelerator("render") == {}, "没配就是空表, 不是报错")
    check(settings.accelerator("不存在的类别") == {}, "不认识的类别也答空表, 不许抛")
    settings.update(accelerators={"render": {"lora": "acc.safetensors", "strength": 1.0,
                                             "sigmas": "1.0, 0.5, 0.0"}})
    profile = settings.accelerator("render")
    check(profile["lora"] == "acc.safetensors" and profile["sigmas"] == [1.0, 0.5, 0.0],
          f"档案要原样读回来, 得到 {profile}")
    check(profile["strength"] == 1.0, "强度默认 1.0")
    check(settings.accelerator("generate") == {}, "只配了 render, generate 仍然没加速")
    # 表写坏了就整张作废 —— 一张砍掉中间某个数的表仍然跑得起来, 只是调度的不是那个
    # LoRA 训练时的噪声水平, 出图只是"稍微不一样", 这种错没人看得出来。
    settings.update(accelerators={"render": {"lora": "acc.safetensors", "sigmas": "1.0, 坏, 0.0"}})
    check(settings.accelerator("render") == {}, "解析不了的表要整张作废, 而不是跳过那一项")
    # 空表 = 撤掉这台机器的加速档案
    settings.update(accelerators={"render": {"lora": "", "sigmas": ""}})
    check(settings.accelerator("render") == {}, "空档案等于没有加速")
    forget_settings()

    # 不可读的设置文件不许把插件打死
    settings.path().write_text("{ not json", encoding="utf-8")
    check(settings.checkpoint("fast") == settings.RECOMMENDED_CHECKPOINT, "读坏了就退回默认")
    forget_settings()


# --------------------------------------------------------------------------- #
# the request path — driven, not inspected
# --------------------------------------------------------------------------- #

class FakeQueue:
    def __init__(self) -> None:
        self.put_calls: list[tuple] = []
        #: ``prompt_id`` → ComfyUI 的历史记录条目。默认为空 —— 没有历史时 ``get_history``
        #: 也照答（回一个空字典），这正是真实实现的行为（``server._history_entry`` 认它）。
        self.history: dict[str, dict] = {}

    def get_current_queue(self) -> tuple[list, list]:
        return [], []

    def put(self, item: tuple) -> None:
        self.put_calls.append(item)

    def get_history(self, prompt_id: str | None = None) -> dict:
        if prompt_id is None:
            return dict(self.history)
        entry = self.history.get(prompt_id)
        return {prompt_id: entry} if isinstance(entry, dict) else {}


class FakeRoutes:
    def __init__(self) -> None:
        self.registered: dict[str, set[str]] = {"GET": set(), "POST": set()}

    def get(self, path: str):
        self.registered["GET"].add(path)
        return lambda handler: handler

    def post(self, path: str):
        self.registered["POST"].add(path)
        return lambda handler: handler


class FakePromptServer:
    def __init__(self) -> None:
        self.routes = FakeRoutes()
        self.app = types.SimpleNamespace()
        self.number = 0
        self.prompt_queue = FakeQueue()


class FakeRequest:
    """The two things a handler reads off a request: its body and its headers."""

    def __init__(self, body: Any, headers: dict[str, str] | None = None,
                 match_info: dict[str, str] | None = None) -> None:
        self._body = body
        self.headers = dict(headers or {})
        self.match_info = dict(match_info or {})

    async def json(self) -> Any:
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


FAKE_SERVER = FakePromptServer()
_stub("server", PromptServer=type("PromptServer", (), {"instance": FAKE_SERVER}))

#: A real 1 × 1 PNG.  The plugin only checks the base64 decodes and sniffs the
#: magic bytes, but a made-up string would make a failure here unreadable.
TINY_PNG = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB"
            "0C8AAAAASUVORK5CYII=")

#: render 的三件套必须在设置里, 否则这一族会以 no_model 拒绝 —— 那是另一条断言。
RENDER_FILES = {"unet": "qwen.safetensors", "clip": "qwen-clip.safetensors", "vae": "qwen-vae.safetensors"}


def submit(body: Any, headers: dict[str, str] | None = None) -> FakeResponse:
    FAKE_SERVER.prompt_queue = FakeQueue()
    return asyncio.run(server.create_job(FakeRequest(body, headers)))


def job_of(response: FakeResponse) -> dict[str, Any]:
    check(response.status == 202, f"应当被受理, 得到 {response.status}: {response.payload}")
    return response.payload["job"]


def replayed(response: FakeResponse) -> bool:
    """``replayed`` 是 ``job`` 的**兄弟**, 不在 job 里: 它说的是"这次应答"。

    （这条 helper 存在的理由就是刚踩过的那一脚: 写成 ``job_of(...)["replayed"]``
    会当场 KeyError —— 那个键压根不在作业对象里。顺带它把"重放也是 202"钉住。）
    """
    job_of(response)
    check("replayed" in response.payload,
          "应答里每次都要带 replayed —— 它是 job 的兄弟, 不在 job 里")
    return bool(response.payload["replayed"])


def queued_graph() -> dict[str, Any]:
    """The graph the HTTP layer actually handed to ComfyUI."""
    calls = FAKE_SERVER.prompt_queue.put_calls
    check(len(calls) == 1, f"应当恰好入队一次, 得到 {len(calls)}")
    return calls[0][2]


def use_render() -> None:
    settings.update(models={name: dict(RENDER_FILES) for name in settings.TRIPLE_TASKS})


#: 一个**格式上完整**的请求体 —— 2026-10-01 起画幅与种子是必填的, 而带 ref 的场景
#: 还必须带参考图。这条 helper 让每个用例只写它真正在测的那几个字段, 不必每次复述
#: 一遍"必填"这件事（复述十遍的样板, 改一次就要改十处）。
def body_for(category: str = "render", **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {"category": category, "resolution": "768x1344",
                            "seed": 7, "prompt": "x"}
    if capabilities.CATEGORY_TABLE[category]["needs"]["image"]:
        body["image_base64"] = TINY_PNG
    if capabilities.CATEGORY_TABLE[category]["needs"]["mask"]:
        body["mask_base64"] = TINY_PNG
    body.update(overrides)
    return body


def check_request_channels() -> None:
    """P3 的判据: 闸门、两个通道、原样回显。"""
    use_render()
    body = {
        "category": "render",
        "resolution": "768x1344",
        "prompt": "a cat",
        "seed": 7,
        "image_base64": TINY_PNG,
        # 实现自己认得的那两个键, 加一个它根本不认识的
        "ext_params": {"step": 12, "negative_prompt": "blurry", "我自己编的": {"nested": [1, 2]}},
        # CHP 层: 认得 password, 其余一律忽略且不报错
        "chp_params": {"password": "", "账本": "whatever"},
        # 下面这些 v1 的顶层字段现在只剩"被忽略并被点名"
        "steps": 8,
        "capability": "quick",
        "task": "qwen",
        "size": [768, 1344],
        "negative_prompt": "nope",
        "瞎编字段": 1,
    }
    job = job_of(submit(body))

    # 1) 回执: 未认字段全部被点名 —— 没有它, "参数搬家"对客户端就是静默失效
    check(set(job["ignored"]) == {"steps", "capability", "task", "size", "negative_prompt", "瞎编字段"},
          f"被忽略的顶层字段要逐个点名, 得到 {job['ignored']}")
    for channel in ("ext_params", "chp_params", "category", "resolution", "prompt", "seed"):
        check(channel not in job["ignored"], f"{channel} 是认得的字段, 不许进 ignored")

    # 2) ext_params 原样携带、原样回显(含实现不认识的键, 含嵌套结构)
    check(job["ext_params"] == body["ext_params"], f"ext_params 要原样回显, 得到 {job['ext_params']}")
    check(job["ext_params"]["我自己编的"] == {"nested": [1, 2]}, "嵌套结构不许被压平")

    # 3) 生效值回填
    check(job["category"] == "render" and job["resolution"] == "768x1344", "生效的类别与画幅要回填")
    check(job["seed"] == 7, "seed 留顶层并回填")
    check(job["ref_strength"] == capabilities.CATEGORY_TABLE["render"]["defaults"]["ref_strength"],
          f"没给 ref_strength 就用该类别自己的默认值, 得到 {job['ref_strength']}")

    # 4) 「读了但没用」只有行为断言看得见: 图里采样的步数必须是 ext_params.step,
    #    不是顶层的 steps(8 已被忽略), 也不是类别默认(20)。
    graph = queued_graph()
    check(graph["7"]["inputs"]["steps"] == 12,
          f"采样步数必须来自 ext_params.step, 得到 {graph['7']['inputs']['steps']}")
    check(graph["7"]["inputs"]["steps"] not in (8, capabilities.CATEGORY_TABLE["render"]["steps"]["default"]),
          "顶层 steps 与类别默认都不许赢")
    check(graph["7"]["inputs"]["seed"] == 7, "种子要进图")
    check(graph["7"]["inputs"]["latent_image"][0] == "6", "采样器接在 latent 上")
    check(graph["7"]["inputs"]["cfg"] == 1.0, "cfg 来自部署设置")
    # 反向提示词也是走 ext_params 的
    check("negative_prompt" in json.dumps(graph), "ext_params.negative_prompt 要进图")
    forget_settings()


def check_request_ext_defaults() -> None:
    """省掉扩展键 ⇒ 用实现自己的默认; 越界 ⇒ 报错(这是实现的行为, 规范里注明)。"""
    use_render()
    # 画幅与种子是必填的（2026-10-01 起）: 少了就说少了, 不替它挑一个 —— 挑出来的那个
    # 和它下一次挑的很可能不是同一个, 而"沉默地换了一张画幅"从成图上看不出来。
    for body, code, missing in (
        ({"category": "render", "prompt": "a cat", "seed": 1}, "unsupported_size", "resolution"),
        ({"category": "render", "prompt": "a cat", "resolution": "768x1344"}, "bad_request", "seed"),
        ({"category": "generate", "prompt": "a cat", "seed": 1}, "unsupported_size", "resolution"),
    ):
        response = submit(body)
        check(response.status == 400 and response.payload["error"] == code,
              f"缺 {missing} 要报 {code}, 得到 {response.status} {response.payload}")
        check(response.payload["detail"]["missing"] == missing, "回执要点出缺的是哪一项")
    check(FAKE_SERVER.prompt_queue.put_calls == [], "缺必填项的请求一律不许入队")

    job = job_of(submit(body_for("render")))
    check(job["ext_params"] == {}, "没给就回显空对象, 不是 null")
    check(job["ignored"] == [], "干净的请求不该被点名")
    check(queued_graph()["7"]["inputs"]["steps"] == capabilities.CATEGORY_TABLE["render"]["steps"]["default"],
          "step 省略、这台机器又没配加速档案时, 取该类别自己的默认")

    for step in (13, 1, 0, -5, "many", 20.5, True, [20]):
        response = submit(body_for("render", ext_params={"step": step}))
        check(response.status == 400 and response.payload["error"] == "unsupported_steps",
              f"step={step!r} 该报 unsupported_steps, 得到 {response.status} {response.payload}")
    for step in capabilities.CATEGORY_TABLE["render"]["steps"]["values"]:
        check(submit(body_for("render", ext_params={"step": step})).status == 202,
              f"枚举里的 {step} 必须被接受")
    forget_settings()


#: PDD 4 步蒸馏 LoRA 自己那张表 —— 五个数, 所以它只在 4 步上成立。
SIGMAS_PDD = "1.0, 0.9169867038726807, 0.7861579060554504, 0.5494909882545471, 0.0"
#: Viggle 6 步那张 —— 七个数。
SIGMAS_VIGGLE = "1.0, 0.9375, 0.875, 0.75, 0.5, 0.25, 0.0"


def check_request_accelerator() -> None:
    """加速档案: 默认步数由它定, LoRA 与 sigma 表进图, 而且**只在自己那档步数上成立**。

    这一条是整次改动的核心 —— 「A1X 默认就走这条路」如果只写在设置文件里而没人验过,
    那就是一句关于配置的说法, 不是一句关于行为的话。
    """
    use_render()
    settings.update(accelerators={
        "render": {"lora": "acc_pdd_4step_comfy.safetensors", "strength": 1.0, "sigmas": SIGMAS_PDD},
        "generate": {"lora": "acc_viggle_6step.safetensors", "strength": 1.0, "sigmas": SIGMAS_VIGGLE},
    })

    # 1) render: 挂 LoRA + 五件套; 客户端没发 step ⇒ 走的是档案自己那一档(4), 而不是类别默认(20)
    job_of(submit(body_for("render", seed=5)))
    graph = queued_graph()
    check(graph["7"]["class_type"] == "SamplerCustomAdvanced",
          f"加速时采样器要换成 SamplerCustomAdvanced, 得到 {graph['7']['class_type']}")
    check(graph["1a"]["class_type"] == "LoraLoaderModelOnly", "LoRA 要真的挂上去")
    check(graph["1a"]["inputs"]["lora_name"] == "acc_pdd_4step_comfy.safetensors", "挂的是配的那一支")
    check(graph["1a"]["inputs"]["model"] == ["1", 0], "LoRA 接在 UNETLoader 后面")
    check(graph["4"]["inputs"]["model"] == ["1a", 0], "KV 缓存接在 LoRA 之后 —— 顺序反了缓存就白做")
    check(graph["7d"]["inputs"]["model"] == ["1a", 0], "引导器也要拿 LoRA 之后那个模型")
    check(graph["7b"]["class_type"] == "ManualSigmas", "sigma 表要显式给")
    check(graph["7b"]["inputs"]["sigmas"].count(",") == 4,
          f"4 步 ⇒ 表里 5 个数, 得到 {graph['7b']['inputs']['sigmas']}")
    check(graph["7b"]["inputs"]["sigmas"].startswith("1.0,") and graph["7b"]["inputs"]["sigmas"].endswith(", 0.0"),
          "表要从 1.0 走到 0.0")
    check("0.9169867038726807" in graph["7b"]["inputs"]["sigmas"],
          "整张表要原样带上 —— 截到四位小数就等于自己改了厂商的调度表")
    check(graph["7c"]["inputs"]["noise_seed"] == 5, "种子进的是 RandomNoise")
    check(graph["7"]["inputs"]["latent_image"] == ["6", 0], "采样仍然从空 latent 起步")
    check("steps" not in json.dumps(graph["7"]["inputs"]),
          "SamplerCustomAdvanced 没有 steps 参数 —— 步数是 sigma 表的长度")
    check(job_of(submit(body_for("render")))["seed"] == 7, "种子照旧回填")

    # 2) 「只在自己那档步数上成立」: 客户端指定 8 步 ⇒ 不挂 LoRA, 走普通 KSampler。
    #    这是"读了但没用"的反面断言 —— 少了它, 一个"永远挂 LoRA"的实现也能全绿。
    job_of(submit(body_for("render", ext_params={"step": 8})))
    graph = queued_graph()
    check(graph["7"]["class_type"] == "KSampler",
          f"步数对不上时不许挂 LoRA, 得到 {graph['7']['class_type']}")
    check("1a" not in graph, "步数对不上时 LoRA 一个都不许留在图里")
    check(graph["7"]["inputs"]["steps"] == 8, "客户端要的那一档要生效")
    check(graph["4"]["inputs"]["model"] == ["1", 0], "不加速时缓存直接接 UNETLoader")

    # 3) generate 用**它自己那一支**, 而且不带参考图那一串
    job_of(submit(body_for("generate")))
    graph = queued_graph()
    check(graph["7"]["class_type"] == "SamplerCustomAdvanced",
          "generate 也要走加速那条路 —— 与 render 同一条链路, 只是档案不同")
    check(graph["1a"]["inputs"]["lora_name"] == "acc_viggle_6step.safetensors",
          "generate 挂的是自己配的那一支, 不是 render 的")
    check(graph["7b"]["inputs"]["sigmas"].count(",") == 6, "6 步 ⇒ 表里 7 个数")
    check(not any(key in graph for key in ("10", "11", "12")), "纯文生图不许建参考图那一串")
    check("images.image_1" not in graph["5"]["inputs"], "空着那个输入是模型明确支持的路径")

    # 4) 撤掉档案 = 回到不加速那条路, 步数也回到类别默认
    settings.update(accelerators={"render": {"lora": "", "sigmas": ""}})
    job_of(submit(body_for("render")))
    graph = queued_graph()
    check(graph["7"]["class_type"] == "KSampler" and "1a" not in graph, "撤掉档案就不许再挂 LoRA")
    check(graph["7"]["inputs"]["steps"] == capabilities.CATEGORY_TABLE["render"]["steps"]["default"],
          "撤掉档案后步数回到类别默认")

    # 5) 配了却没装 ⇒ 静默降级到不加速, 而不是让整张图校验不过 —— 后者那句报错与
    #    "这台机器根本没配"长得一模一样, 而这两件事的修法完全不同。
    #    清单要**非空**才算"问得出来": 读不到清单（ComfyUI 还在启动）是不敢判, 不是缺件。
    try:
        _MODEL_FILES["loras"] = ["something-else.safetensors"]
        settings.update(accelerators={"render": {"lora": "acc_pdd_4step_comfy.safetensors",
                                                 "sigmas": SIGMAS_PDD}})
        job_of(submit(body_for("render")))
        check("1a" not in queued_graph(), "LoRA 不在 models/loras 里就不许往图里写")
        _MODEL_FILES["loras"] = ["acc_pdd_4step_comfy.safetensors"]
        job_of(submit(body_for("render")))
        check("1a" in queued_graph(), "清单里有了就照挂 —— 否则上面那条断言在两种情况下都成立")
    finally:
        _MODEL_FILES.pop("loras", None)
        forget_settings()


def check_request_categories() -> None:
    """每个类别的 needs 决定缺什么报什么, 而"带不带参考图"是 render 与 generate 的分界。

    2026-10-01 之前, render 一个类别兼着"参考图编辑"和"纯文生图"两种用法, 区别只在
    "这次有没有带图"。现在它们各是一条规则 —— 客户端从 ``rules[].signature`` 就能读出
    自己该不该带那张图, 不必靠试。这条断言就是那个分界的判据, 两个方向都判。
    """
    use_render()

    # needs.image=true 的类别没图就是 bad_image（render 与 fast/upscale 同一条）
    for category in ("fast", "upscale", "render"):
        response = submit({"category": category, "prompt": "a cat",
                           "resolution": capabilities.default_resolution(category), "seed": 1})
        check(response.payload["error"] == "bad_image",
              f"{category}: 缺参考图要报 bad_image, 得到 {response.payload}")

    # 反过来: **不收**参考图的规则收到图, 也要当场拒 —— 收下再丢掉是最糟的一种答法,
    # 客户端会以为那张图起作用了。
    response = submit(body_for("generate"))
    check(response.status == 202, f"纯文生图不带图应当受理, 得到 {response.payload}")
    check(job_of(response)["category"] == "generate", "生效的是 generate")
    graph = queued_graph()
    check(not any(key in graph for key in ("10", "11", "12")), "纯文生图不建参考图那一串")
    response = submit(body_for("generate", image_base64=TINY_PNG))
    check(response.status == 400 and response.payload["error"] == "bad_image",
          f"纯文生图收到参考图要报 bad_image, 得到 {response.status} {response.payload}")

    # inpaint 按 needs 逐项判, 缺什么报什么(蒙版先判, 于是两样都没有时报缺蒙版)
    base = {"category": "inpaint", "prompt": "a cat", "resolution": "512x512", "seed": 1}
    for extra, expected in (
        ({}, "bad_mask"),
        ({"image_base64": TINY_PNG}, "bad_mask"),
        ({"mask_base64": TINY_PNG}, "bad_image"),
        ({"mask_base64": TINY_PNG, "image_base64": TINY_PNG}, ""),
    ):
        response = submit({**base, **extra})
        if expected:
            check(response.payload["error"] == expected,
                  f"inpaint {sorted(extra)}: 该报 {expected}, 得到 {response.payload}")
        else:
            check(response.status == 202, f"参考图与蒙版都给了就能提交, 得到 {response.payload}")

    # 带了参考图的 fast: 图要落盘, 画幅按帧表, ref_strength 取该类别默认
    job = job_of(submit(body_for("fast", resolution="512x512")))
    check(job["resolution"] == "512x512", f"fast 给的画幅要生效, 得到 {job['resolution']}")
    check(job["ref_strength"] == capabilities.CATEGORY_TABLE["fast"]["defaults"]["ref_strength"],
          f"fast 的参考权重默认值, 得到 {job['ref_strength']}")
    graph = queued_graph()
    check(graph["2"]["inputs"]["image"].startswith("hamdraw/"), "参考图要落到 input/hamdraw/ 下")
    check(graph["7"]["inputs"]["steps"] == capabilities.CATEGORY_TABLE["fast"]["steps"]["default"],
          "fast 的默认步数与 render 不同 —— 默认归属类别, 不归属实现")

    # 没有参考图的类别没有"参考权重"这个旋钮: 它的 defaults 是空表, 而服务端仍然要
    # 给出一个确定的答案, 不许在 ["defaults"]["ref_strength"] 上撞 KeyError。
    check(capabilities.CATEGORY_TABLE["generate"]["defaults"] == {},
          "generate 的默认值表是空的 —— 发布一个按了没反应的旋钮比不发布更糟")
    check(capabilities.default_ref_strength("generate") == capabilities.REF_STRENGTH_RANGE[1],
          "没有声明的类别给区间上界, 而不是抛异常")
    check(job_of(submit(body_for("generate")))["ref_strength"] == capabilities.REF_STRENGTH_RANGE[1],
          "纯文生图的 ref_strength 回填的也是那个确定的数")

    # 参考图解码不了就是 bad_image, 不许静默当没带
    bad = submit(body_for("fast", resolution="512x512", image_base64="!!!not base64!!!"))
    check(bad.payload["error"] == "bad_image", f"坏图必须报错, 得到 {bad.payload}")
    # 蒙版同理
    bad = submit({"category": "inpaint", "prompt": "x", "resolution": "512x512", "seed": 1,
                  "image_base64": TINY_PNG, "mask_base64": "???"})
    check(bad.payload["error"] == "bad_mask", f"坏蒙版必须报错, 得到 {bad.payload}")

    # ref_strength 是连续量: 夹边并回显, 不报错
    for given, expected in ((2.0, 0.95), (-1, 0.05), (0.5, 0.5), ("oops", 0.55), (None, 0.55)):
        overrides: dict[str, Any] = {"resolution": "512x512"}
        if given is not None:
            overrides["ref_strength"] = given
        job = job_of(submit(body_for("fast", **overrides)))
        check(job["ref_strength"] == expected,
              f"ref_strength={given!r} 应当回显 {expected}, 得到 {job['ref_strength']}")

    # 负种子报错(0 是"每次不同", 不是错误)
    check(submit(body_for("render", seed=-1)).payload["error"] == "bad_request", "负种子要报 bad_request")
    check(job_of(submit(body_for("render", seed=0)))["seed"] == 0, "0 是合法种子")
    forget_settings()


def check_request_frame_membership() -> None:
    """成员校验收紧的判据打在请求上: 帧外一律 400 unsupported_size。"""
    use_render()
    for category, bad in (("fast", "1024x1024"), ("render", "896x1152"),
                          ("render", "768x768"), ("upscale", "768x1344"),
                          # 2026-10-01 缩表之后, 这些曾经在菜单上的值也要被拒:
                          ("render", "1024x1024"), ("render", "576x1024"), ("render", "432x768"),
                          ("generate", "512x512"), ("generate", "1024x1024")):
        response = submit({"category": category, "prompt": "x", "resolution": bad, "seed": 1})
        check(response.status == 400 and response.payload["error"] == "unsupported_size",
              f"{category}+{bad} 该报 unsupported_size, 得到 {response.status} {response.payload}")
        check(response.payload["detail"]["resolution"] == bad, "回执要点出被拒的那个值")
    # 一对数字(v1 的 size)不再是合法表示
    response = submit({"category": "render", "prompt": "x", "resolution": [1024, 1024], "seed": 1})
    check(response.payload["error"] == "unsupported_size", "size 那对数字已退休")

    # 每个类别里表内的每一档都真的能提交
    for category in capabilities.CATEGORY_TABLE:
        for frame in capabilities.frames_of(category):
            body: dict[str, Any] = {"category": category, "prompt": "x", "seed": 1,
                                    "resolution": frame["resolution"][0]}
            if capabilities.CATEGORY_TABLE[category]["needs"]["image"]:
                body["image_base64"] = TINY_PNG
            if capabilities.CATEGORY_TABLE[category]["needs"]["mask"]:
                body["mask_base64"] = TINY_PNG
            check(submit(body).status == 202, f"{category}+{frame['resolution'][0]} 必须能提交")
    forget_settings()


def check_request_renamed_fields() -> None:
    """v1 的字段名不再被当作别名 —— 客户端漏改时当场点名, 不是静默生效。"""
    use_render()
    for body in ({"capability": "fast", "prompt": "x"},
                 {"task": "fast", "prompt": "x"},
                 {"capability": "fast", "task": "fast", "category": ""}):
        response = submit(body)
        check(response.status == 400 and response.payload["error"] == "unsupported_category",
              f"旧字段名 + 没有 category ⇒ unsupported_category, 得到 {response.payload}")
    # 而且回执要顺带告诉它哪个字段不该发 —— 这正是"忽略"与"点名"的分工
    receipt = submit({"capability": "fast", "prompt": "x"})
    check(receipt.payload["detail"]["ignored"] == ["capability"],
          f"失败回执也要点名, 得到 {receipt.payload['detail']}")
    check(receipt.payload["detail"]["category"] is None, "回执要说明 category 是空的")
    # 认的字段名仍然是认的
    check(submit(body_for("render", capability="fast")).status == 202,
          "category 在时, 多一个 capability 只是被忽略")
    forget_settings()


def check_request_auth() -> None:
    """密码: 有 body 走字段, 没 body 走头 —— 一个请求只用一种载体。"""
    use_render()
    try:
        settings.update(password="pw-under-test")
        check(server._password() == "pw-under-test", "密码要从设置里读出来")

        # 字段这条路
        response = submit(body_for("render", chp_params={"password": "pw-under-test"}))
        check(response.status == 202, f"chp_params.password 必须能过鉴权, 得到 {response.payload}")
        # 头这条路(get 与无 body 的 post 只能用它)
        response = submit(body_for("render"),
                          headers={"Authorization": "Bearer pw-under-test"})
        check(response.status == 202, "Authorization 头照旧")
        # 错密码: 字段与头都不行
        for headers, overrides in (({}, {"chp_params": {"password": "nope"}}),
                                   ({"Authorization": "Bearer nope"}, {}),
                                   ({"Authorization": "Basic " + base64.b64encode(b"ham:wrong").decode()}, {})):
            response = submit(body_for("render", **overrides), headers)
            check(response.status == 401 and response.payload["error"] == "unauthorized",
                  f"错密码要 401, 得到 {response.status} {response.payload}")
        # 空密码串不等于"没设密码"
        response = submit(body_for("render", chp_params={"password": ""}))
        check(response.status == 401, "空密码串要 401, 不许被当成免鉴权")
        # chp_params 里的其它键不影响鉴权, 也不报错
        response = submit(body_for("render", chp_params={"password": "pw-under-test", "账本": 1}))
        check(response.status == 202, "chp_params 的未知键不许影响鉴权")
    finally:
        forget_settings()

    # 没设密码 ⇒ /chp/info 播报 required=false, 而且真的不校验
    check(server._password() == "", "清掉设置后没有密码")
    use_render()
    check(job_of(submit(body_for("render")))["category"] == "render",
          "没设密码时免鉴权")
    forget_settings()


def check_request_bad_bodies() -> None:
    for body in ("a string", [1, 2], 42, None, ValueError("bad json")):
        response = submit(body)
        check(response.status == 400 and response.payload["error"] == "bad_request",
              f"非对象/坏 JSON 要 bad_request, 得到 {response.status} {response.payload}")
    # 没有可用模型时报 no_model, 而且要在入队之前
    response = submit(body_for("render"))
    check(response.status == 409 and response.payload["error"] == "no_model",
          f"三件套没配齐要 no_model, 得到 {response.status} {response.payload}")
    check(FAKE_SERVER.prompt_queue.put_calls == [], "被拒的请求一律不许入队")
    forget_settings()


def input_files() -> set[str]:
    """落进 ``input/hamdraw/`` 的文件名 —— 重放**不该**再写进第二个参考图。"""
    directory = Path(tempfile.gettempdir()) / "hamdraw"
    return {item.name for item in directory.iterdir()} if directory.is_dir() else set()


def check_request_idempotency() -> None:
    """``request_id``: 同一次提交的第二次到达, 答卷是**原来那个作业**。

    要挡住的是实测发生过的那件事: 一次提交在服务端跑完了, 回程却断了, 客户端只能
    重发 —— 于是队列里多出一个作业, 而**已经生成好的那张图**谁也没来取。
    """
    use_render()

    def render(request_id: str, **overrides: Any) -> dict[str, Any]:
        body = body_for("render", prompt="a cat", seed=5, request_id=request_id)
        body.update(overrides)
        return body

    # 1) 第一次: 正常入队, 并且**明说**这不是重放。
    first = submit(render("req-a"))
    job = job_of(first)
    check(replayed(first) is False, "第一次提交不是重放")
    check(FAKE_SERVER.prompt_queue.put_calls != [], "第一次提交要入队")
    check(job["ignored"] == [], f"request_id 是认得的字段, 不许进 ignored: {job['ignored']}")

    # 2) 同键同内容再来一次: 还是那一个作业, 一个作业都没多排, 图也没多写一份。
    #    写图那条尤其要紧 —— 不拦的话每次重试都在 input/ 里堆一张几 MB 的参考图。
    written = input_files()
    again = submit(render("req-a"))
    check(again.status == 202, f"重放也是被受理, 得到 {again.status} {again.payload}")
    check(replayed(again) is True, "同键同内容必须被认出来是重放")
    check(job_of(again)["id"] == job["id"], "重放必须答回原来那个作业")
    check(FAKE_SERVER.prompt_queue.put_calls == [], "重放**一个作业都不许排**")
    check(input_files() == written, "重放不许再往 input/hamdraw/ 写一份参考图")
    check(server._REQUESTS["req-a"]["job_id"] == job["id"], "键要绑在作业上")

    # 3) 密码不是内容: 同一个键换一种密码写法, 仍然是同一次提交。
    #    (状态先判、再问 replayed: 这样一旦这条判据坏了, 报出来的是**这一句**,
    #     而不是 helper 里那句"应当被受理" —— 变异脚本靠这一句认出是谁管着它。)
    swapped = submit(render("req-a", chp_params={"password": "", "账本": 1}))
    check(swapped.status == 202 and replayed(swapped) is True,
          "chp_params 不该进指纹 —— 那是密码, 不是这次画什么")
    # 4) 而改种子**是**改内容: 一个键只装一次提交, 不许悄悄把它吞掉。
    conflict = submit(render("req-a", seed=6))
    check(conflict.status == 409 and conflict.payload["error"] == "duplicate_request",
          f"同键换内容要 duplicate_request, 得到 {conflict.status} {conflict.payload}")
    check(conflict.payload["detail"]["reason"] == "different_body", "要说清是哪一种冲突")
    check(FAKE_SERVER.prompt_queue.put_calls == [], "冲突的更不许排队")

    # 5) 上一次还在处理中(作业号还没生成): 答"稍后再问", 不答"第二个作业"。
    #    这个状态得在并发里才造得出来, 所以直接问那条判据本身。
    check(server._claim_request("req-inflight", "same")[0] == "fresh", "先把键占住")
    decision, refused = server._claim_request("req-inflight", "same")
    check(decision == "conflict" and refused.status == 409
          and refused.payload["detail"]["reason"] == "in_flight",
          f"处理中要答 in_flight, 得到 {decision} {getattr(refused, 'payload', None)}")
    server._release_request("req-inflight")

    # 6) 提交失败的把键**还回来** —— 否则用户自己的重试会被自己上一次失败挡住。
    bad = submit(render("req-bad", image_base64="这不是图片"))
    check(bad.status == 400 and bad.payload["error"] == "bad_image",
          f"坏图要 bad_image, 得到 {bad.status} {bad.payload}")
    check("req-bad" not in server._REQUESTS, "失败的提交要把键还回去")
    retry = submit(render("req-bad"))
    check(retry.status == 202 and replayed(retry) is False, "还回来的键可以重新提交")

    # 7) 重放答的是**此刻**, 不是第一次那份 202 的复印件: 客户端重发的理由正是
    #    "上次没收到回音", 而那张图很可能早就好了。
    ahead = FakeQueue()
    ahead.history[job["id"]] = {"status": {"status_str": "success"},
                                "outputs": {"9": {"images": [{"filename": "done.png",
                                                              "subfolder": "", "type": "output"}]}}}
    FAKE_SERVER.prompt_queue = ahead
    later = asyncio.run(server.create_job(FakeRequest(render("req-a"))))
    check(replayed(later) is True, "仍然是重放")
    check(job_of(later)["state"] == "completed", "要读此刻的状态, 而不是照抄第一次那份")
    check([item["filename"] for item in job_of(later)["outputs"]] == ["done.png"], "成图也要带上")
    check(ahead.put_calls == [], "重放不许排队")

    # 8) 一个字段都不发的老客户端: 两次提交就是两个作业, 谁也不许被并掉;
    #    而``replayed``**每次都在** —— 一个有时有、有时没有的键, 客户端就只能靠
    #    "有没有这个键"来判, 那是这一行里最容易写错的一种读法。
    plain = submit(body_for("render", prompt="两个"))
    check(replayed(plain) is False, "没 request_id 就不是重放")
    check(job_of(plain)["ignored"] == [], "一个字段都不发, 没有陌生的东西可点名")
    check(job_of(submit(body_for("render", prompt="两个")))["id"] != job_of(plain)["id"],
          "没有 request_id 时两次提交就是两个作业")

    # 9) 键写坏了要报错, 不静默忽略: 悄悄丢掉一个幂等键 = 客户端以为自己在重试,
    #    服务端每次都在重来一遍 —— 那正是这个字段要消灭的事。
    for broken in (7, True, ["req"], {"id": "req"}):
        response = submit(body_for("render", prompt="a cat", request_id=broken))
        check(response.status == 400 and response.payload["error"] == "bad_request",
              f"非字符串的 request_id 要 bad_request, 得到 {response.status} {response.payload}")
    over = submit(body_for("render", prompt="a cat",
                           request_id="x" * (server.MAX_REQUEST_ID_CHARS + 1)))
    check(over.status == 400, f"超长的键要报错, 得到 {over.status}")
    # 空串与纯空白算**没给**(老规矩): 不报错, 也不去重。
    blank = job_of(submit(body_for("render", prompt="a cat", request_id="   ")))
    check(blank["ignored"] == [], "空白串算没给, 而不是被忽略的陌生字段")

    # 10) 作业被挤出窗口时, 它占的键要跟着走: 留着一个指向不存在作业的键, 第二次
    #     到达会被答成"正在处理中" —— 那是一个永远不成立的答案, 比不认得这个键更糟。
    jobs, requests = dict(server._JOBS), dict(server._REQUESTS)
    try:
        # 先像真提交那样把键占住: ``_track`` 只负责**绑定**已经占住的键, 它不会替你
        # 造一个出来 —— 少了这一步, 下面那条断言在改坏与没改坏时都成立(= 白测)。
        server._claim_request("req-old", "same")
        server._track({"id": "evicted-job", "created": -1.0, "cancelled": False}, "req-old")
        check(server._REQUESTS["req-old"]["job_id"] == "evicted-job", "键先绑在这个作业上")
        for index in range(server.MAX_TRACKED_JOBS + 1):
            server._track({"id": f"filler-{index}", "created": float(index), "cancelled": False})
        check("evicted-job" not in server._JOBS, "最老的作业应当已经被挤出窗口")
        check("req-old" not in server._REQUESTS, "作业被淘汰时, 它占的幂等键要一起还回去")
    finally:
        server._JOBS.clear()
        server._JOBS.update(jobs)
        server._REQUESTS.clear()
        server._REQUESTS.update(requests)

    # 11) 文档里也公布这个字段, 而且**上限只有一个出处**: 服务端判的那个数就是
    #     发布的 maxLength, 两处各写一份数字迟早会有一处忘了改。
    schema = document_of()["input_schemas"]["txt-ref-2-img/v1"]
    check("request_id" in schema["properties"], "提交体 schema 要公布 request_id")
    check("request_id" not in schema["required"], "它必须可选: 旧客户端一个都不发也要照跑")
    check(schema["properties"]["request_id"]["maxLength"] == server.MAX_REQUEST_ID_CHARS,
          "服务端判的上限要与文档发布的 maxLength 同源")

    forget_settings()


def check_output_urls() -> None:
    """输出地址就是文档里公布的那条模板 —— 客户端不必自己拼。"""
    entry = {"outputs": {"9": {"images": [{"filename": "a.png", "subfolder": "", "type": "output"},
                                          {"filename": "b.jpg", "subfolder": "x", "type": "temp"}]}}}
    files = server._outputs_of("pid", entry)
    check([item["url"] for item in files] == ["/chp/jobs/pid/output/0", "/chp/jobs/pid/output/1"],
          f"输出地址必须由 API_ROOT 拼出, 得到 {[item['url'] for item in files]}")
    check(files[1]["media_type"] == "image/jpeg", "媒体类型按扩展名判, 不信头")
    check(server._outputs_of("pid", None) == [], "没有历史记录就是空表")
    check(capabilities.ENDPOINTS["output"] == "/chp/jobs/{job_id}/output/{index}", "文档里的模板")
    check(capabilities.ENDPOINTS["output"].replace("{job_id}", "pid").replace("{index}", "0")
          == files[0]["url"], "文档公布的模板与回执里的地址必须是同一条")


# --------------------------------------------------------------------------- #
# server surface
# --------------------------------------------------------------------------- #

def check_server_surface() -> None:
    check(server.API_ROOT == "/chp", "主接口根路径")
    check(capabilities.API_ROOT == server.API_ROOT, "两处路径常量必须同源")
    check(not hasattr(server, "ALIAS_ROOTS"), "/cvp 别名整条已删")
    check(not hasattr(server, "LEGACY_ROOT"), "/hamdraw/v1 那套旧投影面已经拆掉了")
    check(not hasattr(server, "_root_of"), "_root_of 已删: 只有一个根, 没有相对谁的问题")
    check(not hasattr(server, "_size_of"), "_size_of 已删: 画幅按帧表判, 不解析数字")

    # 顶层只认这十个; 两个通道本身也算认得的字段
    check(server.RECOGNISED_FIELDS == frozenset({
        "category", "resolution", "prompt", "seed", "ref_strength",
        "image_base64", "mask_base64", "ext_params", "chp_params",
        "request_id"}),
        f"认得的顶层字段变了: {sorted(server.RECOGNISED_FIELDS)}")
    for gone in ("capability", "task", "size", "steps", "negative_prompt", "ignores"):
        check(gone not in server.RECOGNISED_FIELDS, f"{gone} 不再是顶层字段")

    expected = {
        "unauthorized": 401, "bad_request": 400, "unsupported_category": 400,
        "unsupported_size": 400, "unsupported_steps": 400, "bad_image": 400, "bad_mask": 400,
        "stretched_reference": 400, "no_model": 409, "invalid_workflow": 400,
        "busy": 429, "duplicate_request": 409, "not_found": 404, "internal": 500,
    }
    for code, status in expected.items():
        check(server.ERROR_STATUS.get(code) == status, f"{code} 的状态码要是 {status}")
        check(code in server.ERROR_MESSAGES, f"{code} 要有人看的文案")
    for gone in ("unsupported_capability", "unsupported_task"):
        check(gone not in server.ERROR_STATUS, f"{gone} 已删(字段改叫 category 了)")
        check(gone not in server.ERROR_MESSAGES, f"{gone} 的文案也要一起走")
    # 文档播报的错误码集合 = 这张表
    check(document_of()["errors"] == sorted(server.ERROR_STATUS),
          "/chp/info 要播报错误码集合, 而且与实现同源")


def check_routes() -> None:
    """Every path the document promises must actually be registered, and only those."""
    check(server.register_routes() is True, "路由注册必须成功")
    check(FAKE_SERVER.app._client_max_size == server.MAX_BODY_BYTES, "请求体上限要交给 aiohttp")

    expected_get = {f"{server.API_ROOT}{suffix}" for suffix in
                    ("/info", "/jobs/{job_id}", "/jobs/{job_id}/progress",
                     "/jobs/{job_id}/output/{index}")}
    expected_post = {f"{server.API_ROOT}{suffix}" for suffix in
                     ("/jobs", "/jobs/{job_id}/cancel", "/translate")}
    check(FAKE_SERVER.routes.registered["GET"] == expected_get,
          f"GET 路由不对: {sorted(FAKE_SERVER.routes.registered['GET'])}")
    check(FAKE_SERVER.routes.registered["POST"] == expected_post,
          f"POST 路由不对: {sorted(FAKE_SERVER.routes.registered['POST'])}")

    # 文档里播报的端点必须与实际注册的一致(除了占位符写法)
    for path in capabilities.ENDPOINTS.values():
        check(path in FAKE_SERVER.routes.registered["GET"] or path in FAKE_SERVER.routes.registered["POST"],
              f"文档播报的端点 {path} 没有注册")
    # 别名根一个都不许注册
    every = FAKE_SERVER.routes.registered["GET"] | FAKE_SERVER.routes.registered["POST"]
    check(not any(path.startswith("/cvp") or path.startswith("/hamdraw") for path in every),
          f"/cvp 与 /hamdraw 下面什么都不许服务: {sorted(every)}")

    # /chp/info 是公开的: 没有密码也要答
    response = asyncio.run(server.info(FakeRequest(None)))
    check(response.status == 200 and response.payload["spec"] == "chp/2", "信息接口要公开可答")
    check(response.payload["auth"]["required"] is False, "没设密码时 required=false")
    check(set(response.payload["endpoints"]) == set(capabilities.ENDPOINTS), "接口要播报地址")


def main() -> None:
    # 先判**源表**, 再判从它生成的文档: 规则表写错了, 报出来的应该是"顺序错了"这种
    # 具体诊断, 而不是下游某条 schema 对不上。反过来排的话, 一个坏规则会先撞在
    # schema 的断言上, 读的人得倒推三层才知道源头在哪。
    check_rules_table()
    check_information_document()
    check_category_lookup()
    check_frames_table()
    check_frames_assembly_assertions()
    check_abilities_grouping()
    check_translation_memory()
    check_settings()
    check_request_channels()
    check_request_ext_defaults()
    check_request_accelerator()
    check_request_categories()
    check_request_frame_membership()
    check_request_renamed_fields()
    check_request_auth()
    check_request_bad_bodies()
    check_request_idempotency()
    check_output_urls()
    check_server_surface()
    check_routes()

    document = document_of()
    # ``rules`` 是**每个类别**一条（同一个规则的类别共用一条规则串），所以这里两个数都报：
    # 只报类别数会让人以为规则数跟着类别数走，而这正是本轮要拆开的两件事。
    rule_kinds = sorted({str(entry["rule"]) for entry in document["rules"]})
    print(f"test_spec.py: ok ({len(rule_kinds)} 条规则 {rule_kinds},"
          f"{len(document['rules'])} 个类别,"
          f"{len(document['abilities'])} 条能力,"
          f"{sum(len(item['frames']) for item in document['abilities'])} 帧,"
          f"{len(document['input_schemas'])} 份输入 schema,"
          f"{translate.memory_size()} 条翻译记忆,"
          f"插件 {document['plugin']['id']} {document['plugin']['version']},"
          f"根 {server.API_ROOT}, 契约 {document['spec']})")


if __name__ == "__main__":
    main()
