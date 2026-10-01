# CHP 插件 — ComfyUI Haminn Protocol

CHP 是 **ComfyUI Haminn Protocol**；这个目录是它的**参考实现**，名字叫 `hamdraw_chp`。

任何客户端（HamDraw 本体、其他开发者的工具、只会发 curl 的脚本）只要认下面这一个 HTTP 契约，就能用你已经装好的 ComfyUI 出图，**不需要自己导出工作流 JSON** —— 五个场景的图都内置在插件里。

- 规范标识：`chp/2`（响应体里的 `spec`）
- 接口根路径：`/chp`（**路径不版本化**；地址一律从文档的 `endpoints` 里读，客户端不要自己拼）
- 契约文本：[`plans/chp-spec.md`](../plans/chp-spec.md)；落地计划：[`plans/chp-v2-plan.md`](../plans/chp-v2-plan.md)
- 目录：把 `hamdraw_chp/` 整个放进 ComfyUI 的 `custom_nodes/`

**新客户端第一步先调信息接口**（公开，不要密码）：它一次给出这台机器上**有哪些场景、每个场景收什么请求体、背后是哪几个模型文件、每个场景能出哪些画幅、这条场景的编码器认不认中文、以及你带的密码对不对**。

## 安装

1. 拷贝目录：

   ```bash
   cp -r hamdraw_chp  <你的 ComfyUI>/custom_nodes/hamdraw_chp
   ```

   容器部署时把这个目录挂进去即可（宿主路径 → 容器 `custom_nodes/hamdraw_chp`），改完重启 ComfyUI。

2. **没有额外依赖**，只用 ComfyUI 自带的 `aiohttp` / `folder_paths` / `execution`；也不用改 `requirements.txt`。

3. 重启后在 ComfyUI 节点菜单里搜 **HamDraw**，会看到三个节点：

   | 节点 | 用途 |
   |---|---|
   | **HamDraw 配置 (Config)** | **用户唯一需要操作的节点**：设密码 + 选三套 checkpoint + 参考图重绘/纯文生图那两路的三个槽位与各自的加速 LoRA + 翻译后端地址 |
   | HamDraw 输入 / 输出 | 输入那个是给人看的观察窗口；输出那个是内置图引用的节点类。插件**不接受**用户自备的自定义工作流 |

4. 想确认装好了：

   ```bash
   curl -s http://127.0.0.1:8188/chp/info
   ```

   返回 JSON，且 `spec` 为 `chp/2`、`plugin.version` 是你期望的那一版（当前 **3.1.1**）、每个能力的 `ready` 为 `true`，即成功。

   信息端点**密码填错也照答**（此时 `auth.authorized` 为 `false`），所以“地址对不对”和“密码对不对”可以一次问清：能返回 JSON 说明地址通，`authorized` 说明密码。

   **插件版本只有一个出处**：`hamdraw_chp/version.py` 的 `__version__`。发布包名（`tools/package-plugin.py`）与 App 内嵌副本（`tools/embed-plugin.py`）都读它，不会各自漂移。

## 配置（HamDraw 配置节点）

| 字段 | 说明 |
|---|---|
| `password` | **访问密码**。填了就只有带对密码的请求能出图；**留空 = 不校验**。 |
| `fast_checkpoint` | 快速生图用的模型，默认 `DreamShaper8_LCM.safetensors` |
| `inpaint_checkpoint` | 局部重绘用的模型，可填 `(same as fast)` 复用上一个 |
| `upscale_checkpoint` | 图像放大用的模型，同样支持 `(same as fast)` |
| `qwen_unet` / `qwen_text_encoder` / `qwen_vae` | `render` 与 `generate` 两路共用的**三个槽位**（diffusion model / 文本编码器 / VAE），与上面的 checkpoint 互不影响 |
| `render_lora` / `render_lora_strength` / `render_sigmas` | `render` 那一路的**加速档案**（见下节），出厂留空 = 不加速 |
| `generate_lora` / `generate_lora_strength` / `generate_sigmas` | `generate` 那一路的加速档案，同样出厂留空 |
| `translate_prompts` / `translator_url` | 是否启用自动翻译，以及翻译后端地址 |

