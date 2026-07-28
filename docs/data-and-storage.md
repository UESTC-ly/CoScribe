# 数据与存储

## 设计原则

用户资料首先是普通文件。CoScribe 读取和写入项目中的 Markdown、代码、文本及用户明确选择的内容，不要求导入专有数据库。

项目内元数据存放在隐藏目录 `.vibeknowledge/`。这个旧名称是兼容性约束，不能在没有迁移设计的情况下改为 `.coscribe`。

## 项目内数据

| 位置 | 用途 | 说明 |
| --- | --- | --- |
| 用户文件夹及原始资料 | 用户的 Markdown、代码、PDF、DOCX、PPTX、图片等 | 主数据，仍可被其他软件使用 |
| `COSCRIBE.md` | 项目级长期记忆 | 保存稳定目标、术语、偏好和决策；不要存密钥 |
| `.vibeknowledge/` | 应用元数据 | 工作区、会话、批注、OCR、AI 操作等 JSON |
| `assets/ai-images/` | 经确认写入项目的生成图片 | 由主进程保存并校验路径 |

项目文件树默认不把 `.vibeknowledge`、`.git`、`node_modules`、`.venv` 等目录作为普通资料展示。

## 用户级数据

Electron `userData` 用于保存：

| 文件/区域 | 内容 |
| --- | --- |
| `settings.json` | 非机密设置和加密密钥的引用/密文 |
| `recent-projects.json` | 最近项目记录 |
| `mcp-servers.json` | 加密的 MCP 配置 |
| `browser-history.json` | 资料浏览器历史 |
| 浏览器持久分区 | 资料浏览器 Cookie/localStorage 等登录态 |

具体目录由操作系统和 Electron 解析。当前应用为了兼容历史配置使用 `vibeknowledge` userData 名称。

## 一致性与恢复

JSON 写入使用临时文件、同步和原子重命名。读取损坏或不存在的 JSON 时，相关服务会尽量回退到安全默认值而不阻止用户继续打开项目。

AI 文件操作保留 before/after 内容以支持撤销，因此 `ai-operations.json` 可能包含敏感正文。备份、同步、问题报告和人工共享前应审查 `.vibeknowledge/` 内容。

## 备份建议

1. 优先备份项目原始文件和 Markdown。
2. 需要恢复会话、批注、OCR 或工作区布局时，再同时备份 `.vibeknowledge/`。
3. 需要迁移 AI 服务配置时，依赖目标系统的 `safeStorage` 可用性；不要复制明文 API Key 到项目。
4. 资料浏览器的登录态可能敏感，默认不应纳入共享归档。

## Git 与隐私

项目可以是 Git 仓库，但本地 Git 快照不是云备份，也不会自动推送远程。`.vibeknowledge`、生成图片、会话历史和用户资料是否进入项目 Git，应由项目维护者在 `.gitignore` 中明确决定。

本仓库自身的 `/learn/` 是私有本地资料，根 `.gitignore` 已排除。不得用 `git add -f` 将其加入源码、tag、Release 或公开制品。
