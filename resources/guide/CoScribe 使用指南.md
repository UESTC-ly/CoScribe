# CoScribe 简明使用指南 / Quick Guide

> CoScribe 把普通文件夹作为项目。你的 Markdown、PDF、DOCX、PPTX、图片和网页资料始终保留在本地文件系统中。

新建项目时，本文件会自动放进项目根目录。它可以正常编辑、移动或删除；应用右上角的“使用指南”按钮始终可以重新打开内置版本。

## 五分钟开始

1. **创建或打开项目**  
   点击“新建项目”，或直接打开一个已有资料文件夹。已有 Markdown 和子文件夹会显示在左侧文件树中。
2. **配置 AI**  
   打开“设置 → AI 服务”，选择 OpenAI 格式或 Anthropic 格式，分别填写服务地址、模型和 API Key。两套配置独立保存，右下角模型菜单可直接跨提供方切换。
3. **打开资料**  
   CoScribe 支持 Markdown、PDF、DOCX、PPTX、图片、常见文本与代码文件。Markdown 默认使用预览模式。
4. **选择上下文**  
   在聊天输入框上方选择“选中内容”“当前内容”“当前文档”“当前项目”或“模型通用知识”。
5. **保存知识**  
   普通 AI 文件修改会先展示差异；点击“整理笔记”时，AI 可以在项目中选择合适位置并创建 Markdown 文件或目录。

## 推荐工作流

```mermaid
flowchart LR
  A[打开本地资料] --> B[选中关键内容]
  B --> C[向 AI 提问]
  C --> D[检查答案与来源]
  D --> E[整理为本地笔记]
```

### 阅读和提问

- 左侧文件、会话、搜索、标注、记忆、AI 操作和插件图标可以重复点击：第一次打开对应侧栏，再次点击当前图标会收起。左侧栏和 AI 侧栏的收起按钮都位于各自面板内。
- 在 Markdown、PDF、DOCX、PPTX 或文本中选中文字，再选择“选中内容”。
- 按 `Cmd/Ctrl + Shift + K` 可以把文档选区放入聊天输入框。
- 发送后，上下文会冻结；之后切换文档不会改变已经提交的问题。
- 长对话右侧的浅色刻度可以快速跳到每次请求的开头。
- AI 上下文区域会显示当前请求窗口的预估 token 占用和回答预留空间。超过预算时默认只压缩发送给模型的早期历史，界面中的原始聊天不会删除；也可以点击“压缩早期历史”强制压缩下一次请求。
- 在聊天输入框输入 `/` 可以打开命令菜单。`/compact` 会让 AI 对当前完整逻辑会话生成一份可持续使用的语义摘要；原始聊天仍保留，后续请求使用摘要加上新增消息。按钮“压缩早期历史”仍是只影响下一次请求的轻量压缩。

### 聊天命令

| 命令 | 作用 |
| --- | --- |
| `/compact` | 全量压缩当前会话并持久化摘要，原始记录不删除 |
| `/fork [标题]` | 从当前会话分叉出独立副本 |
| `/resume [标题或 ID]` | 恢复最近或指定会话；不带参数恢复最近的其他会话 |
| `/new [标题]` | 新建空白会话 |
| `/rename <标题>` | 重命名当前会话 |
| `/clear` | 清空当前会话及其压缩、整理检查点 |
| `/note` | 只整理上次整理之后新增的对话内容并保存到项目 |
| `/stop` | 停止当前 AI 请求或图片生成 |
| `/quit` | 收起 AI 侧栏 |
| `/help` | 打开命令帮助 |

命令可以用鼠标点击，也可以用 `↑` / `↓`、`Tab` 和 `Enter` 操作。未知的斜杠文本不会发送给模型。

### OpenAI 与 Anthropic 配置

- **OpenAI 格式**支持 Responses API 与 Chat Completions，也可填写第三方 OpenAI-compatible 地址。
- **Anthropic 格式**使用 Messages API：应用会请求 `/v1/messages`，使用 `x-api-key` 与固定的 `anthropic-version: 2023-06-01`。
- 如果第三方 Anthropic 代理提供版本路径或完整 `/messages` 地址，可直接填写；CoScribe 不会把 OpenAI 和 Anthropic 的密钥混用。
- Anthropic 当前思考强度使用 `output_config.effort`。菜单会提供 `low`、`medium`、`high`、`xhigh` 和 `max`；OpenAI 配置仍保留 `ultra`。
- “设置 → AI 上下文与记忆”可以覆盖上下文窗口和回答预留 token。填写 `0` 会使用 CoScribe 的模型预设。