**三套 checkpoint 其实是同一个槽位加两次覆盖**：`inpaint` / `upscale` 留空就回落到 `fast` 那个，所以只填一次也能跑那三个场景；填了就用自己那个。`render` / `generate` 那两路要三个文件都填齐才算 `ready`，只填一半时信息接口会把它们标成 `ready: false` 并在 `abilities[].missing` 里点名缺哪个槽位。

### 加速档案：省时间的那条路（部署调参，出厂留空）

默认的 `render` / `generate` 走满步数（30 步左右），单张约 6.5 秒固定开销 + 每步 1.16 秒。给某一路配一份**加速档案**就换成"少步数 + 显式 sigma 表"：

```json
"accelerators": {
  "render":   {"lora": "acc_pdd_4step_comfy.safetensors", "strength": 1.0,
               "sigmas": "1.0, 0.9169867038726807, 0.7861579060554504, 0.5494909882545471, 0.0"},
  "generate": {"lora": "acc_viggle_6step.safetensors",    "strength": 1.0,
               "sigmas": "1.0, 0.9375, 0.875, 0.75, 0.5, 0.25, 0.0"}
}
```

三条规矩：

- **`sigmas` 的长度必须等于步数 + 1**，对不上整条档案不生效（那一档步数下的 sigma 表是模型训练时就定下的，凑不出来）。步数由长度反推，客户端一个 step 都不用发。
- **只有配对的那个 LoRA 真的在 `models/loras` 里，档案才生效**。配了却没装不会报错，只在日志里留一行，然后**安静地退回满步数** —— 一台机器换硬盘不该让出图直接失败。
- 加速只在**那一档步数**上成立，所以档案是按类别分的：`render` 可用 4 步 PDD，也可用 6 步 Viggle；`generate` 可用 6 步 Viggle。实际采用哪套由各类别自己的加速档案决定。

档案**只在部署侧写**：一个"4 步蒸馏 LoRA"的文件名只对装了它的那台机器成立（同 `translate.url` 与 `cache_dtype`）。

配置写在 `custom_nodes/hamdraw_chp/hamdraw_settings.json`（原子写、可手工编辑）；也可以直接用环境变量 `HAMDRAW_PASSWORD` 覆盖密码（适合容器/CI）。

**部署调参（手工编辑设置文件）**：`families.qwen_image_21` 下三项。`cache_device` / `cache_dtype` 控制 Qwen 的 KV 缓存（默认 `auto` / `default`，即模型作者的建议值）；**显存吃紧的机器**改成 `cache_dtype: "int8"`。`reference_edge` 是**参考图的编码预算**（原生引擎管它叫 `reference_resolution`）：参考图先按**面积**缩到“约 edge² 像素”再进编码器（`ImageScaleToTotalPixels`，**保持原图自己的比例**, 对齐到 32），默认 `1024`（核心节点自己的默认值），想省算力可以写小；**它不影响出图画幅**。参考图的**比例永远保留**：画幅由采样 latent 决定，参考图只说“长什么样” —— 按硬目标框去缩会把定妆照拉变形。插件不会替某台机器做这些假设 —— 环境变量 `HAMDRAW_TRANSLATE_URL` / `HAMDRAW_TRANSLATE_MODEL` / `HAMDRAW_TRANSLATE_DISABLED` 同理。

`HAMDRAW_*` 环境变量、`hamdraw_settings.json`、`hamdraw-comfy-settings/v1` 这些**盘上数据的格式标识故意没跟着协议改名** —— 它们是格式标识，不是产品名，改名只会让每台机器都要重新配一遍。

