# guid.md — HamDraw（写给插件的短说明）

开发这个 happ 之前读一遍就够了。这里只讲这个项目本身：技术思路、目录、注意事项、怎么自检。

## 技术思路

- 定位：HaminnApp 里的实时 AI 绘图 happ。用户随手涂鸦，AI 在一秒左右成图；不是"提示词出图"工具。
- 形态：纯原生 HTML / CSS / JavaScript，**没有构建步骤**，源文件直接运行。无框架、无包管理器、无 CDN、无远程字体。
- 本地优先：作品、配置、图片引用全在本机 happ 隔离数据区，不内置任何平台 API Key。模型由用户自己配置。
- 三个任务槽位互相独立：快速生图 / 局部重绘 / 高清渲染。画幅、步数、参考强度由所选接口的内置规格决定，不由用户填。
- 绘图内核：原生 Canvas 矢量笔触（铅笔 / 涂色 / 擦除 / 框选 / 成组 / 移动 / 复制 / 图层 / 局部蒙版 / 撤销重做），历史快照保存提示词与画面参数。
- 接口模式：CHP 插件（ComfyUI Haminn Protocol，推荐）/ OpenAI Images 兼容 / Stable Diffusion WebUI · Forge / Stability AI v2beta。CHP 走 A1X 掌机的 ComfyUI，插件源码在本仓 `comfyui-plugin/`（**CHP 是协议，它是参考实现**）。

## 目录结构

```
index.html            入口；只放骨架与样式引用
haminn.json           包清单（schema 2，happId life.airen.hamdraw）
guid.md               本文件
app/app.js            启动与装配
app/core/             纯逻辑，不碰 DOM 与宿主：namespace / runtime / i18n / utils / drawing
app/platform/         haminn.js —— Bridge 与网络的唯一出口
app/services/         image-engine 生图编排 / providers 供应商适配 / assets 图片编解码
                      store 持久化
app/components/       canvas / settings / gallery / render-preview / ui：DOM 与语义事件
app/features/         editor 交互编排 / self-test 自检
styles/               tokens / base / components / editor
```

不进运行包（请勿加入打包清单）：`tools/`、`tests/`、`docs/`、`release/`、`comfyui-plugin/`。
运行包只有 `index.html`、`haminn.json`、`guid.md`、`app/`、`styles/` —— 清单在 `tools/package.py` 的 `RUNTIME_ROOTS`。

## 开发注意

- 依赖方向固定 `core → platform → services → components → features`，组件注册到 `window.hamdraw`；不要反向依赖。
- 兼容 Android 10 与旧厂商 WebView。**本机实测 flex 的 `gap` 不生效**，间距用相邻兄弟 `margin` 或 grid；设备 CSS 视口只有 510px 宽，紧凑分支写在 `@media(max-width:520px)`。
- 所有模型请求必须经过 `app/platform/haminn.js`。公网服务用 HTTPS，HTTP 只允许可信局域网地址。
- 图片字节、Base64、data URL **禁止写入 `haminn.data`**，只存文件引用；release 目录不存用户资产。
- API Key 只在用户明确保存后写入本 happ 隔离数据，界面始终默认遮罩，不写入源码、日志、文档或测试。
- **提示词原样提交，客户端不做任何翻译**（`services/` 下没有、也不再有 translate 模块）。要不要英文由服务端的规则决定：
  CHP 插件的 `rules[].prompt.language` 为 `"en"` 的类别（SD1.5 + CLIP-L 那几套 fast / inpaint / upscale）
  由**插件在提交那一刻**自动把中文译成英文并缓存；为 `"any"` 的类别（Qwen3-VL 的 render）中文原样喂进编码器；
  OpenAI / Stability 那侧本来就吃英文。**所以界面建议写英文**：不过翻译这一道，就没有译错的余地；
  写中文也不会被拒，插件负责译。生图路径全程只读、绝不触发网络。
- 局部蒙版笔迹留在 `state.objects` 里，退出局部只是隐藏而不是清除；只有扫把按钮清空。
- 别把 happ 业务逻辑塞进宿主或 HaminnUI；宿主能力不足时先改合同方 `haminnapp`，再回来消费。

## 自检

- 改完先跑 `node tools/verify.mjs --source-only`：它含跨模块导出检查（"调用了但没导出"这类只在运行时炸的错）与静态断言（含 flex gap 回归）。
- 需要真机时走智能体开发模式同步，用页面状态确认改动生效；本仓 `AGENTS.md` 有完整验收口径。
- 出正式包：`python3 tools/package.py` → 更新 `haminn-install.json` 的 zip 路径与 sha256 → 版本号同步 `haminn.json`、`app/core/namespace.js` 与 `README.md`。
