# 个人记忆：Markdown 正文、SQLite 索引、分层召回

实施日期：2026-10-07。采用 OpenClaw 的文件正文与派生检索索引思路，保留 CoScribe 的来源、确认、版本和独立远程授权。当前能力以 `electron/main/assistant/` 和 `electron/main/ai.ts` 为准。

## 存储边界

个人记忆跨项目使用，位于 Electron `userData/assistant/`，不混入项目 `.coscribe/COSCRIBE.md`：

| 位置 | 职责 |
| --- | --- |
| `memory/<稳定 ID>.md` | 已确认的 profile、preference、goal 正文；正文的事实源 |
| `assistant.sqlite` 的 memories / sources / policy | 稳定 ID、类别、来源、修订、时间、授权，以及与 Markdown 核对后的正文缓存 |
| memory_fts / memory_vectors | 可重建的 FTS5 与可选 embedding 索引 |
| memory_files / memory_file_outbox | 已核对内容哈希与持久化待写入操作 |
| memory_search_policy | 用户选定的 embedding 服务配置 ID 和模型名称，不含密钥 |
| memory_answer_origins | 会话与受记忆影响的回答哈希、记忆代次；不复制回答正文 |
| memory_answer_pending | 发送记忆前的持久化回答准备记录；保护中断或未完成来源登记的流式片段 |
| 原有学习、活动与复盘表 | 保持结构化事务存储，独立区分关注、阶段、自评、复习事件及来源 |

每条已确认记忆有独立 Markdown 文件，首行包含由程序生成的 ID，正文最多 1,000 字符。改文字不改变 ID；手工编辑保留 ID 标记。目录中的未知文件不会被自动吸收为用户事实。模型建议、网页、文献和邮件不能通过复制文件或工具调用直接写入学习能力事实。该目录属于用户本人控制的全局数据，手工修改已登记的正文视为用户纠正，来源记为 `memory-file`。

SQLite 仍有不可丢失的来源、授权和学习历史元数据，不能删除整个数据库后仅靠 Markdown 自动恢复这些信息。设置页的“重建索引”只重建 FTS5、清除并按配置重算向量，保留 ID 和来源；不会把未登记文件导入为事实。

## 写入、迁移和恢复

schema 3 → 4 前使用 `VACUUM INTO` 保存 `assistant.sqlite.v3-UUID.bak` 一致备份。已有条目的 ID、类别、来源、时间、修订与旧学习／复习历史保留，正文逐条写到 Markdown。更早的 schema 继续依次执行原有迁移与相应备份；新安装不建立空库备份。

更新索引、来源、版本和 outbox 使用同一个 SQLite 事务。outbox 记录文件旧哈希及目标正文；文件先用临时文件同步、核对旧哈希，再原子替换，最后确认索引中的文件哈希并删除 outbox。数据库与文件之间没有跨存储原子事务，可靠性来自可核对的准备记录：

- 文件仍匹配旧哈希：完成已提交的写入。
- 文件已与目标内容一致：确认文件提交后的数据库收尾。
- 文件既非旧内容也非目标内容：报冲突，保留原文件和准备记录，不盲目覆盖。

每次查询或管理操作先完成待写入核对，再检查已登记文件。手工修改正文递增条目版本和全局记忆代次、更新来源和词法索引，并删除旧向量；删除已登记文件执行遗忘并保留不含正文的排除指纹。文件移动／改名目前视为原条目删除，不能通过改名生成新事实；应用内修正无需改名。项目关闭不影响全局记忆，项目来源的可用性继续由学习服务单独核对。

目录、正文和数据库均拒绝符号链接；目录为 0700，新增正文、临时文件、数据库和迁移备份为 0600。正文损坏、索引身份丢失或数据库损坏明确报错，不能用正文缓存静默代替失效文件。首次 worker 初始化允许 30 秒以完成迁移，后续命令超时为 5 秒；超时不自动重试，需重启并核对实际结果。

备份应在应用关闭后复制整个 `assistant/`，保留数据库与 Markdown 的一致组合。仅复制 Markdown 会丢失授权和来源历史；仅复制正在使用的 SQLite 主文件可能遗漏 WAL。迁移备份、原聊天、文件系统快照和已导出笔记不会随遗忘自动删除。

## 三层召回

```mermaid
flowchart LR
  Query[本次问题与用户话题] --> Core[少量偏好与相关摘要]
  Core --> Model[模型判断是否需展开]
  Model --> Search[memory_search]
  Search --> Hits[摘要 / ID / revision]
  Hits --> Read[memory_read]
  Read --> Body[当前 Markdown 正文或结构化学习证据]
  Body --> Answer[回答]
```

第一层由程序提供最多四条偏好和三条相关个人信息摘要；偏好预算 1,500 字符，非偏好摘要每条最多 180 字符，个人记忆条目与相关学习状态总数据预算 4,000 字符，其中学习状态最多 2,000 字符。不把所有记忆 description 全量装入前缀。检索问题结合当前提问、文档名／标题和最近两条用户话题；模型旧回答不能作为用户能力事实来源。

第二层 `memory_search({ query, limit })` 默认返回五项，最多八项，每项只有摘要、稳定 ID、条目版本、类型与相对路径。使用 FTS5 / BM25，中文字符与双字组合、英文标识符，以及有限的明确别名（如 RAG / 检索增强生成）。开启 embedding 后将同一服务／模型生成的向量余弦候选与词法候选做 reciprocal rank fusion；分数是排序依据，不是事实可信度或掌握概率。知识点目前参与词法搜索，个人记忆正文参与混合搜索。