**密码错了会怎样**：请求在**入队之前**就被拦下，返回 `401 unauthorized`，**不会生图**。客户端拿到的是一句可读的中文提示，而不是一张画错的图。

## 五个场景（`category`）

`category` 就是请求体字段名，取值只有这五个，**没有别名**：`fast` / `inpaint` / `upscale` / `render` / `generate`。

| `category` | 规则 | 参考图 | 画幅（帧表，首项即默认） | 步数枚举与默认 | 参考权重默认 | 提示词语言 | 说明 |
|---|---|---|---|---|---|---|---|
| `fast` | `txt-ref-2-img` | 要 | 1:1 `512x512`；4:3 `576x384`；3:4 `384x576` | 2 / 4 / 6 / **8** | 0.55 | **只认英文** | 把画布当参考图重绘一张速写稿 |
| `inpaint` | `txt-msk-ref-2-img` | 要（+蒙版） | 同 `fast`（蒙版必须与画布同尺寸） | 4 / **6** / 8 / 12 | 0.30 | **只认英文** | **只重画白色蒙版区域**，其余原样保留 |
| `upscale` | `txt-ref-2-img` | 要 | 1:1 `1024x1024`、`2048x2048` | 4 / **8** / 12 / 16 / 20 | 0.75 | **只认英文** | 参考图按**原分辨率**（上限 1024）直接编码；只有目标大于上限时才 latent 放大。**不要退回“先缩到 512 再放大”**——那等于在采样器看到参考图之前先模糊它一轮，渲染出来会发软、像被重新演绎过。 |
| `render` | `txt-ref-2-img` | **要** | 9:16：`768x1344`（中，默认）/ `512x896`（低）/ `896x1568`（高） | 4 / 6 / 8 / 12 / **20** | 0.95 | **英文更佳**（中文也吃） | **给定一张图重新生成**：给张图（定妆照、姿势骨架、随手一张照片）加一句描述，重画成一张成品图 —— 构图由参考图带来。模型是 Qwen-Image 2.1（官方 INT8）的 unet + clip + vae 三件套。 |
| `generate` | `txt-2-img` | **不收** | 9:16：`768x1344`（中，默认）/ `512x896`（低）/ `896x1568`（高） | 6 / 8 / 12 / **20** | — | **英文更佳** | **纯文字生成**：只给一句描述，从零画一张成品图，一个字节的输入图都不带。**没有定妆照时走这一条**（Chataxi 就是这么用的）。 |

**步数只管"没配加速档案"的那条路**：客户端不发 `ext_params.step` 时，配了加速档案的场景走**档案自己那一档**（本机 `render` 配 Viggle 时为 6 步），没配的走上表里的默认值（20）。枚举里留着 4 与 6 就是为了让 PDD / Viggle 加速档案的步数合法（见「加速档案」一节）。

**`render` 与 `generate` 是两条规则、两个类别，不是同一条规则的两个用法**（2026-10-01 分开）。理由是"有没有参考图"决定的是**图怎么搭**：一条走参考条件生成，一条从空 latent 起步，两者连节点都不一样。把它做成"同一条规则，带不带图随你"会让客户端只能靠**试探**去发现这件事 —— 分开之后，客户端从规则名本身就看得出来（`txt-ref-2-img` 里有 `ref`，`txt-2-img` 里没有），而服务端也会**明确拒收**：给 `generate` 发 `image_base64` 回 `400 bad_image`，文案就是"这个场景不收参考图"。

**就绪状态与画幅各归各的场景**：两条场景可以落在同一个模型文件组上（本实现里就是同一组 Qwen 三件套），也可以落在两组上；`abilities[].frames` 按 `category` 分开列，客户端按需读。

