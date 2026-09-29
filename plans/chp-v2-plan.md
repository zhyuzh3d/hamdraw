# CHP v2 开发计划 —— ComfyUI Haminn Protocol

> **依据**（业主 2026-09-29 三批定稿，逐条照抄不改写）：
> ①「所有适配使用场景字段使用纯英文 fast，upscale，inpaint，render」
> ②「所有适配 IO 规则字段使用 `-2-` 分隔输入输出……只写输入输出的对象类型，不写参数……目前只有 2 种规则 `txt-ref-2-img`、`txt-msk-ref-2-img`」
> ③「CHP 提供每个功能分类的信息 frame……**不要让前端计算，直接先选比例再选分辨率**」
> ④「seed 留顶层，因为这是控制的必要参数，少了它前端就无法锁定重复生成」
> ⑤「扩展参数通道……要单独的总闸门字段，比如 `ext_params`。happ 提交也必须放在 `ext_params` 字段，如 `ext_params.step`。chp 直接忽略暴露在外面的非必要参数」
> ⑥「不需要考虑兼容，直接一步到位，不考虑旧版本情况，现在这个协议只有我们自己三个 happ 在用」
> ⑦「用户自带工作流不需要，我们推荐的方法就是用户直接修改 chp 插件使用」
> ⑧「重新定义为 ComfyUI Haminn Protocol，下载的包叫 CHP 插件」
> ⑨「部署调优……应该被看做是 CHP 整个层级的『扩展参数』，而不是模型层级的。比如说 password……happ 的调用方式就是把它放在一个单独的字段内，xxx.password」
> ⑩「规则就是必须有一个公开可以直接访问的信息接口，然后由 happ 来从里面获取能力接口地址去调用……这个应该是推荐而不是规则」
> ⑪「ext_params 里面的字段是没有官方规则的！完全用户自己定制，可以添加任意字段给自己的 happ 解析使用」
> ⑫「CHP 对于接口中的功能模型 frame 的最低要求就是至少有一个可用的宽高比作为默认，不约定到底支持什么宽高比和分辨率」＋ 业主给出的 `models` / `rules` 两个骨架（**`models` 这一层名字于同日定稿改叫 `abilities`**）
> ⑬「改名要注意三个 happ 里面配置的 UI 显示名字」
>
> 差异的**由来**见 [`chp-review.md`](./chp-review.md)；规范正文（改完的权威文本）在 [`chp-spec.md`](./chp-spec.md)，
> **当前仍是 v1**，改写是本文 P0；v1 的落地记录留在 [`chp-plan.md`](./chp-plan.md) 不动。
> **本文只写：定稿是什么、怎么做、顺序、判据。**

---

## 0 一句话范围

`chp/1` → `chp/2`：**信息文档从「一张能力表」改成「`rules` + `abilities` 两张表」，画幅挂到 `abilities[].frames[]`、分辨率写成字符串，非必要参数走 `ext_params`（模型层）与 `chp_params`（CHP 层）两个通道，调用地址一律从文档的 `endpoints` 里读，协议正名为 ComfyUI Haminn Protocol。**

因为⑥「不考虑兼容」＋⑪（`ext_params` 没有官方字段），**这一轮是净删代码的**：算画幅的五件套、别名机制、`/cvp` 别名、`task` 旧拼写、`ignores`、`size_domain`、`values`、`capabilities` 数组、文档级的模型文件清单、客户端的域内自算与比例反推，全部拆掉（见 §2）。
**不新增能力、不引入注册机制、不动 `/chp` 路径。**
**本轮只动插件 + hamdraw + chataxi**（业主：**PoseGi 稍后单独改，现在不用管它**）。
**以 hamdraw 为首要参考，chataxi 次之**（chataxi 的体验改进另案，本轮只做到「跟上协议、门禁全绿」）。

---

## 1 定稿（不再讨论）

### 1.1 信息文档 = `rules` + `abilities` 两张表

```json
{
  "spec": "chp/2",
  "plugin": { "id": "hamdraw_chp", "label": { "zh": "…", "en": "…" }, "version": "3.0.0" },
  "auth":   { "required": true, "authorized": false, "scheme": "Bearer", "header": "Authorization", "hint": "…" },
  "endpoints": {
    "info": "/chp/info", "jobs": "/chp/jobs", "job": "/chp/jobs/{job_id}",
    "progress": "/chp/jobs/{job_id}/progress", "output": "/chp/jobs/{job_id}/output/{index}",
    "cancel": "/chp/jobs/{job_id}/cancel", "translate": "/chp/translate"
  },
  "rules": [
    { "category": "fast",    "rule": "txt-ref-2-img",     "needs": { "prompt": true, "image": true,  "mask": false },
      "prompt": { "language": "en" },  "defaults": { "ref_strength": 0.55 }, "typical_seconds": 1.2 },
    { "category": "inpaint", "rule": "txt-msk-ref-2-img", "needs": { "prompt": true, "image": true,  "mask": true  },
      "prompt": { "language": "en" },  "defaults": { "ref_strength": 0.30 }, "typical_seconds": 2.6 },
    { "category": "upscale", "rule": "txt-ref-2-img",     "needs": { "prompt": true, "image": true,  "mask": false },
      "prompt": { "language": "en" },  "defaults": { "ref_strength": 0.75 }, "typical_seconds": 6.0 },
    { "category": "render",  "rule": "txt-ref-2-img",     "needs": { "prompt": true, "image": false, "mask": false },
      "prompt": { "language": "any" }, "defaults": { "ref_strength": 0.95 }, "typical_seconds": 45.0 }
  ],
  "abilities": [
    { "name": "DreamShaper8_LCM.safetensors", "ready": true, "missing": [],
      "files": { "checkpoint": "DreamShaper8_LCM.safetensors" },
      "frames": [
        { "ratio": "1:1", "category": "fast",    "resolution": ["512x512"] },
        { "ratio": "4:3", "category": "fast",    "resolution": ["576x384"] },
        { "ratio": "3:4", "category": "fast",    "resolution": ["384x576"] },
        { "ratio": "1:1", "category": "inpaint", "resolution": ["512x512"] },
        { "ratio": "4:3", "category": "inpaint", "resolution": ["576x384"] },
        { "ratio": "3:4", "category": "inpaint", "resolution": ["384x576"] },
        { "ratio": "1:1", "category": "upscale", "resolution": ["1024x1024", "2048x2048"] }
      ] },
    { "name": "qwen2.1", "ready": true, "missing": [],
      "files": { "unet": "…", "clip": "…", "vae": "…" },
      "frames": [
        { "ratio": "1:1",  "category": "render", "resolution": ["1024x1024"] },
        { "ratio": "9:16", "category": "render", "resolution": ["768x1344"] },
        { "ratio": "16:9", "category": "render", "resolution": ["1344x768"] },
        { "ratio": "3:4",  "category": "render", "resolution": ["832x1152"] },
        { "ratio": "4:3",  "category": "render", "resolution": ["1152x832"] },
        { "ratio": "2:3",  "category": "render", "resolution": ["832x1216"] },
        { "ratio": "3:2",  "category": "render", "resolution": ["1216x832"] },
        { "ratio": "21:9", "category": "render", "resolution": ["1536x640"] }
      ] }
  ],
  "input_schemas": { "txt-ref-2-img/v1": { "…": "…" }, "txt-msk-ref-2-img/v1": { "…": "…" } },
  "translation": { "enabled": false }
}
```

**`abilities` 条目是「一组能跑起来的模型文件」**，不是单个文件：checkpoint 系的条目一个文件，`render` 的条目三个文件（`files` 里列着）。
`name` 是**实现自己起的名**（客户端只显示，不解析）；`frames` 是它的画幅表。

四条结构规矩：

