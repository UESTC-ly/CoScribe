# 开发指南

## 前置条件

- Node.js `20.19+` 或 `22.12+`
- npm（使用仓库锁定的 `package-lock.json`）
- macOS、Windows 或 Linux 桌面环境
- Playwright 桌面 E2E 首次运行需要 Chromium

```bash
npm install
npm run dev
```

`npm install` 会执行 `scripts/ensure-node-pty-helper.mjs`，确保 `node-pty` 的辅助程序具备运行权限。不要跳过该脚本后把终端故障误判为应用逻辑问题。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | Electron + electron-vite 热重载开发 |
| `npm run typecheck` | Renderer 与 Node/Electron TypeScript 检查 |
| `npm test` | 单元、主进程和 AI Vitest 套件 |
| `npm run test:e2e` | 构建后运行 Playwright 桌面场景 |
| `npm run build` | 类型检查并输出生产 bundle |
| `npm run dist:dir` | 生成当前平台的未封装应用目录 |
| `npm run dist:mac:arm64` | 打 macOS Apple Silicon 包 |
| `npm run dist:win:x64` | 打 Windows x64 包 |
| `npm run dist:linux:x64` | 打 Linux x64 包 |
| `npm run verify:package:mac` | 校验 macOS 包结构、依赖和原生 PTY |
| `npm run fetch:asr-model` | 下载语音打包所需模型 |

首次 E2E：

```bash
npx playwright install chromium
npm run test:e2e
```

Linux 缺少浏览器系统依赖时使用：

```bash
npx playwright install --with-deps chromium
```

## 代码组织

```text
src/
  components/      React UI；IDE 位于 components/ide/
  lib/             上下文、聊天、文件操作和 OCR 等逻辑
  plugins/         内置工作区和插件注册
  shared/          跨进程类型与 API 契约
  store/           Renderer 应用状态
electron/
  main/            高权限服务和 IPC handlers
  preload/         最小 contextBridge API
tests/
  unit/            纯逻辑和 Renderer 组件测试
  e2e/             Playwright 桌面场景
resources/         内置指南、OCR 和许可证
scripts/           打包和验证脚本
```

## 修改路径

### 新 UI 能力

1. 在 `src/components/` 增加或修改界面。
2. 复用 `src/styles/` 的语义变量，兼顾明暗主题与桌面最小宽度。
3. 需要跨进程能力时，先修改共享类型和主进程，再通过 preload 暴露最小 API。
4. 为键盘、空态、错误态和禁用态补充测试。

### 新主进程能力

1. 在 `src/shared/types.ts` 定义严格请求、响应和事件类型。
2. 在 `electron/ipc-channels.ts` 定义命名通道。
3. 在 `electron/main/` 实现服务和 sender/path/输入校验。
4. 在 `electron/main/ipc.ts` 只注册受信任 sender 的 handler。
5. 在 `electron/preload/index.ts` 公开窄 API，不公开 `ipcRenderer`。
6. 增加相应的主进程和 E2E 回归测试。

### 文件与 AI 改动

不能让 Renderer 或模型直接写盘。AI 写操作必须保持“提议、差异预览、确认、主进程重新校验、原子写入”的既有链路。参考 `electron/main/project.ts` 和相关测试。

## 代码约定

- TypeScript ESM、严格类型、两空格缩进、单引号、无分号。
- React 组件和文件使用 `PascalCase`；函数和变量使用 `camelCase`。
- 不新增依赖，除非该依赖解决了无法由现有工具完成的明确问题。
- 不混入无关重构；安全或持久化改动需先补回归保护。
- 不提交密钥、用户数据、`release/`、`/learn/` 或本地 `CLAUDE.md`。

## 本地调试

- 通过 `npm run dev` 调试 Renderer 与主进程。
- IPC 失败优先检查 preload 是否暴露、通道名是否一致、main 是否校验 sender。
- 终端问题先检查当前平台 `node-pty` 预构建文件和 `spawn-helper` 可执行位。
- 打包问题优先运行对应 `verify:package:*`；它会检查 asar、运行时依赖和平台资源。
