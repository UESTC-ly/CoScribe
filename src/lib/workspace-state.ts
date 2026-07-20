import {
  DEFAULT_WORKSPACE_STATE,
  type MarkdownReadingState,
  type OpenTab,
  type PaneId,
  type PaneState,
  type PdfReadingState,
  type WorkspaceState
} from '../shared/types'
import { normalizePortablePath, samePortablePath } from './path-utils'
import { PANEL_LAYOUT } from './panel-layout'

const PANE_IDS: PaneId[] = ['primary', 'secondary']
const TAB_KINDS = new Set(['markdown', 'pdf', 'image', 'text', 'unsupported'])
const NAV_SECTIONS = new Set(['files', 'sessions', 'search', 'annotations'])

export interface WorkspaceRestoreOptions {
  /** If supplied, tabs not present in this list are retained and marked missing. */
  existingPaths?: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finite(value: unknown, fallback: number, minimum?: number, maximum?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(minimum ?? value, Math.min(maximum ?? value, value))
}

function clonePane(pane: PaneState): PaneState {
  return { tabIds: [...pane.tabIds], activeTabId: pane.activeTabId }
}

export function cloneWorkspaceState(state: WorkspaceState): WorkspaceState {
  return {
    ...state,
    tabs: state.tabs.map((tab) => ({ ...tab })),
    panes: {
      primary: clonePane(state.panes.primary),
      secondary: clonePane(state.panes.secondary)
    },
    pdf: Object.fromEntries(Object.entries(state.pdf).map(([path, value]) => [path, { ...value }])),
    markdown: Object.fromEntries(
      Object.entries(state.markdown).map(([path, value]) => [path, { ...value }])
    )
  }
}

export function createDefaultWorkspaceState(): WorkspaceState {
  return cloneWorkspaceState(DEFAULT_WORKSPACE_STATE)
}

function parseTabs(value: unknown, options: WorkspaceRestoreOptions): {
  tabs: OpenTab[]
  idRemap: Map<string, string>
} {
  if (!Array.isArray(value)) return { tabs: [], idRemap: new Map() }
  const tabs: OpenTab[] = []
  const idRemap = new Map<string, string>()
  const ids = new Set<string>()

  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    if (
      typeof candidate.id !== 'string' ||
      !candidate.id ||
      typeof candidate.path !== 'string' ||
      !candidate.path ||
      typeof candidate.name !== 'string' ||
      !TAB_KINDS.has(String(candidate.kind))
    ) {
      continue
    }

    const existing = tabs.find((tab) => samePortablePath(tab.path, candidate.path as string))
    if (existing) {
      idRemap.set(candidate.id, existing.id)
      continue
    }
    if (ids.has(candidate.id)) continue

    const exists = options.existingPaths
      ? options.existingPaths.some((path) => samePortablePath(path, candidate.path as string))
      : candidate.missing !== true
    const tab: OpenTab = {
      id: candidate.id,
      path: normalizePortablePath(candidate.path),
      name: candidate.name,
      kind: candidate.kind as OpenTab['kind'],
      missing: options.existingPaths ? (!exists || undefined) : (candidate.missing === true || undefined)
    }
    tabs.push(tab)
    ids.add(tab.id)
    idRemap.set(tab.id, tab.id)
  }
  return { tabs, idRemap }
}

function parsePane(
  value: unknown,
  validTabIds: Set<string>,
  idRemap: Map<string, string>,
  alreadyPlaced: Set<string>
): PaneState {
  const candidate = isRecord(value) ? value : {}
  const requestedIds = Array.isArray(candidate.tabIds) ? candidate.tabIds : []
  const tabIds: string[] = []
  for (const rawId of requestedIds) {
    if (typeof rawId !== 'string') continue
    const id = idRemap.get(rawId) ?? rawId
    if (!validTabIds.has(id) || alreadyPlaced.has(id) || tabIds.includes(id)) continue
    tabIds.push(id)
    alreadyPlaced.add(id)
  }
  const requestedActive = typeof candidate.activeTabId === 'string'
    ? idRemap.get(candidate.activeTabId) ?? candidate.activeTabId
    : null
  return {
    tabIds,
    activeTabId: requestedActive && tabIds.includes(requestedActive)
      ? requestedActive
      : tabIds[0] ?? null
  }
}