**画幅就是这张表，没有第二条路。** 每个场景的 `frames` 是手写的，顺序是规范的一部分：第一档就是**省略 `resolution` 时的默认**。请求里的 `resolution` 是一个**字符串**（`"768x1344"`），只能逐项命中那张表，否则 `400 unsupported_size`。没有“域”，没有“这个比例合法但不在清单里”，也**没有需要客户端自己算的东西** —— 先把 `ratio` 列给用户选，再列该比例下的 `resolution`，两步零算术。

`"9:16"` 是**标签不是算出来的比例**：`768 × 1344` 的精确比是 4:7，叫它 9:16 是作者定的类目名（和相机的画幅档位一个道理）。客户端**只显示、不反推**。

**`render` / `generate` 的三档是按 Qwen-Image 2.1 自己的竖幅档位定的**（2026-10-01，业主：「分辨率改用 Qwen 2.1 推荐的 9:16 的档位」「只是 happ 要迁就 qwen2.1，不是相反」）。Qwen 2.1 公布的两档竖幅是 `768×1344`（1K）与 `1536×2688`（2K），两条边的比是 4:7；2K 那条的高是 2688，远超 16 GB 卡能舒服跑的上限，所以三档**按同一个 4:7 几何**取：中就是官方 1K 原样、低 `512x896`、高 `896x1568`（业主定的上限 1600 之内、下限 500 之上）。三条边都是 16 的倍数（Qwen 的 VAE 压缩倍率）。默认是第 0 条 ⇒ **中档**；**加档一律往该档的数组末尾追加**，往前面插一条会让每个客户端的默认画幅一起换掉。其余比例整条删掉：两个客户端要的都是竖幅，而"菜单越短、越不容易选错"。

**推荐模型**：DreamShaper8 LCM 系列（512 分辨率通常 1 秒左右出图）。`fast` / `inpaint` 建议就用它，不必换；`upscale` 用能接受 512 参考图、输出 1024/2048 的模型即可。`render` / `generate` 走 Qwen-Image 那一族，与前三套的 checkpoint 完全独立。

### 语言：谁认中文，由场景自己报

`fast` / `inpaint` / `upscale` 是 **SD1.5 + CLIP-L** 结构，文本编码器只吃英文；`render` 的编码器是 **Qwen3-VL**，中文是它的母语。这不是猜的，是两条独立证据：

- 官方口径：Qwen-Image 系支持中英双语提示词，SD1.5 / SDXL 那套 CLIP-L 不支持。
- 真机实测：固定 seed 与参考图，只换提示词跑四单 `render`，比较逐像素平均差。**中文 vs 它的英文译文 12.38，中文 vs 无关提示词 21.40，中文 vs 空提示词 27.73**——中文把画面带到了它英文译文去的地方，噪声做不到这件事。

于是每个场景的 `prompt.language` 是 `"en"` 或 `"any"`，客户端**不要自己写死**。

**但界面上一律建议写英文**，这正是 HamDraw 两个提示词输入框里的那句 `英文可以获得更佳效果`：`"en"` 的场景不过翻译这一道，就没有译错的余地；`"any"` 的场景写英文也照样走通，只是那并不是唯一走法。

### 翻译：推荐流程，不是规则

`prompt.language` 为 `"en"` 的场景，如果提示词**含非 ASCII 可打印字符**（中文、俄语、希腊语、阿拉伯语、泰语都算），插件在**提交时自己翻**：

```
提交 → 需要翻? ─否→ 用原文建图
              └是→ 查翻译记忆库 ─命中→ 用译文
                              └未命中→ 调翻译后端 → 成功则存库并用译文
                                                    └失败→ 用原文建图(任务不失败)
```

- 客户端**可以**先调翻译接口把译文显示给用户，也可以什么都不做 —— 什么都不做也不会把中文喂进只认英文的编码器。
- **判据是“是不是全 ASCII”**，不是“有没有中文”：CLIP-L 对西里尔/希腊字母一样两眼一抹黑，只看中日韩会让它们原样过去变成噪声。
- 记忆库落盘在插件目录的 `hamdraw_translations.json`，重装、重启都不丢。**键 = 原文 + 目标语言**：一条翻译是语言事实，与哪个引擎翻的无关；引擎与提示词版本作为旁注记下来（将来换更好的引擎重刷时按它筛），不进键。
- 后端只要求 **OpenAI 兼容的 `POST {url}/v1/chat/completions`**（llama.cpp / vLLM / Ollama / 各家云 API 都行）。**默认地址是空的，也就是关闭** —— 插件不替任何部署写死一个地址。

