# 测试与发布

## 本地验证层级

| 改动类型 | 最低验证 |
| --- | --- |
| 文档或纯类型 | `npm run typecheck`、链接/路径检查 |
| 纯逻辑 | 相关 Vitest + `npm run typecheck` |
| Main、IPC、设置、文件、AI | 相关主进程/AI 测试 + `npm test` |
| Renderer 交互 | 相关组件测试 + Playwright 场景 |
| 打包、原生依赖、终端 | `npm run build`、对应 package verify、打包 smoke |

完整基线：

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

`npm run test:e2e` 会先构建，再运行 Playwright。不要单独运行 Playwright 后把旧 `out/` 产物的结果当作当前源码证据。

## E2E 约定

- Playwright 测试位于 `tests/e2e/`，Electron 应用通过 `_electron.launch` 启动。
- 每个场景使用临时项目目录和隔离 userData，不能污染真实设置。
- 没有 `COSCRIBE_ASR_TEST_WAV` 时，原生语音场景会跳过；跳过不能计为通过。
- 所有 UI、IPC、持久化、终端或安全边界改动都应增加确定性回归场景。
- IDE 补全至少覆盖本地候选显示、AI 流式建议、`Tab` 接受和新输入取消过时请求；真实 Provider 的延迟不可作为测试前提。

## 打包验证

```bash
npm run dist:dir
npm run verify:package:mac
```

跨平台发布分别使用：

```bash
npm run dist:mac:arm64
npm run dist:win:x64
npm run dist:linux:x64
```

打包验证检查应用结构、版本、架构、asar 内容、OCR/ASR 资源、运行时依赖和 `node-pty`。包后 smoke 通过 `COSCRIBE_E2E_EXECUTABLE` 启动真实安装包，覆盖启动、项目、IDE、代码文件、PTY 和 AI Shell 默认关闭等核心路径。

## GitHub Actions

常规 CI（`.github/workflows/ci.yml`）在 `main` push 和 PR 上运行：

```text
npm ci
npm run typecheck
npm test
npm run build
```

Release 工作流（`.github/workflows/release.yml`）由 `v*` tag 触发：

1. 校验 tag 与 `package.json.version` 一致。
2. 在 macOS arm64、Windows x64、Linux x64 原生 Runner 上构建。
3. 校验每个平台包内容和架构。
4. 对成品运行 package smoke。
5. 收集五个安装包，生成 `SHA256SUMS.txt`，创建或更新 GitHub Release。

构建子任务使用 `--publish never`。只有所有平台通过后，最终发布 job 才上传 Release。

## 发布清单

1. 确认版本、README 下载块、release tag 和变更记录一致。
2. `git status --short` 只包含预期文件；排除 `/learn/`、`release/`、本地 `CLAUDE.md`、密钥和用户数据。
3. 在本地完成与改动匹配的验证。
4. 提交并推送发布分支，创建 PR。
5. 合并后创建 `vX.Y.Z` tag 并推送 tag。
6. 观察 GitHub Actions 三个平台结果，确认五个制品和 checksum。
7. 记录未覆盖的真实 Provider、签名、公证或硬件风险。

当前项目尚未配置 macOS 公证、Windows Authenticode、Linux 发行版签名或应用内自动更新。发布负责人必须在 Release 页面和文档中如实说明这一点。