第三层 `memory_read({ items: [{ kind, id, revision }] })` 最多展开五项，序列化数据预算 6,000 字符。严格核对本轮全局记忆代次及每项版本，返回当前正文和来源，或当前知识点的自述与复习证据。工具不能按模型提供的任意路径读文件，也不能写入、纠正或删除记忆。无结果时模型应说明缺少个人依据。

Chat Completions、Responses 和 Anthropic Messages 均支持只读工具循环，包括流式调用；工具结果绑定调用 ID，Responses 保留 reasoning 输出，Anthropic 保留 thinking/signature。每轮最多四次记忆工具调用，禁止相同参数重复调用；模型同时要求多个工具时拒绝发送记忆。工具定义、保留的工具历史和新结果一起受上下文预算检查，超限明确失败。

## 可选 embedding 与费用

设置 → 关于我 → 记忆检索：默认“仅关键词”。要启用语义检索，选择已有 OpenAI-compatible 服务并填写它支持的 embedding 模型名称；可以使用本机 embedding 服务。API Key 复用服务配置的 `safeStorage` 凭据，不写入 Markdown 或助理库。

向量按正文哈希和服务地址／模型身份缓存，后台仅处理新增、修改或需重建的个人记忆，单批最多 32 项。检索词向量最多缓存 64 项，本轮网络调用有取消及 8 秒超时。远程 embedding 同样需要开启个人记忆召回及独立远程授权；关闭或撤销后不再提交正文，并取消正在进行的索引请求。已发送的数据无法撤回。

服务不可用时回退到词法检索并在 AI 活动记录说明；索引尚未完成时提示语义候选覆盖不完整。未配置 embedding 时不产生 embedding 请求或模型提取费用。未实测真实 embedding 服务，检索准确率仍需使用用户许可的数据集评估；别名和词法搜索不等于一般语义理解。

## 前缀复用与纠正优先

普通聊天的系统指令与工具定义保持固定，变化的项目资料和记忆放在最新用户消息的上下文区块。主进程为最多 16 个会话保留此前实际发送的消息和工具结果；同一模型／协议／上下文范围、用户历史准确延续且记忆代次未变时，只追加新消息，不重写前面的记忆片段。单项历史超过 300,000 字符不缓存，窗口不足时回到常规压缩流程。

纠正、删除、授权变化或历史编辑立即使旧工具历史失效。发送记忆前先持久化回答准备记录，完成或中断时登记已经显示的正文哈希；后续回答和压缩摘要继承已有记忆来源。后续请求过滤旧代次的相关 assistant 消息及应用生成的摘要区块，关闭召回或禁止远程发送时过滤该会话所有有记忆来源的旧回答。若中断片段未能完成来源登记，准备记录会使变更后的该会话旧 assistant 消息和生成摘要全部停止发送。数据库不可用时也不继续发送无法核对的旧 assistant 消息或生成摘要。用户主动提交的原始聊天正文仍由用户控制，不能宣称已从原聊天或外部备份擦除事实。

这能保留符合条件的精确前缀，但不能保证 Provider 缓存命中；首次工具调用有额外请求成本，记忆变化时主动放弃旧前缀。当前没有真实 `cached_tokens` 命中率和费用测量。

## 入库触发与后续范围

正文在显式保存、候选确认或已单独授权的明确学习自述自动保存时入库；手工纠正文件在下一次管理／查询时同步索引。现有自动提取仍是处理本次直接用户输入的本地规则，没有持续监听的子 Agent，没有把整段对话定期总结入库。

本轮没有实现 OpenClaw 的 Dreaming 周期整理、压缩前模型 flush、每日 episodic 日志、通用重排／MMR 或完整工具运行账本。后续需要先定义独立授权、可确认的候选、冲突核对及失败恢复，再接模型提取与定期整理；不得把外部内容或模型评价当作用户掌握事实。

参考设计：[OpenClaw Memory](https://docs.openclaw.ai/concepts/memory)、[OpenClaw 内置记忆实现](https://github.com/openclaw/openclaw/blob/main/docs/concepts/memory-builtin.md)。具体命名、确认与迁移协议以 CoScribe 源码为准。

## 本轮验证

仅运行相关 Vitest 与 `npm run typecheck`，不运行全量 `npm test`、桌面 E2E、GUI 或真实服务请求。测试使用真实临时 SQLite／Markdown 文件验证迁移、重启、冲突、权限、遗忘及索引失效；模型协议与 embedding 网络响应使用 mock，包含普通／流式工具循环、前缀保留、撤权、摘要继承及中断回答来源登记。未访问用户实际助理库，迁移在新代码首次读取旧库时发生。

实际运行命令：

```sh
npx vitest run --config electron/vitest.config.ts \
  electron/main/assistant/markdown-memory.test.ts \
  electron/main/assistant/memory-tools.test.ts \
  electron/main/assistant/embeddings.test.ts \
  electron/main/assistant/service.test.ts \
  electron/main/assistant/database.test.ts \
  electron/main/assistant/workflows.test.ts \
  electron/main/assistant/learning-store.test.ts \
  electron/main/assistant/learning-service.test.ts \
  electron/main/assistant/review-service.test.ts \
  electron/main/assistant/ai-integration.test.ts \
  electron/main/ai-response.test.ts \
  electron/main/ai-context.test.ts \
  electron/main/ipc-learning.test.ts
npm run typecheck
git diff --check
```

结果：13 个测试文件、190 项通过，无跳过；Renderer 与 Node/Electron 类型检查通过；差异空白检查通过。未进行生产构建、真实服务与缓存费用验证，也未做当前改动的桌面界面验收。