### `ref_strength` 是唯一的权重入口

它是“**参考图权重**”：越高越贴近你画的原稿，越低越放手重画，值域 **0.05–0.95**（越界会被夹到边界并在 `job.ref_strength` 回显，不报错）。至于实现怎么做到，是各家族自己的事：

- 图生图家族（`checkpoint`）把它换算成去噪强度：`denoise = clamp(1 - ref_strength, 0.05, 1.0)`；
- 参考条件生成家族（`qwen_image_21`）没有可保留的初始 latent，改成**把参考图本身柔化**：越高越原样交给编码器，越低肢体轮廓越发散。

两种机制都满足“越大越贴近”，所以都合规，客户端滑杆逻辑完全一样。

## HTTP 契约

`endpoints` 是**规则不是建议**：把用户填的地址原样当信息接口请求一次；若它不是 CHP 文档、且地址里没有路径，再试一次推荐的 `/chp/info`；两次都不成就是“这个地址不是 CHP 服务”。拿到文档之后，**其余地址全部从 `endpoints` 里读**，不要自己拼。

| 键 | 值 | 鉴权 | 说明 |
|---|---|---|---|
| `info` | `GET /chp/info` | **公开** | 信息文档：规则表 + 能力表 + 两份请求 schema + 翻译可用性 + 错误码。密码错了也照答，由 `auth.authorized` 说明 |
| `jobs` | `POST /chp/jobs` | 见下 | 提交作业 → **202** `{"job": {…}}` |
| `job` | `GET /chp/jobs/{job_id}` | Bearer | 状态 + 提示词 + `outputs`（较重，完成后再调） |
| `progress` | `GET /chp/jobs/{job_id}/progress` | Bearer | **高频轮询用**：只回 `{id, state, queue_position, progress}`，不解析结果 |
| `output` | `GET /chp/jobs/{job_id}/output/{index}` | Bearer | 取成图（直接返回 PNG） |
| `cancel` | `POST /chp/jobs/{job_id}/cancel` | Bearer | 取消排队中的作业 |
| `translate` | `POST /chp/translate` | 见下 | 提前翻译（可选，用于把译文显示给用户） |

**`progress` 允许为 `null`，而且经常就是 `null`。** 编一个假百分比比给 `null` 更糟；`queue_position`（前面还有几个作业，自己在跑时为 0）是任何实现都算得出来的可靠数字，客户端用不确定态 + 队列位置就够了。

### 密码放在哪：一个请求只用一种载体

| 请求 | 载体 |
|---|---|
| **带 body 的 `POST`**（提交任务、翻译） | `chp_params.password` |
| `GET` 与**无 body 的 `POST`**（轮询、取状态、取图、取消） | `Authorization: Bearer <password>` —— **唯一例外，理由是密码不进 URL 也不进日志** |

参考实现**继续也接受** `Basic` 与 `X-HamDraw-Password`（今天三个都认），所以这条规矩是“新写的按字段、拿不到 body 时才用头”，不是把老路堵死。密码为空时不需要。

### 两个扩展通道

| | `ext_params` | `chp_params` |
|---|---|---|
| 层 | **模型层**（这次画什么） | **CHP 层**（这次怎么连、怎么算账） |
| 住户 | **规范一个都不定义** | CHP 定义：目前只有 `password` |
| 谁校验 | 没有人。**原样携带、原样回显** | 参考实现校验 `password` |