### 整理和创建笔记

- “整理笔记”不会默认追加到当前文档，而是让 AI 根据会话主题和项目结构选择位置。
- 每次整理成功写入后，CoScribe 会记录本次处理到的最后一条会话消息；再次点击“整理笔记”或执行 `/note` 时，只处理新增内容，不会重复整理已完成部分。只有文件真正写入成功，检查点才会推进。
- 整理过程中会逐步显示筛选会话、读取项目资料、模型生成、校验操作和写入文件等状态；失败或停止不会误标为已整理。
- AI 可以创建新的 Markdown 文件、子文件夹和多文件笔记结构。
- 普通文件修改需要确认后才写入磁盘；已经接受的多文件操作可以在“AI 操作”中撤销。
- 项目根目录的 `COSCRIBE.md` 用于保存稳定的项目目标、术语、偏好和约束。

## 文档与媒体

| 内容 | 使用方式 |
| --- | --- |
| Markdown | 预览、编辑、双栏、大纲折叠、Mermaid、数学公式和代码高亮 |
| PDF | 连续阅读、目录、搜索、选区、批注、书签和当前页 OCR |
| DOCX | 本地语义预览和全文搜索 |
| PPTX | 本地只读幻灯片预览和逐页搜索 |
| 图片 | 查看、缩放、本地 OCR 或显式 AI 增强 |
| 网页 | 使用内置单标签资料浏览器，保留原网页并可保存 Markdown、PDF 或 MHTML |

### 截图、粘贴图片与 OCR

- 点击聊天工具栏中的“截图”，或按 `Cmd/Ctrl + Shift + 8`，然后拖动鼠标框选区域。
- 可以直接把 PNG、JPEG、WebP 或非动画 GIF 粘贴到聊天输入框。
- 图片点击“本地文字识别”，PDF 点击“本地识别当前页”。
- macOS Apple Silicon 可点击“语音”进行本地中英文实时转写。

### 图片生成

在“设置 → 图片生成”中单独填写 GPT-Image 2 的服务地址和 API Key。生成图片会保存到：

```text
assets/ai-images/
```

随后可以在聊天中要求 AI 把生成图片插入笔记。

## 代码块

代码语言会自动识别和高亮。右上角按钮会把原始代码复制到系统剪贴板：

```typescript
interface LearningNote {
  source: string
  summary: string
}

const note: LearningNote = {
  source: '本地项目',
  summary: '让知识回到自己的文件中'
}
```

## 常用快捷键

| 操作 | macOS | Windows / Linux |
| --- | --- | --- |
| 发送选区到聊天 | `⌘ ⇧ K` | `Ctrl + Shift + K` |
| 框选截图 | `⌘ ⇧ 8` | `Ctrl + Shift + 8` |
| 保存 Markdown | `⌘ S` | `Ctrl + S` |
| 查找 | `⌘ F` | `Ctrl + F` |
| 发送消息 | `Enter` | `Enter` |
| 输入换行 | `Shift + Enter` | `Shift + Enter` |

## 常见配置问题

- `Unexpected token '<'`：服务返回了 HTML 而不是 JSON，请检查最终请求地址、所选提供方、接口协议和 `/v1` 路径。
- `HTTP 401 / Invalid API key`：服务端拒绝当前 API Key，请检查 Key 是否属于这个服务地址。
- 第三方服务未必支持所有模型名或思考强度，以服务端说明为准。
- API Key 保存在系统用户数据目录，不会写入项目或本指南。

---

## English Quick Guide

1. Create a project or open an existing folder.
2. Configure the AI endpoint, protocol, model, and API key under **Settings → AI Service**.
3. Open a local document and choose the exact context scope before sending a request.
4. Use **Organize notes** when you want AI to choose an appropriate project location and create durable Markdown notes.
5. Use the copy button on code blocks, paste images into chat, or press `Cmd/Ctrl + Shift + 8` for a region screenshot.

The OpenAI-compatible and Anthropic Messages profiles are stored separately. Use the model switcher in the lower-right corner to switch providers. The context meter shows estimated input usage and output reserve; request-only compaction never deletes the visible chat history. Re-click any active left rail icon to collapse its panel.

New projects receive a local copy of this guide. The built-in copy remains available from the **User Guide** button in the upper-right corner.
