# Repository Guidelines

## Project Structure & Module Organization

CoScribe is an Electron, React, and TypeScript desktop application. Renderer code lives in `src/`, with UI in `components/`, helpers in `lib/`, workspaces in `plugins/`, state in `store/`, and cross-process contracts in `shared/`. Privileged code belongs in `electron/main/`; expose narrow APIs through `electron/preload/`. Tests live in `tests/unit/`, `tests/e2e/`, and beside Electron and AI code. Packaging inputs and utilities are in `resources/`, `assets/`, and `scripts/`.

## Build, Test, and Development Commands

Use Node.js 20.19+ or 22.12+ and install the locked dependency set with `npm install`.

- `npm run dev` starts Electron through electron-vite with live reload.
- `npm run typecheck` checks both renderer and Node/Electron TypeScript projects.
- `npm test` runs the unit, Electron-main, and AI-component Vitest suites.
- `npm run test:e2e` builds the app, then runs Playwright desktop scenarios.
- `npm run build` type-checks and produces the application bundles.
- `npm run fetch:asr-model` downloads the model required for speech-enabled packaging.

## Coding Style & Naming Conventions

Follow the existing ESM TypeScript style: two-space indentation, single quotes, no semicolons, and strict types. Use `PascalCase` for React components and files, `camelCase` for functions and variables, and kebab-case for plugin directories. Keep shared IPC types in `src/shared/` and channels in `electron/ipc-channels.ts`. No standalone formatter or linter is configured; match neighboring code and run `npm run typecheck`.

## Testing Guidelines

Name Vitest files `*.test.ts` or `*.test.tsx`; name Playwright scenarios `*.spec.ts`. Add regression coverage for changed behavior and exercise security-sensitive paths in Electron-main tests. Run focused tests while iterating, then `npm test`; run `npm run test:e2e` for UI, IPC, persistence, or packaging-facing changes. Coverage is configured for core libraries and `electron/main/security.ts`, without a numeric threshold.

## Commit & Pull Request Guidelines

History uses intent-first subjects such as “Keep working context trustworthy,” followed by rationale and Git trailers. Include relevant `Constraint:`, `Rejected:`, `Confidence:`, `Scope-risk:`, `Tested:`, and `Not-tested:` entries. Pull requests should describe behavior, risk, verification, and linked issues. Include screenshots for visual changes and call out IPC, filesystem, credential, or packaging impacts.

## Security & Configuration

Keep Node integration disabled in the renderer. Preserve sandboxing, context isolation, sender validation, narrow IPC whitelists, project-root and symlink guards, and atomic confirmed writes. Never commit API keys; they belong in Electron `safeStorage`, outside project files.