function parsePdfStates(value: unknown): Record<string, PdfReadingState> {
  if (!isRecord(value)) return {}
  const result: Record<string, PdfReadingState> = {}
  for (const [path, candidate] of Object.entries(value)) {
    if (!path || !isRecord(candidate)) continue
    const fit = candidate.fit === 'width' || candidate.fit === 'page' || candidate.fit === 'custom'
      ? candidate.fit
      : 'width'
    result[normalizePortablePath(path)] = {
      page: Math.round(finite(candidate.page, 1, 1)),
      scale: finite(candidate.scale, 1, 0.1, 8),
      fit,
      scrollTop: finite(candidate.scrollTop, 0, 0)
    }
  }
  return result
}

function parseMarkdownStates(value: unknown): Record<string, MarkdownReadingState> {
  if (!isRecord(value)) return {}
  const result: Record<string, MarkdownReadingState> = {}
  for (const [path, candidate] of Object.entries(value)) {
    if (!path || !isRecord(candidate)) continue
    const mode = candidate.mode === 'edit' || candidate.mode === 'preview' || candidate.mode === 'both'
      ? candidate.mode
      : 'both'
    result[normalizePortablePath(path)] = {
      scrollTop: finite(candidate.scrollTop, 0, 0),
      cursor: Math.round(finite(candidate.cursor, 0, 0)),
      mode
    }
  }
  return result
}

/** Parse untrusted persisted state while preserving recoverable missing tabs. */
export function restoreWorkspaceState(
  persisted: unknown,
  options: WorkspaceRestoreOptions = {}
): WorkspaceState {
  let value = persisted
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return createDefaultWorkspaceState()
    }
  }
  if (!isRecord(value)) return createDefaultWorkspaceState()

  const { tabs, idRemap } = parseTabs(value.tabs, options)
  const validTabIds = new Set(tabs.map((tab) => tab.id))
  const placed = new Set<string>()
  const rawPanes = isRecord(value.panes) ? value.panes : {}
  const primary = parsePane(rawPanes.primary, validTabIds, idRemap, placed)
  const secondary = parsePane(rawPanes.secondary, validTabIds, idRemap, placed)
  for (const tab of tabs) {
    if (!placed.has(tab.id)) primary.tabIds.push(tab.id)
  }
  if (!primary.activeTabId) primary.activeTabId = primary.tabIds[0] ?? null

  const split = value.split === true
  const requestedActivePane = value.activePane === 'secondary' ? 'secondary' : 'primary'
  const activePane: PaneId = !split && requestedActivePane === 'secondary' ? 'primary' : requestedActivePane
  const navSection = typeof value.navSection === 'string' && NAV_SECTIONS.has(value.navSection)
    ? (value.navSection as WorkspaceState['navSection'])
    : DEFAULT_WORKSPACE_STATE.navSection

  return {
    version: 1,
    tabs,
    panes: { primary, secondary },
    activePane,
    split,
    pdf: parsePdfStates(value.pdf),
    markdown: parseMarkdownStates(value.markdown),
    navSection,
    aiVisible: value.aiVisible !== false,
    leftWidth: finite(
      value.leftWidth,
      DEFAULT_WORKSPACE_STATE.leftWidth,
      PANEL_LAYOUT.projectNavigatorMinWidth,
      PANEL_LAYOUT.projectNavigatorMaxWidth
    ),
    aiWidth: finite(value.aiWidth, DEFAULT_WORKSPACE_STATE.aiWidth, PANEL_LAYOUT.aiMinWidth, PANEL_LAYOUT.aiMaxWidth),
    currentSessionId: typeof value.currentSessionId === 'string' ? value.currentSessionId : null
  }
}

/** Produce a detached, schema-clean object suitable for `project.saveState`. */
export function serializeWorkspaceState(state: WorkspaceState): WorkspaceState {
  return restoreWorkspaceState(cloneWorkspaceState(state))
}

export function stringifyWorkspaceState(state: WorkspaceState): string {
  return JSON.stringify(serializeWorkspaceState(state))
}

export function markMissingWorkspaceTabs(
  state: WorkspaceState,
  existingPaths: readonly string[]
): WorkspaceState {
  const next = cloneWorkspaceState(state)
  next.tabs = next.tabs.map((tab) => ({
    ...tab,
    missing: !existingPaths.some((path) => samePortablePath(path, tab.path)) || undefined
  }))
  return next
}

export function findPaneForTab(state: WorkspaceState, tabId: string): PaneId | null {
  return PANE_IDS.find((pane) => state.panes[pane].tabIds.includes(tabId)) ?? null
}

export const deserializeWorkspaceState = restoreWorkspaceState
