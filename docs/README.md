# CoScribe 文档中心

CoScribe 是一个本地优先的 Electron 桌面工作台：普通文件夹就是项目，用户可以阅读资料、维护 Markdown 笔记、使用 AI 协作，并在 v4.0.2 的 IDE 工作区编辑代码和运行受控终端。

本目录是随源码公开发布的项目文档。它不包含 API Key、个人项目路径、聊天记录、测试用户数据或私有交接材料。仓库根目录的 `/learn/` 是本地私有资料，已被 `.gitignore` 排除，不能加入提交或发布制品。

## 阅读路径

| 文档 | 适合读者 | 内容 |
| --- | --- | --- |
| [产品与工作流](./product-and-workflows.md) | 使用者、产品负责人 | 资料阅读、AI 协作、IDE、终端与平台范围 |
| [系统架构](./architecture.md) | 开发者、审查者 | Electron 三进程边界、模块职责、数据与信任流 |
| [开发指南](./development.md) | 开发者 | 环境、命令、目录、代码约定和本地调试 |
| [配置与 AI 服务](./configuration.md) | 使用者、运维者 | 服务商配置、密钥存储、上下文和环境变量 |
| [安全与 AI Shell](./security-and-ai-shell.md) | 使用者、审查者 | 文件确认、IPC、终端、权限与风险模型 |
| [桌面 API](./desktop-api.md) | 开发者、插件维护者 | `window.coscribe` 的公开预加载 API 分类与契约来源 |
| [数据与存储](./data-and-storage.md) | 使用者、运维者 | 项目文件、隐藏元数据、备份和兼容性 |
| [测试与发布](./testing-and-release.md) | 开发者、发布负责人 | Vitest、Playwright、打包、CI 和 GitHub Release |
| [运维与排障](./operations-and-troubleshooting.md) | 支持、运维者 | 日志/诊断、安装、常见故障和问题报告 |
| [已知限制](./known-limitations.md) | 所有人 | 当前能力边界、风险和非目标 |
| [贡献指南](./contributing.md) | 贡献者 | 分支、提交、评审、测试和安全变更要求 |

产品交互与视觉约束的当前决策记录在仓库根目录的 [DESIGN.md](../DESIGN.md)。快速上手、安装说明和完整功能导览见根目录 [README.md](../README.md)。

## 事实边界

- **代码与类型契约优先**：接口和行为以 `src/shared/types.ts`、`electron/ipc-channels.ts`、`electron/preload/index.ts` 及主进程实现为准。
- **测试通过不等于所有环境均已验证**：平台签名、公证、真实第三方 AI 服务和用户硬件权限须按发布环境单独验证。
- **AI 是协作工具，不是安全主体**：AI 的写文件和 Shell 操作都必须经过主进程的项目范围校验与用户确认。

最后更新：2026-07-30，适用源码版本：`4.0.2`。
