# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

CoScribe (package name `coscribe`) is a local-first Electron + React + TypeScript desktop app for reading local documents (Markdown, PDF, DOCX, PPTX, images, text, webpages), running AI-assisted research against explicitly chosen context, and saving results as standard Markdown. An ordinary folder is the project — there is no proprietary database. Requires Node.js 20.19+ or 22.12+.

The primary UI language and all user-facing strings are Chinese. Match that when editing user-facing text and error messages.

## Commands

- `npm run dev` — start Electron via electron-vite with live reload.
- `npm run typecheck` — type-check both TS projects (`tsc --noEmit` for renderer + `tsconfig.node.json` for main/preload). Runs as part of `build`.
- `npm run build` — typecheck then produce bundles under `out/`.
- `npm test` — runs all three Vitest suites in sequence: `test:unit`, `test:electron`, `test:ai`.
- `npm run test:unit` — renderer/lib unit + component tests (jsdom), `tests/**/*.test.{ts,tsx}`.
- `npm run test:electron` — main-process tests (node env), `electron/**/*.test.ts`.
- `npm run test:ai` — AI component tests, `src/components/ai/*.test.tsx`.
- `npm run test:watch` — Vitest in watch mode (defaults to unit tests).
- `npm run test:e2e` — builds then runs Playwright desktop scenarios (`tests/e2e/`).
- `npm run dist:mac:arm64` / `dist:win:x64` / `dist:linux:x64` — package with electron-builder.
- `npm run fetch:asr-model` — download the sherpa-onnx ASR model (required before mac packaging with speech).
- `npm run verify:package:mac` / `verify:package:win` / `verify:package:linux` — smoke-test the packaged app.

**Run a single test file:**
- Renderer/lib: `npx vitest run tests/unit/panel-layout.test.ts`
- Main process: `npx vitest run electron/main/security.test.ts --config electron/vitest.config.ts`
- AI components: `npx vitest run src/components/ai/streaming.test.tsx --config src/components/ai/vitest.ai.config.ts`
- Filter by name: add `-t "<pattern>"` to any vitest command.

There is no ESLint/Prettier config. Match neighboring code: two-space indent, single quotes, no semicolons, strict types. Verify with `npm run typecheck`.

## Architecture

Three Electron process boundaries with a strict, typed IPC contract between them. Security posture is central: renderer runs sandboxed with `contextIsolation: true`, `nodeIntegration: false`.

**The IPC contract is the spine.** Adding or changing any cross-process call touches four files that must stay in sync:
1. `electron/ipc-channels.ts` — the single `IPC` channel-name registry (source of truth for channel strings).
2. `src/shared/types.ts` — shared request/response types and the `CoScribeAPI` interface (the whole `window.coscribe` surface).
3. `electron/preload/index.ts` — implements `CoScribeAPI` by wiring each method to `ipcRenderer.invoke`/`.send`/`.on`; exposes it via `contextBridge.exposeInMainWorld('coscribe', ...)`.
4. `electron/main/ipc.ts` — `registerIpc(services)` registers `ipcMain` handlers. **Every handler validates the sender via `assertTrustedSender`** (rejects non-main-frame / untrusted-origin requests).

**Main process (`electron/main/`)** is service-oriented. `index.ts` constructs all services once and injects dependencies between them (e.g. `KnowledgeIndexService` depends on `ProjectService` + `PdfTextService`; `AiService` takes settings/project/pdf/search), then hands the bundle to `registerIpc`. Key services:
- `project` — filesystem + workspace state + operation history
- `ai` — streaming, multi-provider OpenAI-compatible/Anthropic
- `knowledge` — search index
- `search` — project-wide text search
- `browser` — research WebContentsView
- `speech` — local ASR (macOS only)
- `screenshot` — cross-platform region capture
- Plugin-backing services: `mcp`, `git-snapshot`, `web-tracker`, `references`, `calendar`, `diagnostics`

**Filesystem safety lives in `electron/main/security.ts`.** `ProjectPathGuard` enforces project-root containment, rejects symlink segments, and blocks the `.vibeknowledge` metadata directory. All file operations resolve through the guard. Do not bypass it or construct raw paths in handlers.

**Project metadata** is stored in a hidden `.coscribe` directory inside each project (constant `METADATA_DIRECTORY` in `project.ts`). This name is intentionally kept as `.vibeknowledge` for backward compatibility — do not rename it. The Electron `userData` path is likewise pinned to `appData/vibeknowledge` to preserve recent projects, settings, and encrypted API credentials. API keys are stored via Electron `safeStorage`, never in project files.

**Note on migration:** When opening legacy projects, compatible data from the root `COSCRIBE.md` and `.vibeknowledge/` is copied into `.coscribe/`, while the original files remain untouched. New `.coscribe/` is the canonical location; the backward-compatibility reference to `.vibeknowledge` above refers to the internal constant name, not the actual directory structure.

**Renderer (`src/`)** is organized by surface, not file type:
- `src/App.tsx` — top-level shell composition (large; the three-region layout).
- `src/store/app-store.ts` — Zustand store; document buffers, tabs/panes, workspace state, settings, context selection.
- `src/lib/` — pure logic, heavily unit-tested: `panel-layout.ts` (shell geometry), `context.ts`/`context-window.ts` (AI context selection/windowing), `workspace-state.ts` (layout persistence/restore), `chat-session.ts`, `file-operations.ts`, `path-utils.ts`.
- `src/components/shell/` — rail, navigator, editor pane, dialogs, tab strip.
- `src/components/ai/` — AI workspace, streaming markdown, operation cards.
- `src/components/viewers/` — per-format viewers (PDF, DOCX, PPTX, Markdown, image, OCR, Mermaid).
- `src/plugins/` — built-in plugins only. `registry.ts` (`TRUSTED_PLUGIN_REGISTRY`) is a deliberate allow-list with a permission vocabulary; there is no runtime evaluation of downloaded JS. Each plugin declares `permissions`; the main process gates plugin-backed IPC on granted permissions (see `trustedPlugin` usage in `ipc.ts`). Many plugins have a matching main-process service.

**AI file edits are always preview-then-accept.** The AI proposes a `FileOperationProposal`; nothing is written until the user accepts. Operation history supports undo (`project:operation-history` / `project:undo-operation`). Preserve this contract — never imply a file was written before acceptance.

## Testing notes

Vitest files are `*.test.ts`/`*.test.tsx`; Playwright scenarios are `*.spec.ts`. Coverage is configured (no numeric threshold) for `src/lib/**` and `electron/main/security.ts` — prioritize regression tests for lib logic and security-sensitive main-process paths. Run `test:e2e` for changes touching UI, IPC, persistence, or packaging.

## Reference docs

- `AGENTS.md` — repository guidelines (structure, style, commit/PR conventions).
- `DESIGN.md` — design system, visual language, layout constraints, accessibility targets.
- `README.md` — user-facing install/usage (bilingual).

## Commit conventions

History uses intent-first subjects (e.g. "Keep working context trustworthy") followed by rationale and Git trailers such as `Constraint:`, `Rejected:`, `Confidence:`, `Scope-risk:`, `Tested:`, `Not-tested:`. Call out IPC, filesystem, credential, or packaging impacts in PR descriptions.