1. **`abilities` 有序、`frames` 有序，顺序是规范的一部分**：某个 `category` 的默认画幅 = 跨 `abilities` 按序扫、命中它的第一个 `frame`；全局默认 = `abilities[0].frames[0]`。业主给的 `{'1:1':['512x512',…]}` 与它信息量相同，只是把「顺序」从隐含变成结构。
2. **顶层键就这八个**（`spec`/`plugin`/`auth`/`endpoints`/`rules`/`abilities`/`input_schemas`/`translation`）；未知顶层键客户端必须忽略。
3. **任何一层都允许多余字段**（`rules` 条目、`abilities` 条目、`frame` 条目）：CHP 播报但**不解释**，写这个字段的 happ 自己读。**这一条是⑪的骨架，不是客套** —— 它让「用户加自己的字段给自己的 happ 用」不必改插件源码。（要加一个**新 category** 才需要改插件，那是⑦的路线。）
4. **顶层 `capabilities` 数组与文档级 `models.available` 一起消失**（§2）：前者的职责被 `rules` + `abilities` 分掉，后者零消费者。
   **命名留痕**：新数组原定名 `models`，同日定稿改叫 `abilities` —— 这一改顺带把「顶层 `models` 已被『本机装了哪些模型文件』占用」这个撞车绕开了（那条清单仍然删，理由换成§2 的零消费者）。

### 1.2 类别 = `rules[]` 的一条（四个，无别名）

| 场景 | 含义 | `rule` | `prompt.language` | v1 旧名 |
|---|---|---|---|---|
| `fast` | 一两秒内出图，适合边画边看 | `txt-ref-2-img` | `en` | `quick`（category `realtime`） |
| `inpaint` | 在已有画面上做局部修改 | `txt-msk-ref-2-img` | `en` | category `edit` |
| `upscale` | 放大并补细节，尽量不改构图 | `txt-ref-2-img` | `en` | 同名 |
| `render` | 重画成成品图 | `txt-ref-2-img` | `any` | 同名（`qwen` 别名取消） |

`rules` 条目里**只有 `category` 与 `rule` 是规范键**，其余（`needs` / `prompt` / `defaults` / `typical_seconds`）是参考实现定义的可选键，客户端按需读、读不到就用自己那份。
`category` 同时是**请求体字段名**：客户端要什么就发 `category`，不再有两套词。

### 1.3 IO 规则表（两条，纯类型表达式）

```
<规则>  ::= <输入模态>("-" <输入模态>)* "-2-" <输出模态>
<模态>  ::= txt | ref | msk | img | glb | 3dgs        ← 只写对象类型，不出现参数名
规范序     txt [msk] ref                              ← 默认 txt 开头、ref 接 -2-
```

| 规则 | 输入 | 输出 | 用它的类别 |
|---|---|---|---|
| `txt-ref-2-img` | 文本 + 一张参考图 | 图像 | `fast` / `upscale` / `render` |
| `txt-msk-ref-2-img` | 文本 + 蒙版 + 一张参考图 | 图像 | `inpaint` |

**规则必须支持的参数**（收敛清单，模型缺哪个就在中间工作流里模拟出来）：

| 规则 | 必须支持 |
|---|---|
| `txt-ref-2-img` | `prompt`、`resolution`、`seed`、**`ref_strength`**（方向 0.05–0.95，越大越贴近参考图） |
| `txt-msk-ref-2-img` | 同上 + `mask_base64`（白 = 要重画） |

`ref_strength` 就是「模拟」的现成范例：`checkpoint` 家族换算成 `denoise = 1 − ref_strength`；`qwen` 家族没有可保留的初始 latent，就改成柔化参考图。**v1 已经做对，v2 一个字不改。**

**`grow_mask_by` 不进这张表（2026-09-29 业主定，取代 `chp-review.md` §1.5 的两个建议）。** 它原先按「蒙版语义参数」列入 `txt-msk-ref-2-img`，现在整条删掉：外扩真正发生在**客户端**（hamdraw 的 `canvas-io.js` 把笔迹加粗 `MASK_GROW`，请求里根本不发这个字段），而且**必须**由客户端做 —— 服务端膨胀会把前端羽化出来的软边重新压平成硬边，方向正好相反。v1 的那条链路（`GROW_MASK_RANGE` / schema 属性 / `_FIELD_HELP` / `defaults.grow_mask_by` / `create_job` 的夹边界 / 两个 family 的 `grow_mask_by=` 形参）已整条删除，**v2 不再收**。

两处**比 v1 好**、要写进规范的点：