**`ext_params` 里没有官方字段表**：放什么进来都由你自己的客户端自己读，插件不筛不校验，`job.ext_params` 原样带回你发的那个对象（含嵌套结构）。

**本实现自己认识两个键**（这是它的行为，不是协议条文，所以写在这里而不是规范里）：

- `ext_params.step` —— 步数。**枚举**，取值就是上表里那个枚举，越界 → `400 unsupported_steps`；省略取该场景自己的那一档（配了加速档案就是档案的步数，否则是上表的默认值）。小数会被拒（`20.5` 不是 `20`）。
- `ext_params.negative_prompt` —— 反向提示词。`render` / `generate` 按 cfg 1 采样，它没有作用面，但插件照收。

### 提交体（每个类别共用一份基础 schema）

| 字段 | 类别 | 说明 |
|---|---|---|
| `category` | 规则参数，必填 | `fast` / `inpaint` / `upscale` / `render` / `generate` |
| `resolution` | 规则参数，**必填** | `"768x1344"` 这样的**字符串**，必须逐项命中该 `category` 的帧表；少了 → `400 unsupported_size`，表外 → 同一个码 |
| `prompt` | 规则参数 | 是否需要先译成英文由 `rules[].prompt.language` 决定 |
| `seed` | 规则参数，**必填** | **留在顶层**：少了它前端就无法锁定重复生成（少发 → `400 bad_request`）。`0` = 每次不同 |
| `ref_strength` | 规则参数 | 0.05–0.95，越界**夹到边界**并在 `job` 回显。只跟参考图一起发 —— 它是"要多像这张参考图"，没有图的时候没有意义 |
| `image_base64` / `mask_base64` | 规则参数 | 参考图 / 蒙版（**白 = 要重画**）。图片可直接给 data URL，插件自己解码；请求体上限 32 MB。**规则签名里没有 `ref` 的类别（`generate`）收到 `image_base64` 会被拒**（`400 bad_image`）—— 这是"想画一张没有参考图的图"走错场景时唯一的当场信号 |
| `ext_params` | 扩展通道 | 任意 JSON 对象 |
| `chp_params` | 扩展通道 | 目前只有 `password` |
| `request_id` | 提交身份，可省 | 你自己这次提交的编号。**重发同一次提交就沿用同一个值**，服务端还你原来那个作业、不会再排一个；内容变了就换一个值。见下节 |

**其余顶层字段一律忽略，并把名字回显到 `job.ignored`。** 这条回执不是可选项：没有它，一次参数改名对客户端就是**静默失效**。`capability` / `task` / `size` / `steps` / `negative_prompt` 这五个 v1 的顶层字段现在都不认了 —— 客户端漏改时会当场在 `ignored` 里看到自己发错的那个名字（甚至没带 `category` 时那份 `400` 的 `detail` 里也带着这份名单）。

```json
{
  "category": "fast",
  "resolution": "512x512",
  "prompt": "a red fox",
  "seed": 12345,
  "ref_strength": 0.55,
  "image_base64": "data:image/png;base64,...",
  "ext_params": { "step": 8, "negative_prompt": "" },
  "chp_params": { "password": "<password>" },
  "request_id": "0f9c1e2a-…"
}
```

### `request_id`：一次提交只出一个作业

**要解决的问题是真的**：一次提交在服务端跑了 20 秒、回程却断了（客户端等超时、换了网络、App 被杀），这时**图已经生成好了**，而客户端手里没有作业号 —— 它只能再提交一次，于是队列里多出一个作业，第一张图谁也没来取。

`request_id` 就是给这次提交一个身份，规则四条：

| 情形 | 服务端 |
|---|---|
| 键没见过 | 正常提交，`202` + `"replayed": false`，键记住 |
| 同一个键 + **同样的内容** | **不排队、不写图**，直接答**原来那个作业的此刻状态**，`202` + `"replayed": true` |
| 同一个键 + 换过的内容 | `409 duplicate_request` —— 一个键只装一次提交，改内容就换个键 |
| 同一个键、上一次**还在处理中** | `409 duplicate_request` —— 稍后用同一个键再问一次即可 |

