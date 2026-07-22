<p align="center">
  <img src="assets/app-icon.png" width="96" alt="CoScribe icon" />
</p>

# CoScribe

<p align="center">
  本地优先的 AI 学习与内容工作台<br />
  A local-first AI workspace for learning, research, and durable notes
</p>

<p align="center">
  <a href="#中文">中文</a> · <a href="#english">English</a> ·
  <a href="https://github.com/UESTC-ly/CoScribe/releases/latest">Download</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

![CoScribe workspace overview](docs/images/workspace-overview.png)

<a id="中文"></a>

## 中文

CoScribe 直接把普通文件夹当作项目。你可以在同一个桌面应用中阅读 PDF、DOCX、PPTX、图片、文本与 Markdown，使用本地 OCR 或已配置的 AI 处理内容，再把结果保存回标准 Markdown 文件。项目不是私有数据库，离开 CoScribe 后仍可由 Obsidian、Typora、VS Code 或文件管理器继续使用。

### 下载与安装

从 [GitHub Releases](https://github.com/UESTC-ly/CoScribe/releases/latest) 下载最新版本：

| 系统 | 安装包 | 适用范围 |
| --- | --- | --- |
| macOS | `CoScribe-2.0.0-arm64.dmg` | Apple Silicon，macOS 13+ |
| macOS | `CoScribe-2.0.0-arm64-mac.zip` | Apple Silicon 免安装压缩包 |

v2.0.0 先集中做好 Apple Silicon macOS。本项目目前没有 Apple Developer ID 签名，安装包可正常使用，但首次启动需要手动确认来源。

macOS：

1. 打开 DMG，把 CoScribe 拖入“应用程序”。
2. 首次启动时，在 Finder 中右键 CoScribe，选择“打开”。
3. 如果仍被阻止，进入“系统设置 → 隐私与安全性”，点击“仍要打开”。
4. 截图功能首次使用时，按系统提示授予“屏幕录制”权限。
5. 语音输入首次使用时，按系统提示授予“麦克风”权限。

发布页同时提供 `SHA256SUMS.txt`。下载后可核对文件摘要，确认安装包完整。

### 三步开始使用

1. 在首页选择“打开文件夹”，直接打开已有资料目录，或创建新项目。
2. 从文件树打开资料；选中内容后提问，也可以显式切换到当前文档或整个项目。
3. 普通 AI 文件修改先检查预览再接受；明确点击“整理笔记”时，整理结果会直接保存到本地。

CoScribe 会识别已有子文件夹和文件。项目中的 `.git`、`.venv`、`node_modules` 等开发目录默认不进入资料树。

### 主要能力

- Markdown 默认以预览打开，支持编辑/预览/双栏、可折叠且可拖拽调宽的大纲、GFM、数学公式、Mermaid、语言识别和代码高亮。
- PDF 支持连续阅读、目录、缩略图、搜索、选区、高亮、批注、书签和 OCR。
- DOCX 在本地解析和净化后显示；PPTX 在应用内只读渲染，并提取逐页文字供搜索与 AI 使用。
- 图片可查看、缩放、本地 OCR 或 AI 增强识别；普通文本可直接阅读和搜索。
- 多标签、左右分屏、阅读位置恢复、项目搜索和可调整宽度的 AI 面板。
- AI 回答支持 Markdown、数学公式、Mermaid 和代码语法高亮。
- 项目根目录的 `COSCRIBE.md` 是透明、可迁移的长期记忆；每个项目相互隔离，可在左侧“记忆”中直接审阅和编辑。
- AI 侧栏支持完全本地的中英双语实时语音转文字；识别结果边说边进入输入框，停止后由你决定是否发送。
- 设置中可以编辑自定义系统提示词；它能调整回答风格，但不会覆盖应用的文件安全和密钥边界。
- 内置可信插件中心与“计划与日程”插件；任务保存在普通 `计划/项目计划.md` 中，也可让 AI 按目标生成完整计划。
- AI 可以创建 1–50 个 Markdown 文件、缺失的子文件夹和完整笔记项目，不要求先手工建空文件。
- 生成图片保存到项目 `assets/ai-images/`；后续对话会收到经过校验的相对路径、Markdown 路径和本机绝对路径。
- 内置单标签资料浏览器显示原始网页，并把选区、正文或来源交给 AI；网页可保存为完整 MHTML 归档、语义化 Markdown 或保持打印排版的 PDF。

<table>
  <tr>
    <td width="50%"><img src="docs/images/markdown-mermaid-code.png" alt="Markdown Mermaid and code highlighting" /></td>
    <td width="50%"><img src="docs/images/pptx-reader.png" alt="PPTX reader" /></td>
  </tr>
  <tr>
    <td align="center">Markdown、Mermaid、代码高亮</td>
    <td align="center">PPTX 本地只读渲染</td>
  </tr>
</table>

### 支持格式

| 格式 | 显示 | 搜索/AI | 编辑 |
| --- | --- | --- | --- |
| Markdown (`.md`, `.markdown`) | 完整预览 | 是 | 是 |
| PDF | 连续页面 | 文本层或 OCR | 批注，不修改原 PDF |
| DOCX | 本地语义预览 | 是 | 否 |
| PPTX | 本地只读幻灯片 | 逐页提取文字 | 否 |
| PPT | 可识别 | 需本机 LibreOffice 转 PDF | 否 |
| MHTML/MHT 网页归档 | 交给系统浏览器打开原网页归档 | 否 | 否 |
| PNG/JPEG/WebP/GIF/SVG 等 | 图片查看器 | OCR 后可用 | 否 |
| TXT/JSON/YAML/代码等文本 | 文本查看器 | 是 | 否 |

旧版二进制 `.ppt` 不直接渲染。安装 LibreOffice 后，可在 CoScribe 中转换为同目录 PDF；LibreOffice 不随应用打包，因此不会增加安装包体积。

### 配置 AI

打开“设置 → AI 服务”，填写：

- 服务地址：OpenAI-compatible API 的基础地址或完整接口，例如 `https://api.openai.com/v1`、`https://example.com/v1/chat/completions` 或本机服务。
- 接口协议：建议保持“自动”，也可固定为 Responses API 或 Chat Completions。
- 模型：服务端实际支持的模型名。
- API Key：远程服务必须填写；`localhost`、`127.0.0.0/8` 和 `::1` 本机服务可无 Key。

状态栏可快速切换 `gpt-5.6-luna`、`gpt-5.6-terra`、`gpt-5.6-sol`，以及 `low`、`medium`、`high`、`xhigh`、`ultra`、`max` 六档思考强度。第三方服务是否真正接受这些值由服务端决定。

远程 AI 地址只允许 HTTPS，避免 API Key 通过明文 HTTP 发送；HTTP 仅对本机回环地址开放。API Key 使用 Electron `safeStorage` 加密保存在系统用户数据目录，不写进项目或聊天正文。

如果出现 `Unexpected token '<'`，通常表示服务返回了 HTML 页面而不是 JSON。CoScribe 会在错误中显示最终请求地址；请检查所选协议、反向代理接口和 `/v1` 路径。HTTP 401 则表示服务端拒绝当前 Key。

### 项目记忆与系统提示词

点击左侧“记忆”会读取当前项目根目录的 `COSCRIBE.md`。这个文件只适合记录跨会话仍然稳定的内容，例如项目目标、术语约定、用户偏好、架构决策和已知限制。它是普通 Markdown，可以提交到版本控制，也可以由其他编辑器直接修改。

- 保存记忆后，后续 AI 请求会读取当前项目的这一个文件，不会跨项目混用。
- 明确对 AI 说“记住这条”时，AI 可以提出对 `COSCRIBE.md` 的修改；API Key、密码和大段会话原文不应放入记忆。
- “设置 → 系统提示词”用于长期调整回答方式。应用内置安全规则始终优先，自定义提示词不能扩大文件路径、密钥或自动执行权限。
- 不想把项目记忆发给模型时，可在“设置 → AI 上下文与记忆”关闭它；文件本身不会被删除。

### 本地语音输入

在 AI 输入栏点击“语音”，允许麦克风权限后即可开始。转写结果会实时出现在当前输入框；再次点击麦克风结束，CoScribe 不会自动发送，你可以先修改文字再发送。

v2.0.0 使用 sherpa-onnx 与约 60 MB 的中英双语 small streaming Zipformer 模型。模型随 macOS 应用打包，原始录音和转写都在本机处理，不调用云端语音 API。识别运行时在独立进程中按需启动，停止转写后即退出，避免常驻占用模型内存。当前只支持 Apple Silicon macOS。

### 计划与日程插件

点击左侧“插件”，打开内置“计划与日程”。你可以快速录入日期、时间、优先级和备注，也可以描述目标，让已配置的 AI 生成计划。所有内容都写入项目的 `计划/项目计划.md`，因此可以直接搜索、引用、版本控制或用 Obsidian/Typora 打开。

v2.0.0 只运行随应用审计过的内置插件，不下载或执行远程 JavaScript。插件清单、权限词汇和启用开关已为后续签名插件市场预留，但第三方市场安装尚未开放。

### GPT-Image 2

文本 AI 与图片生成分别配置。在“设置 → 图片生成”填写第三方 OpenAI-compatible 图片请求地址和独立 API Key。CoScribe 固定调用 `gpt-image-2`，支持：

- 尺寸：`1024x1024`、`1536x1024`、`1024x1536`
- 质量：`low`、`medium`、`high`
- 第三方完整 `/images/generations` 地址或基础 URL

生成后图片会写入当前项目，而不是只留在临时聊天数据中。你可以继续说“把当前图片放到笔记中”，AI 会获得可用的本地路径。

### OCR 使用方法

![CoScribe local OCR](docs/images/local-ocr.png)

1. 打开图片，点击工具栏“本地文字识别”；PDF 则打开目标页后点击“本地识别当前页”。
2. 内置 PP-OCRv6-small、ONNX Runtime Web 与 WASM 在本机运行，不需要首次下载模型，也不会上传图像。
3. 识别结果自动进入当前资料的 AI 上下文，并保存到项目元数据缓存。
4. 需要视觉模型复核时，明确点击“AI 增强”；此操作会把当前图像发送给已配置的 AI 服务。

OCR 结果可能误读，请始终对照原图。AI 增强也不是人工校对。

### 图片、截图与选区

- 在 AI 输入框粘贴图片，或点击“图片”选择文件。支持 PNG、JPEG、WebP 和非动画 GIF。
- 每条消息最多 4 张图，单张最多 5 MB，合计最多 10 MB。
- `Cmd/Ctrl + Shift + 8`：在鼠标所在显示器上框选截图区域；松开后自动进入聊天附件区，不会自动发送，按 `Esc` 可取消。
- 在 Markdown、PDF、DOCX、PPTX 或文本中选中文字后按 `Cmd/Ctrl + Shift + K`：复制到聊天输入框，并切换为“选中内容”上下文。

### 资料浏览器

![CoScribe research browser preserving the original webpage](docs/images/research-browser.png)

点击左侧地球图标打开资料浏览器。它复用 Electron 已有 Chromium，只保留一个标签页，不增加另一套浏览器内核。

- 网页以原始 DOM、样式和交互显示，不会被纯文本阅读模式替换。
- “发送选区”或 `Cmd/Ctrl + Shift + K` 把网页选中文字送入 AI；“发送正文”使用隔离副本提取正文，不修改原页面。
- “保存完整网页归档”使用 Chromium 原生 MHTML，把当前 HTML、样式和已加载资源完整写入项目 `资料剪藏/`，不经过 AI 正文长度限制；归档以完整文件保存（上限 256 MB，不做内容截断），可从文件树交给系统浏览器重新打开。
- “引用来源”把标题、URL 和访问日期插入聊天；语义化 Markdown 剪藏也保存在项目 `资料剪藏/`。
- “保存 PDF”直接打印当前原网页，保留可打印的布局和背景。视频、动画和登录态内容仍受网站打印实现限制。
- 视频站点、直接媒体、复杂下载和所有弹出窗口交给系统浏览器。

远程网页使用独立内存会话，没有 preload、Node.js、CoScribe IPC、摄像头、麦克风、定位、通知、USB 或文件系统权限。弹窗和下载不能借此访问本地项目。

### AI 上下文与写入规则

上下文范围有五档：选中内容、当前内容、当前文档、当前项目、模型通用知识。默认“当前内容”优先使用实时选区，否则使用当前页、章节或可见段落；只有明确选择“当前项目”才执行项目检索。

发送时会固化项目、活动分屏、文档、页码/章节、网页 URL、选区和引用文件。发送后切换标签不会改变已发问题的上下文。

普通 AI 创建、追加或替换 Markdown 时会显示文件列表和差异，只有接受后才写盘。“整理笔记”按钮是明确的自动保存动作：AI 会结合会话主题、项目目录和已有笔记，自主选择匹配的文件或创建合适的新目录与笔记；当前打开文档只作为参考，不再被默认追加。AI 不能删除文件、写项目外路径或覆盖二进制文件。

### 本地数据与安全

- 项目始终是普通文件夹；CoScribe 只在根目录的 `.vibeknowledge/` 保存会话、布局、批注和 OCR 缓存。
- 路径守卫拒绝 `..` 越级、项目外绝对路径、符号链接跳转和元数据目录写入。
- Markdown 写入采用临时文件、同步和原子替换，并检查外部修改时间。
- 主窗口启用 Electron sandbox、context isolation、禁用 Node integration；IPC 仅接受受信任应用页面。
- DOCX HTML 经净化后渲染；资料文件和网页内容都被视为不可信参考资料，而不是系统指令。
- AI、AI OCR 和图片生成只在用户明确操作后把相应内容发送到配置的服务。

### 从源码运行

要求 Node.js `20.19+` 或 `22.12+`，以及 npm。

```bash
npm install
npm run fetch:asr-model
npm run dev
```

验证和构建：

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
```

macOS 打包：

```bash
npm run dist:mac:arm64
npm run verify:package:mac
```

`fetch:asr-model` 会校验每个模型文件的大小和 SHA-256。macOS 发布包当前未做受信任证书签名。

### 当前限制

- 没有云同步、账号系统、多人协作、移动端和 PDF/DOCX/PPTX 原文编辑。
- v2.0.0 只构建和验证 Apple Silicon macOS；本地语音识别暂不支持 Intel Mac 或 Windows。
- 插件市场目前只开放可信内置插件，尚不能安装第三方插件包。
- `.ppt` 依赖用户自行安装 LibreOffice 后转换；复杂 PPTX 字体、视频、宏和特殊对象可能与 PowerPoint 有差异。
- 资料浏览器是研究辅助工具，不是完整浏览器；不提供多标签、密码管理、扩展、复杂下载或视频播放。
- OCR 和 AI 输出均可能出错，重要内容需要核对原文。

---

<a id="english"></a>

## English

CoScribe treats a normal local folder as the project. It brings PDF, DOCX, PPTX, image, text, and Markdown reading into one desktop workspace, adds local OCR and configurable AI, and saves durable results back as standard files. Your project remains usable in Obsidian, Typora, VS Code, and ordinary file managers.

### Download and install

Download the latest release from [GitHub Releases](https://github.com/UESTC-ly/CoScribe/releases/latest):

| Platform | Artifact | Target |
| --- | --- | --- |
| macOS | `CoScribe-2.0.0-arm64.dmg` | Apple Silicon, macOS 13+ |
| macOS | `CoScribe-2.0.0-arm64-mac.zip` | Portable Apple Silicon archive |

v2.0.0 focuses on Apple Silicon macOS. The build is currently unsigned. Drag the app into Applications, then right-click it and choose Open. If macOS still blocks it, use System Settings → Privacy & Security → Open Anyway. Grant Screen Recording only for region capture and Microphone only for local speech input. Verify downloads against the release `SHA256SUMS.txt` when integrity matters.

### Start in three steps

1. Open an existing local folder or create a new project.
2. Open a document, select relevant content, and ask AI with an explicit context scope.
3. Review ordinary AI file proposals before accepting them. The explicit Quick Note action saves its organized result immediately.

CoScribe recognizes existing files and nested folders. Development folders such as `.git`, `.venv`, and `node_modules` are excluded from the research tree.

### What it supports

- Markdown opens in preview mode and includes editing, a collapsible and resizable outline, GFM, math, Mermaid, language detection, and syntax highlighting.
- PDF includes continuous reading, thumbnails, outlines, search, selections, highlights, comments, bookmarks, and OCR.
- DOCX is parsed and sanitized locally. PPTX is rendered read-only in the app and its slide text is available to search and AI.
- Images support local OCR and optional AI-enhanced OCR. Plain text formats are readable and searchable.
- AI answers render Markdown, math, Mermaid, and highlighted code.
- `COSCRIBE.md` provides transparent, project-scoped long-term memory that remains reviewable and portable.
- The AI composer supports fully local, live Chinese-English speech-to-text; text appears while speaking and is never auto-sent.
- An editable custom system prompt controls response style below CoScribe's immutable safety boundaries.
- The trusted built-in Planner plugin stores schedules in `计划/项目计划.md` and can ask AI to generate a plan from a goal.
- AI can create 1–50 Markdown files, missing directories, and complete linked note projects without requiring empty files first.
- GPT-Image 2 output is saved under `assets/ai-images/`; later turns receive verified relative, Markdown-ready, and absolute paths.
- The single-tab research browser keeps the original webpage visible, sends selections or article text to AI, and saves complete MHTML archives, semantic Markdown clippings, or print-layout PDFs.

| Format | Viewer | Search/AI | Editing |
| --- | --- | --- | --- |
| Markdown (`.md`, `.markdown`) | Full preview | Yes | Yes |
| PDF | Continuous pages | Text layer or OCR | Annotations only; source PDF is unchanged |
| DOCX | Local semantic preview | Yes | No |
| PPTX | Local read-only slides | Per-slide extracted text | No |
| PPT | Recognized as legacy format | Convert with a separate LibreOffice install | No |
| MHTML/MHT web archive | Opens the preserved page archive in the system browser | No | No |
| PNG/JPEG/WebP/GIF/SVG and more | Image viewer | After OCR | No |
| TXT/JSON/YAML/source text | Text viewer | Yes | No |

### Configure AI

Open Settings → AI service and provide an OpenAI-compatible base URL or full endpoint, protocol mode, model name, and API key. Automatic protocol mode understands base URLs and explicit `/responses` or `/chat/completions` endpoints. Remote services require HTTPS and a key; loopback services may use HTTP without a key.

The status bar offers `gpt-5.6-luna`, `gpt-5.6-terra`, and `gpt-5.6-sol`, with `low`, `medium`, `high`, `xhigh`, `ultra`, and `max` reasoning levels. A third-party provider must actually support the selected values. Keys are encrypted with Electron `safeStorage` and never stored in the project.

An `Unexpected token '<'` error means the endpoint returned HTML instead of JSON. Check the final request URL, protocol selection, proxy route, and `/v1` path. HTTP 401 means the provider rejected the key.

### Project memory, system prompt, and local speech

Open Memory in the activity rail to inspect the current project's root `COSCRIBE.md`. Use it for durable goals, terminology, preferences, decisions, and constraints—not secrets or raw conversation dumps. Each AI turn can include only the current project's memory, and the setting can be disabled without deleting the file.

Settings → System prompt provides editable behavioral instructions. CoScribe's path, secret, and confirmation rules remain higher priority and cannot be relaxed by this prompt.

Click Voice in the AI composer to start local live transcription. The draft updates while you speak; click again to stop, edit the result, and send when ready. v2.0.0 bundles sherpa-onnx and an approximately 60 MB bilingual small streaming Zipformer model. Audio never goes to a speech cloud service. The recognizer runs in an isolated on-demand process and exits after recording, so model memory is not permanently resident. This feature currently targets Apple Silicon macOS only.

### Trusted Planner plugin

Open Plugins → Planner to add dated tasks or ask configured AI to create a plan from a goal. The plugin's source of truth is ordinary Markdown at `计划/项目计划.md`, so schedules remain searchable, versionable, and usable in other editors.

v2.0.0 runs audited built-in plugins only and never downloads or evaluates remote JavaScript. Manifests, explicit permissions, and enable/disable controls establish the boundary for a future signed marketplace; third-party installation is not available yet.

### GPT-Image 2 and OCR

Image generation has an independent URL and API key so a third-party compatible provider can be used. CoScribe calls `gpt-image-2` with three supported sizes (`1024x1024`, `1536x1024`, `1024x1536`) and `low`, `medium`, or `high` quality.

For OCR, open an image and choose Local text recognition, or open a PDF page and choose Local recognition for current page. Bundled PP-OCRv6-small models run locally through WASM with no first-run model download. AI Enhance is opt-in and uploads only the current image or rendered PDF page to the configured AI service. Always verify OCR output against the source.

### Images, screenshots, and selections

- Paste or choose up to four PNG, JPEG, WebP, or non-animated GIF images per message; each image is limited to 5 MB and the total to 10 MB.
- `Cmd/Ctrl + Shift + 8` lets you drag-select a region on the display under the pointer. Releasing adds the crop to pending chat attachments without sending it; `Esc` cancels.
- `Cmd/Ctrl + Shift + K` copies a document selection into the AI composer and switches to selection context. The same shortcut works while a webpage has focus.

### Research browser

Open the globe icon in the activity rail. CoScribe reuses Electron Chromium and intentionally keeps one tab. The live page retains its original DOM, styling, and interaction; extraction runs on an isolated clone and never replaces the page.

Send Selection and Send Article create a verified web context for AI. Cite Source inserts the title, URL, and access date. Save Complete Archive uses Chromium MHTML to persist the current HTML, styles, and loaded resources under `资料剪藏/` without passing through the AI extraction limit. The archive is all-or-nothing up to 256 MB rather than content-truncated. Markdown creates a semantic clipping, while PDF prints the live page with printable layout and backgrounds. Video sites, direct media, complex downloads, and all popups are delegated to the system browser.

Remote pages run in a separate in-memory session with no preload, Node.js, CoScribe IPC, camera, microphone, geolocation, notifications, USB, or filesystem permissions.

### Context, writes, and local security

Context scopes are Selection, Current content, Current document, Project, and General knowledge. Each sent message freezes its document, page or heading, web URL, selection, pane, and referenced files. Switching tabs later does not change the recorded context.

Ordinary AI Markdown changes require preview and acceptance. Quick Note is the explicit automatic-save exception: it uses the conversation topic, project tree, and existing notes to choose a matching destination or create a suitable structure. The open document is context, not a default append target. AI cannot delete files, escape the project, follow symlinks, or overwrite binary documents.

Projects remain ordinary folders. `.vibeknowledge/` stores only workspace state, sessions, annotations, and OCR metadata. Writes use path guards and atomic replacement. The Electron renderer is sandboxed with context isolation and no Node integration, and IPC accepts only the trusted app page.

### Build from source

Use Node.js `20.19+` or `22.12+`:

```bash
npm install
npm run fetch:asr-model
npm run dev

npm run typecheck
npm test
npm run test:e2e
npm run build
```

Build and inspect the macOS artifact with `npm run dist:mac:arm64` and `npm run verify:package:mac`. The model fetch script verifies each bundled ASR file against fixed size and SHA-256 values.

### Current limits

CoScribe does not provide cloud sync, accounts, collaboration, mobile clients, or source editing for PDF/DOCX/PPTX. v2.0.0 is built and verified for Apple Silicon macOS only, is unsigned, and its local speech recognizer does not yet support Intel Mac or Windows. The plugin center currently accepts trusted built-ins only. Legacy PPT conversion requires a separate LibreOffice installation. The research browser deliberately omits multi-tab browsing, passwords, extensions, advanced downloads, and video playback. OCR and AI output must be checked against primary sources.

## License

[MIT](./LICENSE)