1. **切分规则从「以最后一个 `2` 为界」改成「按字面 `-2-` 切分`」** —— v1 因此必须额外规定「签名里除分隔符 `2` 以外不出现数字」，**那条禁令现在删掉**：`txt-ref-2-3dgs` 里的 `3` 不再有歧义。
2. **规范序进语法**：`msk-ref-txt-2-img` 不是「另一种写法」而是**非法**（规则名要能被客户端当字符串相等比较）。

**「类别不再自己写 `signature` / `input`」是什么意思**（业主问过）：v1 里四个能力各手抄一遍 `signature: "txt-ref2img"` 与 `input: "txt-ref2img/v1"`，四份。改成 `rules` 条目只写一句 `rule: "txt-ref-2-img"`，那两个字段由插件**生成文档时从规则表查出来填上**。改规则拼法只改一处，四条不会漏改一条。

**「规则里的模态」与「这次必须给什么」是两件事**：规则说的是**能吃什么**，`needs` 说的是**必须给什么**。`render` 的规则是 `txt-ref-2-img`（带参考图就是参考图编辑），`needs.image = false`（不带就是纯文生图）。二者都对。

### 1.4 `frames`：画幅的唯一出处

**画幅不再是「一条模型约束 + 一张算出来的菜单」，而是手写的 `frames` 表**：比例 → 该比例下的分辨率。

| 类别 | `frames`（**现役实现的取值**，不是规范条文） |
|---|---|
| `fast` | `1:1 ["512x512"]`；`4:3 ["576x384"]`；`3:4 ["384x576"]` |
| `inpaint` | 同 `fast`（蒙版必须与画布同尺寸） |
| `upscale` | `1:1 ["1024x1024","2048x2048"]`（**只此一档**：三个客户端发过来的都是 1:1；真要放大竖幅就加一档） |
| `render` | `1:1`、`9:16`、`16:9`、`3:4`、`4:3`、`2:3`、`3:2`、`21:9` 共八档 |

五条设计决定，每条都要写进规范：

1. **分辨率是字符串 `"宽x高"`**，就是业主写的 `'512x512'`。**请求体里也发字符串**（字段名 `resolution`），客户端把菜单里挑中的那个字符串**原样发回来**，全协议零格式化。⇒ 请求字段 `size` 退休（一对数字与一个字符串是同一件事的两个表示，不许并存）。
2. **`resolution` 可省略 ⇒ 取该 `category` 的第一档**（⑫：至少有一个可用的宽高比作为默认）。这是**每个类别自己的默认**，不是全局共用一个。⇒ 不再播报 `defaults.size`（同一个事实的第二个出处）。
3. **校验是成员检查**：`resolution` 不在该 `category` 的帧表里 → `400 unsupported_size`。
   ⇒ **`size_domain` / `fits()` / `sizes()` / `_aligned_down()` / `SIZE_STEP` / `budgets` / `aspects` / `values` 全部删除**。
   **只允许枚举里的比例与分辨率，没有第二种合法值**（业主定稿：**「域内任何比例」这种说法直接取消**）⇒
   规范正文与插件注释里**不许再出现**「域内」「任意比例」「菜单外」「在约束内自己算一张」这类表述（P0 有 `grep` 判据）。
   这是**对第 2 轮决定的收紧**：菜单**就是**模型支持的全部，没有第二条路，也就没有需要客户端自己算的东西 —— 正是③⑩要的「不让前端计算」。
4. **CHP 不约定支持什么比例与分辨率**（⑫）。规范只要求两条，且都是**装配期断言**（发布不出一份坏文档），不是运行期分支：
   - `abilities` 非空，且每个 `category` 至少命中一档 `frame`；
   - `(category, resolution)` 唯一 —— 客户端只发这两个，服务器靠它反查模型，重复就是文档作者的错。
5. **`"9:16"` 是标签，不是算出来的比例**。`768 × 1344` 的精确比是 `4:7`，叫它 9:16 是**作者定的类目名**（和相机的画幅档位一个道理）⇒ **键不由数字反推**，客户端**只显示、不计算**，hamdraw 里那个 `providers.aspect(w, h)` 随之删除。

前端由此得到两步选择：**先选 `frame.ratio`，再选 `frame.resolution`**，零算术。

### 1.5 两个扩展通道：`ext_params`（模型层）与 `chp_params`（CHP 层）

**业主问「xxx 叫什么合适」——定 `chp_params`。** `ext_params` 与 `chp_params` 是同一个构词法的一对：**前缀是层名，后缀是通道**，读一眼就知道该往哪放。

| | `ext_params` | `chp_params` |
|---|---|---|
| 层 | 模型层（这次画什么） | CHP 层（这次怎么连、怎么算账） |
| 住户 | **规范一个都不定义**（⑪） | **CHP 定义**：目前只有 `password` |
| 谁校验 | 没有人。**原样携带、原样回显** | 参考实现校验 `password`（对不上就是 401） |
| 谁能加 | 任何人加任何字段，自己的 happ 自己读 | 只有改协议能加 |

**为什么不叫 `deploy_params`**：那片参数要区分的不是「谁去改」，而是**层**。部署项（§1.7）是运维在那台机器上改的，**根本不出现在 HTTP 上**；`chp_params` 里装的是**调用方必须随请求交上来的 CHP 层参数** —— 今天恰好只有 `password` 一个住户。叫 `deploy_params` 会让人以为能远程改设置。

**`ext_params` 的规矩（⑪照做）**：

- **没有官方字段表**：v1 的能力级 `ext_params` 声明、白名单过滤、逐键校验**全部删除**。
- **原样携带 + 原样回显**：`job` 里带回收到的那个对象，这样 happ 放进去的自己的字段能读回去（⑪说的「给自己的 happ 解析使用」就是这条路）。
- **参考实现认识自己那两个键**（`step`、`negative_prompt`），**写在它自己的 README 里，不写进规范**。它对自己认识的那个 `step` 仍然按枚举判（越界报 `unsupported_steps`）—— 那是**实现的行为**，不是协议条文，规范错误表里对应行要注明「参考实现自己的键」。
- **`ignores` 字段撤销**：它 v1 里只装过 `negative_prompt` 一个值，与「哪些扩展参数生效」重复；`render` 按 cfg 1 采样、反向提示词本来就没有作用面，所以**不再播报、也不再读**。
- **顶层闸门照旧硬**：不在规则参数里、也不在 `ext_params` / `chp_params` 里的顶层字段，**直接忽略**（不报错），名字回显到 `job.ignored`。回显不是可选项 —— 没有它，「`negative_prompt` / `steps` 搬家」对客户端就是**静默失效**。

**`chp_params.password` 的载体规矩**（一个请求只用一种载体，避免「两个都发」）：

| 请求 | 载体 |
|---|---|
| 带 body 的 `POST`（提交任务、翻译） | `chp_params.password` |
| `GET` 与**无 body 的 `POST`**（轮询、取状态、取图、取消） | `Authorization: Bearer <password>` —— **唯一例外，理由是密码不进 URL** |

参考实现**继续也接受** `Authorization`/`Basic`/`X-HamDraw-Password`（今天三个都认，v2 不减），所以这条规矩是「新写的按字段、拿不到 body 时才用头」，不是把老路堵死。
**被否掉的两个方案**：① 公开整个读接口（输出图的 uuid 虽然猜不到，但那是拿安全换省事）；② 把 `chp_params` 塞进 query string（密码会进 URL 与日志）。

### 1.6 暴露路径：`endpoints` 是**规则**，`/chp/*` 是**推荐**

| | 内容 |
|---|---|
| **规则**（⑩） | 必须有一个**公开、可直接访问、不要密码**的信息接口；它的地址**就是用户填进 happ 的那个地址**；能力接口地址**一律从信息文档的 `endpoints` 里读**，客户端**不许自己拼路径** |
| **推荐** | 信息接口在 `/chp/info`，其余在 `/chp/` 下（`info`/`jobs`/`job`/`progress`/`output`/`cancel`/`translate` 七个键，值为**根相对路径**） |
| **端口** | 不规定。今天挂在 ComfyUI 自己的端口（A1X 是 `8189`）上，那是 ComfyUI 的事，不是协议的事 |
| **绝对地址** | `endpoints` 的值以 `/` 开头 = 相对信息接口的**同源路径**；否则按**绝对 URL** 处理 —— 一个实现想把任务接口放到别的机器上，不必改协议 |

**客户端解析写死成一条**（不是猜）：把用户填的地址**原样**当信息接口请求；若它不是 CHP 文档、且地址里没有路径，**再试一次推荐的 `/chp/info`**；两次都不成 ⇒ 报「这个地址不是 CHP 服务」。这一条同时兼容用户存下来的三种写法：裸源、`…/chp`、`…/chp/info`。

> **现状核实**（2026-09-29）：`endpoints` 今天**已经在播报**，但**三个客户端一个都没读** —— hamdraw `providers.js:416`、chataxi `model-services.js:633`、PoseGi `providers.js:295` 全部硬编码 `/chp/info`，`api = base + "/chp"` 同理。
> 所以「把推荐升格成规则」= **客户端改读 `endpoints`**（P8 只做 hamdraw 与 chataxi），插件侧只多一条：路径写在一个模块常量里，不许散落各处。**PoseGi 另案**（它今天也硬编码 `/chp`，本轮不动它）。

### 1.7 部署调优参数：哪些必要

业主问「部署调优参数哪些是必要的」。按「不给就跑不起来」分档：

| 档 | 键 | 不给会怎样 |
|---|---|---|
| **必要** | `checkpoints.{fast,inpaint,upscale}`、`models.render.{unet,clip,vae}` | **必须能解析到一个真实存在的文件**，否则该类别报 `no_model`。`fast` 有推荐默认（`DreamShaper8_LCM.safetensors`），其余空手起家 |
| **推荐** | `password`（也可用环境变量 `HAMDRAW_PASSWORD`） | 留空 = **不校验**，接口对整个局域网敞开。功能上不必要，**默认推荐设** |
| **有可用默认，只在特殊机器上改** | `sampling.{category}.{sampler,scheduler,cfg}`、`families.qwen_image_21.{cache_device,cache_dtype,reference_edge}` | 用出厂值照跑；显存吃紧的机器才要动 `cache_dtype`（`int8`） |
| **只在需要时才配** | `translate.{enabled,url,model,timeout,memory_limit}` | 默认关闭；只有「中文提示词 + 有翻译后端」才要开 |

**判据一句话**：真正的「必要」只有**模型文件路径**（指向存在的文件），其余全部有可用默认。
**这四档全部是「运维在那台机器上改」，HTTP 上永远看不见** —— 它们**不进任何请求字段**；`chp_params` 里只装 §1.5 说的那类「调用方必须交上来的 CHP 层参数」（今天只有 `password`）。

### 1.8 请求体（`POST {endpoints.jobs}`）

| 字段 | 类别 | 说明 |
|---|---|---|
| `category` | 规则参数，必填 | `fast` / `inpaint` / `upscale` / `render`。**取代 v1 的 `capability` 与 `task`** |
| `resolution` | 规则参数，可省 | 字符串 `"768x1344"`，必须**逐项命中**该 `category` 的帧；省略取该类别第一档 |
| `prompt` | 规则参数 | 是否需要先译成英文由 `rules[].prompt.language` 决定 |
| `seed` | 规则参数 | **留顶层**（④）：少了它前端无法锁定重复生成。`0` = 每次不同 |
| `ref_strength` | 规则参数 | 0.05–0.95，越界**夹到边界**并在 `job` 回显 |
| `image_base64` / `mask_base64` | 规则参数 | 参考图 / 蒙版；`needs` 说哪个必填 |
| `ext_params` | 扩展通道 | 任意 JSON 对象，**原样携带、原样回显** |
| `chp_params` | 扩展通道 | 目前只有 `password` |

**其余顶层字段一律忽略 + 进 `job.ignored`**（⑤）。

### 1.9 协议正名（⑧⑬）

| | 现在 | 定稿 |
|---|---|---|
| 缩写 | CHP | **CHP**（不变） |
| 展开 | ComfyUI HamDraw Plugin CHP（把协议名当成插件名，双重错误） | **ComfyUI Haminn Protocol** |
| 实现的自称 | 「HamDraw 插件 CHP」 | **「CHP 插件」** |
| `PLUGIN_ID` | `hamdraw_chp` | **不动**（它是**实现**的名字，可能是多个实现之一；协议名才是 CHP） |

**关键结论**：`HamDraw → Haminn` 换掉的只是展开里的**一个词**，**缩写的三个字母没变** ⇒ 这次是**叙述层的正名，不是标识层的迁移**。`/chp`、`PLUGIN_ID` 都不用动。

**目录名 `custom_nodes/hamdraw_chp/` 改不改与协议正名无关**，两个选项都自洽，**推荐不改**：`hamdraw_chp` 是「HamDraw 出的那套 CHP 实现」的名字（HamDraw 是**现役**产品名，不是过时事实），而目录名同时是 ComfyUI 的加载单元 —— 改它要多做一次「先搬设置、再删旧目录」的部署动作（不改会双注册 `/chp` 路由，启动期报错），换来零收益。**要改的话，确切改动清单在 §4 P6，一句话就能切。**

**盘上数据的格式标识同样不动**：`HAMDRAW_*` 环境变量、`hamdraw_settings.json`、`hamdraw-comfy-settings/v1` 等 schema 字符串。理由不是「要兼容旧版本」，而是**改它们要给每台机器重新配置一遍**（A1X 上就是重填密码与三个模型路径），而 README 早就把这条判断写下了：**「它们是盘上数据的格式标识，不是产品名。」**

**UI 显示名要一起改**（⑬）：**本轮 hamdraw 与 chataxi**；PoseGi 那两条留到它自己那一轮（**但它们会在 P7 之后先坏**，见 §7）。

| 仓 | 位置 | 今天显示 |
|---|---|---|
| hamdraw | `app/services/providers.js:8` | `ComfyUI Hamdraw Plugin CHP（推荐）` |
| chataxi | 协议描述 + `app/data/i18n-en.js:1053` | 「hamdraw 的 ComfyUI 插件协议」 |
| PoseGi（**另案**） | `app/services/providers.js:33` | `ComfyUI Hamdraw Plugin CHP（推荐）` |
| PoseGi（**另案**） | `app/core/namespace.js:140` | 模型卡名 **`Qwen 图像 2.1`**，`task: "qwen"` ← **`qwen` 别名一删，这张卡就发不动了** |

---

## 2 这一轮一并删掉的东西（「不考虑兼容」的红利）

| 删除 | 出处 | 为什么可以删 |
|---|---|---|
| `size_domain` 播报、`fits()`、`sizes()`、`_aligned_down()`、`SIZE_STEP`、`budgets`、`aspects` | `capabilities.py` | `frames` 就是全部合法值，没有第二条路 |
| `values`（`size` + `steps` 两个枚举） | 同上 | 画幅进 `frames`；`steps` 进 `ext_params`（§1.5） |
| `defaults.size` | 同上 | 同「该类别第一档」，不许两个出处 |
| `grow_mask_by`（**整条**：`GROW_MASK_RANGE` / `INPUT_SCHEMAS` 的属性 / `_FIELD_HELP` 条目 / `clean_defaults` 会播报出去的 `defaults.grow_mask_by` / `create_job` 的夹边界 / 两个 family 的 `grow_mask_by=` 形参） | `capabilities.py` + `server.py` + `families/` | **一条完整的死参数**：播报、夹边界、传下来，然后**没有任何图节点读它**。外扩在客户端做（`canvas-io.js` 的 `MASK_GROW` 加粗笔迹），且必须由客户端做 —— 服务端膨胀会把前端羽化出的软边重新压平。原按 `chp-review.md` §1.5 列入 v2 规则参数，**2026-09-29 业主定：整条删除，v2 也不再收** |
| `aliases` 字段、`find()` 的别名分支、`names()` | `capabilities.py` | ⑥：不留别名，hamdraw 与 chataxi 同批改；**PoseGi 的 `qwen` 卡因此先坏**（§7） |
| `ALIAS_ROOTS`、`_root_of()`、`output_root` 参数 | `server.py` | ⑥：`/cvp` 别名取消，输出 URL 恒为 `/chp/…` |
| `task` 旧拼写、`unsupported_task` 错误码 | `server.py` + 规范 §6 | ⑥：三个 happ **今天就已经全在发 `capability`** |
| `unsupported_capability` → `unsupported_category` | 同上 | 字段改叫 `category` 了，错误码跟着走（**净删一个**：`unsupported_task` 没了） |
| `ignores` 字段与客户端的读取路径 | 能力表 + hamdraw / chataxi（PoseGi 另案） | ⑤⑪：与「哪些扩展参数生效」重复 |
| **文档级 `models.available`**（本机装了哪些模型文件） | `capabilities.py` 的 `document()` | **零消费者**：三个客户端都不读（核过 hamdraw/chataxi/PoseGi 的 `app/`；被读的只有**每个条目自己那条** `capabilities[].models`）。新的数组改叫 `abilities`，名字冲突也不存在了，**照删** |
| `capabilities` 顶层数组 | 同上 | 职责被 `rules` + `abilities` 分掉 |
| 客户端 `aspect()` | hamdraw | ⑩⑫：从一对数反推比例标签 —— 客户端**不算**，只显示 |
| 客户端 `pickSize()` 的打分挑选 | chataxi | 改成「取 `9:16` 那一档」，不再算距离 |
| 客户端 `chpDomain()` / `fitDomain()` | **PoseGi（另案，本轮不删）** | ⑩⑫：把边长收进「域」—— 同一个「域」的说法一并作废 |

**注意**：`/cvp` 从插件里删掉，但客户端里那个「地址尾部剥根」的正则（`/\/(?:chp|cvp|hamdraw)(?:\/|$)/i`）**保留原样** —— 它是客户端对**用户存过的旧地址**的容忍（用户卡片里可能存着 `…/cvp`），不是插件要背的兼容层。

---

## 3 阶段划分与验收判据

| 阶段 | 内容 | 验收判据（可执行） |
|---|---|---|
| P0 | 规范 v2 定稿 | `chp-spec.md`：`spec` 说 `chp/2`；**全文 `grep` 不到「域内」「任意比例」「菜单外」**；`rules` + `abilities` 两张表的骨架与 §1.1 一致；规则表两条含「按 `-2-` 切分」「规范序」；`frames` 一节（有序、默认 = 该类别第一档、成员校验、字符串分辨率、装配期两条断言、`9:16` 是标签）；`ext_params` / `chp_params` 两节含 §1.5 的载体表；`endpoints` 一节写明「规则 vs 推荐」；§4 字段表与 §6 错误表同步 |
| P1 | 插件：类别表与规则表分开 | `capabilities.RULES` 只有两条；类别条目**不含**手写 `signature`/`input`，只有 `rule`；发布文档里两个字段照样发且与规则一致 |
| P2 | 插件：`abilities` + `frames` 落地、算画幅的五件套删除 | `grep` 不到 `size_domain` / `fits` / `_aligned_down` / `budgets` / `aspects` / `values` / `models.available`；四个类别各有帧且 `resolution` 是字符串；`validate_values` 是成员检查；装配期两条断言在（§1.4 第 4 条） |
| P3 | 插件：两个通道 | 顶层 `steps` / `negative_prompt` / `capability` / 任意未声明字段 ⇒ 忽略 + 进 `job.ignored`；`ext_params` **原样**进 `job` 回显（含瞎编字段）；`chp_params.password` 能过鉴权，`chp_params` 里瞎编的键不报错也不影响鉴权 |
| P4 | 插件：改名、删别名、便宜项 | category 集合 `{fast,inpaint,upscale,render}`；`aliases`/`task`/`unsupported_task`/`unsupported_capability`/`/cvp` 全无；`job` 回显 `resolution`/`seed`/`ref_strength`；`/chp/info` 播报错误码集合 |
| P5 | 离线测试 + 变异 | §4 P5 的表全部覆盖，且**每条新断言都被至少一次变异点名抓住** |
| P6 | 协议正名 | §1.9 与 §4 P6 的清单逐行落地；三仓 + 插件 `grep` 后除历史记录外不再有旧展开 |
| P7 | A1X 部署与真机验收 | §4 P7 的七条断言 |
| P8 | **hamdraw + chataxi** 同步（PoseGi 另案） | §4 P8 每仓的改动清单；各自门禁全绿 |
| P9 | 设备热更新（两个 happ） | 两个 happ 读回 sha256 MATCH + 自检 0 红 + 各出一张图 |

---

## 4 阶段明细

### P0 规范 v2

`chp-spec.md` 整体改写（大版本），保留 §0 三条设计原则的骨架，并在第 3 条补一句**大版本升级怎么走**：客户端见到不认识的 `spec` 应当自报「插件版本比应用新」而不是继续猜。

必须落地的段落：§2 语法（换成 §1.3）、§3 类别表（四条 = `rules` 骨架；`category` 一节并进它）、**§4 两张 schema**（`txt-ref-2-img/v1` 与 `txt-msk-ref-2-img/v1`；**第二张由第一张 + 一个必填 `mask_base64` 生成**，不许复制粘贴，否则「写一次就能调所有」这个卖点会在拆分中丢掉）、§4 新增 `frames` / `ext_params` / `chp_params` / `endpoints` 四节、§4 字段表（删 `capability`/`task`/`size`/`steps`/`negative_prompt`/`ignores`，补 `category`/`resolution`/`ext_params`/`chp_params`，`seed` 标注「必要参数：少了它前端无法锁定重复生成」）、§6 错误表（删 `unsupported_task`；`unsupported_capability` → `unsupported_category`；`unsupported_steps` 注明「参考实现自己的键」）、§5 增一句「不做自带工作流」。

### P1 插件：把类别表与规则表分开

```python
# 规则表：模态按规范序写死，签名由它拼出来，类别表里不再有第二份副本。
RULES = {
    "txt-ref-2-img":     {"modalities": ("txt", "ref"),        "output": "img"},
    "txt-msk-ref-2-img": {"modalities": ("txt", "msk", "ref"), "output": "img"},
}
```

签名由模态规范序拼出（`"-".join((*modalities, "2", output))`），`input = f"{rule}/v1"`。
类别条目（原 `CAPABILITIES`）只写 `rule` 与它自己的 `needs` / `prompt` / `defaults` / `typical_seconds` / `roles` / `family`；**`signature` / `input` / `aliases` / `ignores` / `values` / `size` 六项从条目里删掉**。

### P2 插件：`abilities` + `frames` 落地

- 每个类别手写 `frames`（§1.4 那四张表就是初值），**顺序即规范**；
- `abilities` 条目从今天的 `roles` + `settings` 派生：`name` / `files` / `ready` / `missing` / `frames`；
- `validate_values()`：`resolution` 必须**逐项命中**该 `category` 的帧（成员检查），否则 `unsupported_size`；
- **装配期两条断言**（§1.4 第 4 条）：每个 `category` ≥1 档；`(category, resolution)` 唯一。断言失败 = 插件启动时就说清楚，不是等到某次请求才 400；
- **删**：`sizes()` / `fits()` / `_aligned_down()` / `SIZE_STEP` / `budgets` / `aspects` / `size_domain` / `values` / `models.available` / `defaults.size`；
- **`upscale` 只列 `1:1`**（上一轮那条待定**已结清**）：按「只允许枚举」的定稿，**放大一张竖幅从这一版起就不支持了**（旧代码那条宽容作废）。
  三个客户端发过来的都是 1:1，所以今天不损失任何东西；真要放大竖幅就往 `frames` 里加一档（例如 `9:16 ["576x1024","1152x2048"]`），**加一档就是全部工作量**。
- **要有一条「非枚举但旧域算得出来」的拒绝用例**：`768x768`、`896x1152` 这种旧 `fits()` 会放行的画幅，现在每个都必须 `400`。

### P3 插件：两个通道

`create_job` 的处理顺序：

1. 顶层只认：`category` / `resolution` / `prompt` / `seed` / `ref_strength` / `image_base64` / `mask_base64` + 两个通道；
2. `capability` 与 `task` **不再认**（⑥），照「未声明字段」处理 ⇒ 忽略 + 进 `ignored` —— 客户端漏改时回执当场点名，而不是「任务能跑但参数没生效」；
3. **其余顶层字段一律忽略**，名字进 `job.ignored`；
4. `ext_params` **不筛不校验**，原样存进 `job` 并回显；参考实现只读自己认识的那两个键；
5. `chp_params` 只读 `password`（用于鉴权），其余键忽略；`password` 不在 body 时退回 `Authorization` 头（§1.5 载体表）；
6. 生效值回填进 `job`（`category` / `resolution` / `seed` / `ref_strength` / 生效的 `ext_params`）。

`families.build()` 新增一条 `ext=` 入口，与既有 `options=`（部署项，§1.7）**分开**。
`checkpoint.py` / `qwen_image.py`：`steps` 从必填位参变成**带默认值的扩展参数**（默认取实现自己那份）。

### P4 改名、删别名、便宜项

| 位置 | 改法 |
|---|---|
| `CAPABILITIES` 键与 `id` | `quick` → `fast` |
| 文档骨架 | `capabilities` 数组 → `rules`（四条）+ `abilities`（两条）；请求字段 `capability` → `category` |
| `settings.DEFAULTS["checkpoints"]` | 键 `quick` → `fast`（**一处改，`RENAMED` 机制随之删掉**，⑥不再需要读老文件） |
| `settings.checkpoint()` 的兜底 | `get("quick")` → `get("fast")` |
| `nodes.py` 的 `quick_checkpoint` widget | 改名 `fast_checkpoint`（`INPUT_TYPES` 的默认值取自设置文件，**不会丢用户配置**） |
| `nodes.py` 的 `REFERENCE_DEFAULT` | 读 `fast` 那条 `rules` 的 `defaults.ref_strength` |
| `server.py` | 删 `ALIAS_ROOTS` / `_root_of()` / `task` / `unsupported_task`；`_size_of()` 改吃 `"WxH"` 字符串；`_describe()` 补 `resolution`/`seed`/`ref_strength`；`/chp/info` 补 `errors: sorted(ERROR_STATUS)`；内部函数 `_models_of` / `_models_of_id` 跟着改叫 `_abilities_of` / `_abilities_of_id`（**只此一处改名，`adapters` 之类的再造词不做**） |

### P5 离线测试与变异

| 断言 | 变异（必须报红） |
|---|---|
| `RULES` 恰好两条、语法可解析、规范序 | 去掉 `-2-` 切分 / 加一条 `txt-2-img` / 把 `msk` 写到 `txt` 前面 |
| 类别条目**不含**手写 `signature`，发布值由 `rule` 算出 | 给某类别塞一份手写 `signature` 覆盖 |
| `abilities`/`frames` 与 §1.4 表逐项相同、`resolution` 是字符串 | 把某类别的帧顺序换掉 / 把 `"512x512"` 改回 `[512,512]` |
| 装配期两条断言：每类别 ≥1 档、`(category, resolution)` 唯一 | 删掉某类别的全部帧 / 造一对重复 |
| 成员校验：帧外的合法数字必须被拒 | 把成员检查放宽成「能解析成 WxH 即可」 |
| 顶层 `steps` / `negative_prompt` / `capability` 被忽略且进 `ignored` | 把闸门改成「照收不误」 |
| `ext_params` 原样回显（含瞎编字段） | 让 `ext` 参数被丢掉 |
| `ext_params` 未知键、`chp_params` 未知键 ⇒ **不报错** | 改成报 400 |
| `chp_params.password` 能过鉴权 | 只读头部、不读字段 |
| `spec == "chp/2"`；插件版本 == `version.__version__` | 钉死一个字面量版本（**反面教材，不许再犯**） |
| 没有 `aliases` / `ignores` / `task` / `/cvp` / `values` / `size_domain` / `models.available` | 任一复活 |
| `endpoints` 七个键齐、值全是根相对路径 | 少一个键 / 改成绝对 URL 而实现并不支持 |

变异脚本照既有 `tests/.mutate_*.py` 的手法：**以「点名那条断言出现在输出里」为通过条件**，不以退出码为准。

### P6 协议正名

| 位置 | 现在 | 改成 |
|---|---|---|
| `plans/chp-spec.md` 标题/首段 | `# CHP 规范 v1` | `# ComfyUI Haminn Protocol（CHP）v2` |
| `capabilities.PLUGIN_LABEL` | `ComfyUI HamDraw 插件 CHP` | `CHP 插件（ComfyUI Haminn Protocol）` |
| `comfyui-plugin/README.md` 标题 | `# CHP — ComfyUI HamDraw Plugin CHP` | `# CHP 插件 — ComfyUI Haminn Protocol` |
| `hamdraw_chp/__init__.py` docstring | `ComfyUI HamDraw Plugin CHP.` | `The CHP plugin — the reference implementation of ComfyUI Haminn Protocol (CHP).` |
| hamdraw `providers.js:8` 协议卡名 | `ComfyUI Hamdraw Plugin CHP（推荐）` | `CHP 插件（ComfyUI Haminn Protocol，推荐）` |
| hamdraw `README.md` / `guid.md` / `CONTRIBUTING.md` | 「HamDraw 插件 CHP」 | 「CHP 插件（ComfyUI Haminn Protocol）」 |
| **chataxi** 协议描述 + `i18n-en.js:1053` | 「hamdraw 的 ComfyUI 插件协议」 | 「CHP 插件（ComfyUI Haminn Protocol）」 |
| **PoseGi** `providers.js:33` | `ComfyUI Hamdraw Plugin CHP（推荐）` | **另案**（本轮不改） |
| **PoseGi** `namespace.js:140` 模型卡名 | `Qwen 图像 2.1`（`task: "qwen"`） | **另案**：显示名与 `task: "render"` 一起改（`qwen` 别名没了） |
| 打包产物 | `release/hamdraw-comfyui-plugin-v<v>.zip` | `release/chp-plugin-v<v>.zip` |
| 网站下载位 | `public/downloads/hamdraw/hamdraw-comfyui-plugin-v2.3.0.zip` | 新包放 `public/downloads/chp/chp-plugin-v3.0.0.zip` |

**要连目录名一起改的话，外加**：目录 `hamdraw_chp/` → `chp/`、`PLUGIN_ID = "chp"`、`tools/package-plugin.py` 的 `ENTRIES`/`VERSION_FILE`、`tools/embed-plugin.py` 的 `VERSION_FILE`、`tests/*` 的 import、A1X 上的「先搬 `hamdraw_settings.json`、再删旧目录」。

- **历史发布产物文件名与旧下载链接一个都不动**（`release/vibedraw-*`、`hamdraw-comfyui-plugin-v2.3.0.zip`、网站 `downloads/vibedraw/*` 留在原地）—— 旧名字是**过时事实，不是别名**，改它等于让已发出的下载链接 404。
- 包名与内嵌副本（`app/assets/comfyui-plugin.js`）**只在正式发布时更新**，平时改插件源码不碰。

### P7 A1X 部署与真机验收

按技能 `a1x-comfy-device` 的闭环，**逐文件传，不重传整目录**（宿主先 `.bak-20260929/` 备份）：

1. 传改动文件 → 清 `__pycache__` → `systemctl --user restart minimax-h3-comfy` → 两侧 `sha256sum` 逐一对照；
2. `curl --noproxy '*' http://192.168.124.31:8189/chp/info`：`spec == "chp/2"`、`plugin.version == "3.0.0"`、
   `rules[].category` 集合 `{fast,inpaint,upscale,render}`、**`capabilities`/`aliases`/`size_domain`/`ignores`/`values`/`models.available` 一个都不在**、
   `abilities` 两条且每条的 `frames[].resolution` 都是字符串、**每个 category 至少一帧**、`endpoints` 七个键、`input_schemas` **恰好两份**；
3. **一单证明两个通道**：`fast` + `resolution: "512x512"` + `ext_params: {step: 4, 我自己编的: 1}` + 顶层同时塞 `steps: 8`、`capability: "quick"` 与一个瞎编字段 →
   出图，`job.ignored` 里**同时出现** `steps` / `capability` / 那个瞎编字段，`job` 里能看到**原样带回**的 `ext_params`；
4. **一单证明密码进字段**：`chp_params: {password: <真密码>}`、**不带 `Authorization` 头** → 出图；`password` 写错 → `401`；
5. `inpaint` 一单：规则字段 + 蒙版 + `resolution: "512x512"` → 出图；
6. `resolution` 用帧外的数字（如把 `"1024x1024"` 发给 `fast`）→ `400 unsupported_size`（证明成员校验真的收紧）；
7. `/cvp/info` → **404**（证明别名真的删了，不是「没生效」）。

### P8 两个 happ 同步（hamdraw 首要，chataxi 次之）

| 仓 | 改动 | 判据 |
|---|---|---|
| **hamdraw** | ①协议卡文案 + 自己的 UI 名（⑬）；②`CHP_CAPABILITY` 的 `quick` → `fast`；③`chpSizes()`/`chpCapability()`/`chpIgnores()`/`aspect()`/`publishedCanvases()`/`lockedCanvasError()` 全改：画幅改读**该类别里 `ratio === "1:1"` 的第一帧**（不再搜方形、不再算标签）；④`chpGenerate` 的 body：`capability`→`category`、`size: [w,h]`→`resolution: "WxH"`、`steps`/`negative_prompt` 搬进 `ext_params`、密码进 `chp_params`（GET 仍走头）；⑤`validate()` 里那条 256–2048 的复刻删掉；⑥`test()` 返回的字段跟着改（`sizes`→帧表、客户端那个 `models` 键改从 `abilities[].files` 取）；⑦`settings.js:213` 的模型文件名显示改读 `files`；⑧地址解析改读 `endpoints` | `providers.test.mjs` 新增「`frames` 顺序变了，锁定的画幅跟着变」的行为断言；变异（改回搜方形）必须报红 |
| **chataxi** | ①协议描述 + i18n 文案（⑬）；②`discoverImage()`：`document.capabilities` → `rules` + `abilities`（卡片名用**自己的**目录名，不再读文档 `label`）；③`pickSize()` 的打分整套删掉，改成**直接取 `render` 里 `ratio === "9:16"` 的第一档**（9:16 这个产品选择不变）；④`draw.js` 的 body：`capability`→`category`、`resolution`、`steps`/`negative_prompt` 进 `ext_params`、`ignores` 读取路径删掉；⑤`draw.js:24-25` 与 `catalog.js:374` 两处讲 `size_domain` / `values.size` 的注释改写；⑥地址解析改读 `endpoints` | 现有 size 断言改成「取的就是 9:16 那一档」；`model-single-editor` 的能力分组文案跟着改 |

**这一轮两个仓都要动**（⑥的必然结果），但每一处都是删代码或换一个取值来源，没有新逻辑。
**hamdraw 先做**：它的三个 slot 正好是 `fast` / `inpaint` / `upscale` 的活样本，卡片、画幅、两个通道一站验完；
**第四类 `render` 由 chataxi 那一站验** —— 这就是它排第二的原因（它只用 `render`）。
**读 `endpoints` 是两个仓的共同新增项**（§1.6 的现状核实：今天一个都没读）。

**PoseGi 另案**（业主：稍后单独改，现在不用管它）。它下一轮要做的事**在这里留档**，本轮不排期：
删 `chpDomain()` / `fitDomain()`；画幅滑杆换成只列 `ratio === "1:1"` 的帧选择（`settings.js:153-164` 那段上下界逻辑整段删除）；
`chpEntry()` / `chpEntryModel()` 改从 `rules` / `abilities[].files` 读；`chpRefBase()` 改读 `rules[].defaults.ref_strength`；
`chpTasks` 的 `qwen` 卡改 `task: "render"`；`body` 的字段名与两个通道跟着改；`translate.js:149` 改读 `endpoints.translate`；
§1.9 那两处 UI 显示名。判据仍是 `chp-jobs.test.mjs` §6 与 `providers.test.mjs`。

### P9 设备热更新

hamdraw 与 chataxi 各自：`sync-dir` → 读回改动文件 sha256 → 自检 0 红 → 真机各出一张图
（hamdraw 快速生图 + 一次局部重绘；chataxi `render` 9:16）。**只测自己改的那一点。**

---

## 5 版本号

| 物 | 现在 | 改成 | 理由 |
|---|---|---|---|
| `spec` | `chp/1` | **`chp/2`** | 契约意义变了，必须让客户端能看出「这台服务器说的是另一版」 |
| 插件 | `2.4.5` | **`3.0.0`** | 跟 `spec` 大版本走；插件版本是用户唯一看得见的号 |
| hamdraw | `0.5.42` / code `118` | 升第三段（四处同步照旧） | 改了 `providers.js` 等源码 |
| chataxi | 当前值 | 同上（本轮只做到「跟上协议」，体验改进另案） | 只在真的改了源码的那个仓升 |
| PoseGi | 不动 | **不动** | 本轮不改它 |

四处同步只针对**改动的那个仓**。

> **关于「升 chp/2 是不是要大重构」**：`spec` 只是文档里一个字符串，含义是「这版契约不承诺与上一版兼容」，**代码量不会因为写 `chp/2` 而变大**。真正的重构来自你定的三件事，而因为⑥「不考虑兼容」＋⑪「没有官方字段」，这一轮**净删**：算画幅的五件套、`values`、别名机制、`/cvp`、`task`、`ignores`、`capabilities` 数组、`models.available`、客户端的两处 `fitDomain` 与 `aspect()`、chataxi 的打分挑选。

---

## 6 明确不做

- 不做家族注册机制、不做 OpenAPI 生成、不做 MCP 门面、不做多目标语言、不做账号配额（照旧）。
- **不做「用户自带工作流」入口**（⑦）。
- **不留别名、不写兼容层、不认 `task` 旧拼写、不挂 `/cvp` 别名**（⑥）。
- **不改**目录名 / `PLUGIN_ID` / `HAMDRAW_*` / `hamdraw_settings.json` / 盘上 schema 字符串（§1.9），除非业主明确要那套「目录名一起改」的清单。
- **不新增第三条规则**（②：目前只有两条）。
- **不给 `ext_params` / `chp_params` 里的未知键任何错误码**（⑪）：忽略 + 回显，不是错误。
- **不规定端口，也不规定信息接口的路径**（⑩）：只要求「公开可达」与「地址从文档里读」。
- **不约定支持哪些比例与分辨率**（⑫）：只要求「每类别至少一档」。
- **不做「域内自由画幅」**：`frames` 就是全部，**只允许枚举里的比例与分辨率**；「域内」「任意比例」「菜单外」这些说法**不许再出现**（业主定稿）。
- **本轮不改 PoseGi**（业主：稍后单独改）。它从 P7 之后到它那一轮之前是坏的，见 §7。

---

## 7 风险与回滚

| 风险 | 处置 |
|---|---|
| `frames` 成员校验收紧，某个 happ 原来靠「域内自算」发出的画幅被拒 | hamdraw 与 chataxi 与 P7 同批改，不留窗口；P7 第 6 条专门验这条拒绝是否如期 |
| 密码载体从「一律走头」改成「有 body 走字段」，GET 那半边漏考虑 | §1.5 的载体表把 GET 与无 body 的 POST 明确留在头上；P7 第 4 条验字段这条路真的通 |
| 客户端漏改 `capability` → `category` | 插件**不认旧拼写**，会进 `job.ignored` 并被回执点名（P3 第 2 条），不是静默失效 |
| 文档骨架大改，某个 happ 读到空数组却不报错 | hamdraw 与 chataxi 各有「没有 render 类别就报『请升级插件』」的既有分支，P8 保留并加一档断言 |
| **PoseGi 在 P7 之后、到它自己那一轮之前是坏的**（它读 `capabilities` / `size_domain` / `values`，chp/2 里全没有） | **已知并接受**（业主：稍后单独改）。表现是**那张卡的出图报错**（读到空能力表 ⇒ 报错，**不是静默画错**）。要缩短窗口就把 P7 的插件部署压到 PoseGi 也改完再做；回滚 = `.bak-20260929/` 拷回 + 重启容器 |
| 两个仓同批改，任一仓漏改 | 每仓各自门禁 + P9 真机各出一张图；P8 表里每行都有判据 |
| 插件回滚 | 宿主 `.bak-20260929/` 拷回 + 重启容器 |
| happ 回滚 | 热更新前的版本仍在设备上，直接回推 |
| 包名改了但下载页没改 | 包名与正式发布绑在一起（P6 末条），当场比对 release / 网站 / `embed-plugin` 三处 |

---

## 8 落地顺序

`P0 → P1 → P2 → P3 → P4 →（每步之后跑一次离线测试）→ P5 → P6 → P7（A1X 真机）→ P8（hamdraw → chataxi）→ P9（推设备）`
（**PoseGi 不在这一串里**，它另起一轮；它要做的事留档在 §4 P8。）

P0–P6 全部本机可离线自检；**P6 通过之后才第一次碰设备**，避免在设备上反复试错。
正式发布（GitHub release + 网站安装包 + 下载位与文档）是 P9 之后的**独立动作**，本计划不含。

**没有待定项**：`upscale` 只列 `1:1`（§4 P2 已结清），其余按定稿执行。

---

## 9 落地记录（2026-09-29 起，边做边记）

**已完成**：P0（`chp-spec.md` 整体改写为 v2，全文 grep 不到「域内」「任意比例」「菜单外」）、
P1（`RULES` 两条 + 签名由模态拼出）、P2（`FRAMES` 手写表 + `validate_resolution` 成员检查 + 装配期两条断言，
算画幅的五件套全删）、P3（`ext_params` / `chp_params` 两条通道 + `families.build(ext=…)`）、
P4（`quick`→`fast`、别名/`task`/`/cvp`/`ALIAS_ROOTS`/`_root_of` 全删）、
P5 的一部分（两份离线测试整体重写；`test_spec.py` 现在把提交路径真的跑起来，断言读的是**入队的那张图**，
所以「开关读了又丢掉」这类只有行为断言看得见）。插件版本 `2.4.5` → **`3.0.0`**；README 整体重写。

**与本文不同的四处处置**（连同理由记在这里，不是悄悄改）：

1. **§4 P4 说 `_models_of` / `_models_of_id` 改名成 `_abilities_of` / `_abilities_of_id`，落地时只留了一个
   `_abilities_of(category)`。** 那两个函数本来就是**同一个判断的两份拷贝**（`_resolve_models` 在提交前判、
   `_abilities_of` 在文档里判），而且文档里那句「与提交前的判断一致」是**靠人维持**的。合并之后两者**不可能**
   不一致 —— 这正是 discovery 文档存在的意义。同理删掉 `_size_of()`：解析 `"WxH"` 交给
   `capabilities.resolution_size()`，与帧表同处一个模块，比留在 HTTP 层更近。
2. **`validate_step` 收紧：小数步数现在被拒。** 旧写法 `int(step)` 会把 `20.5` 静默取整成 `20` —— 客户端以为
   自己发的值生效了，与这一轮在删的「静默失效」是同一类问题。
3. **`check_frames` 收紧：数的是分辨率不是帧条目。** 原来只判「这个 category 有帧条目」，于是
   `{"ratio": "1:1", "resolution": []}` 这种「有帧但一档都没有」的表能溜过去，客户端照样无从下手。
   （这条是新写的断言**当场抓出来的**，不是事后想到的。）
4. **打包产物改名与网站下载位推迟到正式发布**，不由本轮做。`tools/embed-plugin.py` 要从
   `release/…zip` 里读字节生成 `app/assets/comfyui-plugin.js`，而 `tools/verify.mjs:203` 正钉着包名 ——
   现在改名要么先打一个发布包（业主明确禁止在正式发布之外打包），要么把那条门禁放宽（不许为了变绿放宽断言）。
   所以 §4 P6 的最后两行（`release/chp-plugin-v<v>.zip` 与 `public/downloads/chp/…`）连同
   `app/assets/comfyui-plugin.js` 一起，**归入正式发布那一次动作**。正文里 §1.9 的叙述层正名（规范标题、
   `PLUGIN_LABEL`、插件 README 标题、`__init__` docstring、三仓 UI 显示名）本轮全部做完。

**P0–P6 离线收口**：`node tools/verify.mjs --source-only` → `ok (25 runtime files)` 且各子测试全绿；
`python3 tests/test_spec.py` → `ok（4 条规则，2 条能力，15 帧，2 份输入 schema，1 条翻译记忆，插件 hamdraw_chp 3.0.0，
根 /chp，契约 chp/2）`；`python3 tests/.mutate_spec.py` → `21 处变异，全部按名字抓住`。
（`tools/package.py --check` 报「缺 `release/hamdraw-v0.5.43.zip`」是**预期**的 —— 本轮不打发布包。）

### P7（A1X `192.168.124.31:8189` 真机）

部署：`hamdraw_chp` → `hamdraw_chp.bak-20260929`（带「已存在就不覆盖」守卫），传 **10 个模块**，第 11 个
`families/graph.py` **两边 sha256 本来就相同**（同源旁证），清 `__pycache__`、`systemctl --user restart
minimax-h3-comfy`，落定后 **11 个哈希与本地全等**，两个数据文件未动。

文档 7 项全绿（`/tmp/chp_p7_check.py`，读的是**服务端发出来的那份**）：`spec == chp/2`、插件 `3.0.0`、
顶层键 ⊇ 规范八个、多出来的只有 `errors`、4 条规则每条 `signature == rule` 且 `input == rule + "/v1"`、
2 条能力、**15 条帧条目 / 16 个分辨率档位**（`fast` 3、`inpaint` 3、`upscale` 1 条带 2 档、`render` 8）、
7 个端点全是 `/` 相对、2 份 schema、`errors` 里有 `unsupported_category` 而没有
`unsupported_task` / `unsupported_capability`、v1 词汇（`size_domain` / `aliases` / `ignores` / `values` /
`capabilities` / `models` / `available`）**全文档路径级扫一遍都不在**。

作业级 7 项全绿（`/tmp/a1x_p7_jobs.sh`，在**机器上**跑，密码只从 `hamdraw_settings.json` 进内存）：

| 验的东西 | 实测 |
|---|---|
| `fast` 端到端出图 | `completed`，PNG **106,696 B** |
| 旧拼写被点名 | `job.ignored == ['capability','steps','瞎编字段']` |
| `ext_params` 原样携带 + 回显 | 发 `{step:4, 我自己编的:1}`，读回一字不差 |
| 画幅是成员检查 | `1024x1024` / `768x768` / `512x513` 各 `400 unsupported_size` |
| `inpaint` 带蒙版 | `completed` |
| 密码两条载体 | 有 body 走 `chp_params.password`（**不带** Authorization 头）成功；没凭据 / 错字段 / 错头各 `401` |
| 旧根真的没了 | `/cvp/info`、`/hamdraw/v1/info` 各 `404` |

**两个坑，都写进了命名的辅助函数**（`job_of()` / `poll()`）：① **每条响应都把记录包在 `{"job": …}` 里**
—— submit / status / cancel 三处一样，不拆包时 `payload["state"]` 恒为 `None`，看着像「作业永远不完成」；
② **GET 带不了 `chp_params`**，必须走 `Authorization: Bearer`（§1.5 的载体表就是这么定的），不带就永远 `401`。
**还抓到一次假绿**：第一版因为没拆包，第 3、5 条**被静默跳过**却仍然打印 `ok` —— 现在「回执里没有带 id 的作业」
记的是**失败**，且额外断言 `outputs` 非空，完成判定不可能再被跳过。

### P9（热更新到手机 `192.168.124.35:8766`）

| | hamdraw | chataxi |
|---|---|---|
| 开发树 | `prepared: true`，`0.5.43 / code 119`；复跑一次**幂等**（同 revision 同 `updatedAt`，没有重发） | `prepared: True`，`0.7.47 / code 126`，revision 10 |
| 读回 | 改动的 8 个文件逐字节相同 | 同上 |
| 全树比对 | **28 文件全等** | **74 文件全等** |
| 设备自检 | **173 项，0 红** | 该 happ 没有设备自检（它的自检是本机 `tools/verify.mjs`） |
| 真机出图 | `fast` **180,654 B**、`inpaint` **243,358 B**，0 错误 | `render` 9:16，PNG **1,589,721 B**，图片本体 **768×1344** |
| 服务端旁证 | 日志 `Prompt executed in 0.79 / 0.64 seconds` | 日志 `Prompt executed in 31.43 seconds` |

chataxi 那 23 条断言里值得单说的三条：`pickSize` 取到的是**帧表里标着 9:16 的那一档**（`768x1344`，
不是按比例算出来的）；请求地址**全部读自文档 `endpoints`**（7 个键，全 `/` 相对）；连 `needs` / 角色挂载点
（unet / clip / vae 三个全 `ready`）都是文档说什么就是什么。

> **一处要如实标明**：这台手机上 chataxi **从来没配过绘图卡片**（`image-profiles` 为空），而
> `discoverImage` 对 `auth.required && authorized === false` 是**拒收**的。所以这一轮用的是**只存在于内存的探针卡片**
> （`discover(..., {persist:false})`），插件密码从 A1X 的 `hamdraw_settings.json` 读进内存、不打印、不落盘、不进 URL，
> **chataxi 的数据区一个字节都没写** —— 它自己的规矩是「API Key 只在用户明确保存后写入」（`AGENTS.md:24` / `guid.md:44`）。
> 也就是说：**协议链路已验完，手机上要出图仍需业主在模型页配一张卡并保存密码**（那是他的数据，不由代填）。