**内容**指的是除 `chp_params`（那是密码）和 `request_id` 自己以外的整个请求体；字段顺序不影响判定。**提交失败（`no_model` / `bad_image` / 校验不过…）会把键还回来**，所以一次失败不会挡住你自己的重试。整个字段是可选的：`request_id` 一个都不发的旧客户端照常工作。

完成后的 `outputs[n].url` 就是文档里公布的模板拼出来的那条 `/chp/jobs/...`，**客户端直接拼服务器地址去下就行，不要再拼一层**。

`job` 对象里三个字段回答“提示词到底发生了什么”：`prompt_source` 是客户端给的原文、`prompt` 是实际送进模型的那份、`translated` 表示两者是否不同。

错误码：`unauthorized(401)` / `bad_request` / `unsupported_category` / `unsupported_size` / `unsupported_steps` / `bad_image` / `bad_mask` / `stretched_reference` / `invalid_workflow` / `no_model(409)` / `busy(429)` / `duplicate_request(409)` / `not_found(404)` / `internal(500)`，全部带可读中文文案。`/chp/info` 的 `errors` 就是这份清单，所以客户端不必自己抄一遍。

### `/cvp` 与 `/hamdraw/v1` 都不存在了

插件 2.3.0 之前叫 CVP，主根是 `/cvp`；改名成 CHP 之后主根是 `/chp`，`/cvp` 曾作为过渡别名保留。**`chp/2` 起别名整条删掉**：客户端被告知从 `endpoints` 里读地址，于是“同一个 API 的两种拼法”成了一个这一版故意不再做的承诺。`/hamdraw/v1` 那套旧投影面更早以前就整块删除了。

## 自测

```bash
# 0. 离线自检（不需要 ComfyUI、不需要网络、不需要 aiohttp）
python3 tests/test_spec.py
python3 tests/test_mask_graph.py

# 1. 信息接口：有哪些场景、各自收什么、画幅有哪些、谁只认英文、模型就绪没
curl -s http://<host>:8188/chp/info

# 2. 提交 + 轮询 + 取图（密码在 body 里）
curl -s -X POST http://<host>:8188/chp/jobs -H 'Content-Type: application/json' \
  -d '{"category":"fast","resolution":"512x512","prompt":"a red fox","seed":1,
       "image_base64":"data:image/png;base64,...",
       "chp_params":{"password":"<password>"}}'

# 其余接口没有 body，密码走头
curl -s -H 'Authorization: Bearer <password>' http://<host>:8188/chp/jobs/<id>/progress
curl -s -H 'Authorization: Bearer <password>' -o out.png http://<host>:8188/chp/jobs/<id>/output/0

# 3. 中文提示词（fast 只认英文，插件会自动译英，响应里 translated: true）
curl -s -X POST http://<host>:8188/chp/jobs -H 'Content-Type: application/json' \
  -d '{"category":"inpaint","prompt":"一只红色的狐狸","image_base64":"data:image/png;base64,...",
       "mask_base64":"data:image/png;base64,...","chp_params":{"password":"<password>"}}'
```

用 `python3 -m json.tool` 过一遍第 1 步的返回，重点确认五件事：`spec` 是 `chp/2`、`rules` 有你预期的五条、`abilities` 的 `ready` 为 `true`、每个 `category` 至少命中一帧、`input_schemas` 恰好三份（三条规则各一份）。

- **第一次请求会慢**（模型加载，约十几秒），之后同模型重跑约 1 秒；别用首单判断“模型太慢”。
- 在 HamDraw App 里对接：设置 → 模型配置 → 接口模式选「CHP 插件（ComfyUI Haminn Protocol）」，服务器地址填 `http://<host>:<port>`，访问密码填节点里设的那个。
