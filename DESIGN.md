# Design

## Source of truth

- Status: Active
- Last refreshed: 2026-07-20
- Primary product surfaces: project home, three-region desktop workspace, document viewers/editors, AI workspace, settings and status bar.
- Evidence reviewed: `README.md`, the original product brief, `src/App.tsx`, `src/styles/global.css`, `src/styles/shell.css`, `src/styles/ai.css`, shell and AI components, and Playwright light/dark screenshots.

## Brand

- Personality: calm, capable, local-first and editorial; CoScribe should feel like a dependable reading and writing partner.
- Trust signals: ordinary local files, explicit AI write previews, visible sources, reversible actions and precise error messages.
- Avoid: marketing-style gradients, oversized cards, playful decoration that competes with content, and hidden destructive behavior.

## Product goals

- Goals: keep reading, editing, project navigation and AI collaboration in one recoverable local workspace.
- Non-goals: cloud accounts, opaque proprietary storage, autonomous file deletion and mobile-first interaction.
- Success signals: users can keep the central document readable, widen AI for long responses when needed, and resume the prior layout without dead zones or surprising jumps.

## Personas and jobs

- Primary personas: students, researchers, technical readers and content workers managing local PDF and Markdown collections.
- User jobs: read source material, ask grounded questions, compare content, write notes and safely apply AI-assisted edits.
- Key contexts of use: long desktop sessions, wide monitors, split-document comparison and occasional compact laptop windows.

## Information architecture

- Primary navigation: activity rail, project navigator, central document workspace and right AI workspace.
- Core routes/screens: home/recent projects, project workspace and settings dialogs.
- Content hierarchy: the active document is primary; project navigation and AI are adjustable supporting regions.

## Design principles

- Content first: preserve a usable central editor while allowing the AI workspace to grow for code, tables and long-form answers.
- Local and explicit: show what will happen before files are changed and keep project data in standard files.
- Continuous control: resizing must respond immediately in both directions and restore the user's preferred width.
- Tradeoffs: on compact windows, supporting regions may overlay the editor rather than permanently shrinking it.

## Visual language

- Color: Obsidian-inspired neutral surfaces with restrained violet accents and equivalent light/dark contrast.
- Typography: system UI text for controls, readable document typography for content and monospace for paths/code.
- Spacing/layout rhythm: compact desktop density, 4-8px control rhythm and clear structural dividers.
- Shape/radius/elevation: small radii and subtle elevation only for transient surfaces.
- Motion: short functional transitions; no decorative motion.
- Imagery/iconography: Lucide line icons and the CoScribe book/spark application mark.

## Components

- Existing components to reuse: `ActivityRail`, `ProjectNavigator`, `EditorPane`, `AiWorkspace`, dialogs and status controls.
- New/changed components: shared panel-layout calculations and an accessible AI resize separator.
- Variants and states: inline desktop layout, compact overlay layout, dragging, keyboard adjustment and reset-to-default.
- Token/component ownership: shell geometry lives in `src/lib/panel-layout.ts`; visual presentation remains in `src/styles/shell.css` and `src/styles/ai.css`.

## Accessibility

- Target standard: WCAG 2.1 AA where practical for the desktop application.
- Keyboard/focus behavior: resize separators are focusable; arrow keys adjust, Home resets and End expands to the current maximum.
- Contrast/readability: retain theme token contrast and keep document/AI text line lengths usable.
- Screen-reader semantics: separators expose orientation and current/min/max values.
- Reduced motion and sensory considerations: resizing has no animated lag; theme and panels do not rely on color alone.

## Responsive behavior

- Supported breakpoints/devices: macOS/Windows/Linux desktop windows, minimum application width 1024px.
- Layout adaptations: at 1100px and above, AI is inline and dynamically capped so at least 420px remains for documents; below 1100px it overlays the document and is capped at 88vw and 800px.
- Panel ranges: project navigator 210-400px (default 260px); AI workspace 300-800px (default 360px).
- Touch/hover differences: resize targets retain a wider invisible hit area; keyboard behavior does not depend on hover.

## Interaction states

- Loading: keep the workspace hidden until the real project tree is available.
- Empty: distinguish a newly created empty project from opening an existing folder.
- Error: preserve readable files when optional metadata or Mermaid rendering fails.
- Success: reflect saved/synced state in the status bar.
- Disabled: explain unavailable AI actions without disabling local work.
- Offline/slow network: local reading and editing remain available; AI failures stay contained to the AI workspace.

## Content voice

- Tone: concise, calm and operational.
- Terminology: use CoScribe for the product; keep file names, code and model identifiers unchanged.
- Microcopy rules: state consequences before confirmation and avoid implying that AI has written a file before acceptance.

## Implementation constraints

- Framework/styling system: Electron, React, TypeScript and repository-local CSS variables; no new design-system dependency.
- Design-token constraints: extend existing semantic tokens instead of hard-coded theme-specific component colors.
- Performance constraints: resizing must remain synchronous and avoid layout-heavy observers in pointer-move loops.
- Compatibility constraints: preserve existing `.vibeknowledge` project metadata and legacy user settings/API credentials during the CoScribe rename.
- Test/screenshot expectations: unit-test layout calculations; E2E-test expansion beyond 560px, immediate reverse dragging, keyboard reset and light/dark critical surfaces.

## Open questions

- [ ] Decide whether a future major version should migrate the hidden `.vibeknowledge` metadata directory to `.coscribe`; compatibility currently takes priority.
- [ ] Define signed/notarized macOS distribution once an Apple Developer ID is available.
