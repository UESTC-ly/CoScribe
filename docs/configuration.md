# 配置与 AI 服务

## 配置位置与原则

CoScribe 不依赖项目根目录 `.env` 作为日常运行前置条件。用户配置由主进程保存在 Electron `userData` 目录，核心设置文件为 `settings.json`。

- 非密钥设置以 JSON 保存，并在读取时归一化。
- AI Provider Key、图片生成 Key 和 MCP 配置使用 Electron `safeStorage` 加密后保存。
- Renderer 只获得 `hasApiKey` 等状态，不会读取已保存密钥明文。
- 不能使用系统安全存储时，应用会拒绝保存或读取相关机密。

`userData` 的具体操作系统路径由 Electron 决定；当前应用为了兼容历史数据仍使用 `vibeknowledge` 目录名。不要手工重命名该目录，否则可能造成设置、最近项目或浏览器历史看似丢失。

## AI Provider

在“设置 → AI 服务商”中维护多个命名配置：

| 字段 | 说明 |
| --- | --- |
| 名称 | 便于识别的本地名称 |
| Provider | OpenAI-compatible 或 Anthropic Messages |
| 基础地址 | HTTP(S) 服务地址；远程服务必须使用 HTTPS |
| 协议 | OpenAI-compatible 可选 `auto`、Responses 或 Chat Completions |
| 模型 | 当前 Provider 下启用的模型 |
| API Key | 远程服务通常必填；回环本地服务可为空 |
| 思考强度 | Provider 支持时传递的可选参数 |

地址校验规则：

- 仅接受 `http://` 和 `https://`。
- 非回环地址上的明文 HTTP 被拒绝，避免 API Key 明文传输。
- `localhost`、`127.0.0.0/8`、`::1` 等回环服务可以使用 HTTP。
- 修改地址会清理旧模型列表，避免把旧服务的模型名带到新服务。

第三方服务声称 OpenAI-compatible 不代表其模型列表、流式输出、工具调用或 reasoning 字段一定兼容。上线前应使用真实 Provider 做最小验证。

## AI 上下文设置

“设置 → AI 行为”控制：

- 默认上下文范围：选区、可见内容、文档、项目或通用知识。
- 会话上下文窗口和输出预留。
- 自动压缩早期请求快照。
- 是否允许模型使用通用知识。
- 是否启用项目级 `COSCRIBE.md` 长期记忆。
- 是否启用编辑器 AI 代码补全。

上下文是在发送时冻结的。未保存代码缓冲区可以进入冻结上下文，但 AI 文件写入仍以磁盘版本和主进程重新校验为准。

## IDE 与 AI Shell 设置

### AI 代码补全

“启用 AI 代码补全”默认开启，只影响编辑器发起的远程 AI 补全请求，不影响 IDE、本地关键字/当前文件符号补全、文件保存或普通 AI 对话。AI 补全使用短暂防抖、轻量前后缀和文件符号上下文；新输入、光标移动或选区变化会取消过时请求。

### AI Shell

“启用 AI Shell 功能”默认关闭。该复选框**仅显示开启入口**：

- 它不会授权 AI。
- 它不会启动终端。
- 它不会执行命令。

实际授权发生在 IDE 底部终端点击“开启 AI Shell”之后，且每次都必须经过风险警告和第二次确认。命令确认模式可选：

| 模式 | 行为 |
| --- | --- |
| 每条命令单独确认（默认） | 每次 AI 调用 Shell 前显示要执行的命令并等待确认 |
| 当前项目会话内授权 | 在当前项目、本次应用会话内不逐条确认；关闭终端、项目或应用即撤销 |

详细安全边界见 [安全与 AI Shell](./security-and-ai-shell.md)。

## E2E 与诊断环境变量

这些变量用于测试或隔离，不是普通用户配置：

| 变量 | 用途 |
| --- | --- |
| `COSCRIBE_E2E_EXECUTABLE` | 指向已打包的应用可执行文件，启用 package smoke |
| `COSCRIBE_ASR_TEST_WAV` | 指向语音 E2E 使用的 WAV 夹具；未提供时该场景跳过 |
| `COSCRIBE_E2E_USER_DATA` | 隔离 Electron userData，避免测试污染真实设置 |

不要把实际 API Key、MCP Token、用户路径或生产聊天数据写入 `.env.example`、测试夹具、Issue、日志或文档。
