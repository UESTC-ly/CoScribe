import type { ContextScope, ContextSnapshot, FileKind, PaneId } from '../shared/types'

export type ResolvedContextSource =
  | 'selection'
  | 'visible'
  | 'section'
  | 'document'
  | 'project'
  | 'general'

export interface ContextPriorityInput {
  selection?: string
  visibleText?: string
  sectionText?: string
  documentText?: string
  projectText?: string
}

export interface ResolvedContext {
  scope: ContextScope
  source: ResolvedContextSource
  text?: string
  usedFallback: boolean
}

export interface ContextSnapshotDraft extends ContextPriorityInput {
  projectName: string
  projectPath: string
  pane: PaneId
  documentPath?: string
  documentName?: string
  kind?: FileKind
  pdfPage?: number
  visiblePages?: number[]
  markdownHeading?: string
  referencedFiles?: string[]
  capturedAt?: number
}

function useful(value: string | undefined): value is string {
  return Boolean(value?.trim())
}

function resolved(
  scope: ContextScope,
  source: ResolvedContextSource,
  text: string | undefined,
  usedFallback: boolean
): ResolvedContext {
  return { scope, source, text: useful(text) ? text : undefined, usedFallback }
}

function autoPriority(input: ContextPriorityInput): ResolvedContext {
  if (useful(input.selection)) return resolved('selection', 'selection', input.selection, false)
  if (useful(input.visibleText)) return resolved('visible', 'visible', input.visibleText, false)
  if (useful(input.sectionText)) return resolved('visible', 'section', input.sectionText, true)
  if (useful(input.documentText)) return resolved('document', 'document', input.documentText, true)
  return resolved('general', 'general', undefined, true)
}

/**
 * Resolves the actual payload sent to AI. `visible` is the normal automatic
 * mode, so a live text selection still wins. Explicit document/project/general
 * choices are respected and never trigger an implicit project-wide search.
 */
export function resolveContextPriority(
  input: ContextPriorityInput,
  requestedScope: ContextScope = 'visible'
): ResolvedContext {
  if (requestedScope === 'general') return resolved('general', 'general', undefined, false)

  if (requestedScope === 'project') {
    if (useful(input.projectText)) return resolved('project', 'project', input.projectText, false)
    return resolved('project', 'project', undefined, true)
  }

  if (requestedScope === 'document') {
    if (useful(input.documentText)) return resolved('document', 'document', input.documentText, false)
    const fallback = autoPriority(input)
    return { ...fallback, usedFallback: true }
  }

  if (requestedScope === 'selection') {
    if (useful(input.selection)) return resolved('selection', 'selection', input.selection, false)
    const fallback = autoPriority({ ...input, selection: undefined })
    return { ...fallback, usedFallback: true }
  }

  return autoPriority(input)
}

/** Create an immutable-by-value record of the exact document state at send time. */
export function captureContextSnapshot(
  draft: ContextSnapshotDraft,
  requestedScope: ContextScope = 'visible'
): ContextSnapshot {
  const actual = resolveContextPriority(draft, requestedScope)
  return {
    projectName: `${draft.projectName}`,
    projectPath: `${draft.projectPath}`,
    pane: draft.pane,
    documentPath: draft.documentPath === undefined ? undefined : `${draft.documentPath}`,
    documentName: draft.documentName === undefined ? undefined : `${draft.documentName}`,
    kind: draft.kind,
    pdfPage: draft.pdfPage,
    visiblePages: draft.visiblePages ? [...draft.visiblePages] : undefined,
    markdownHeading: draft.markdownHeading === undefined ? undefined : `${draft.markdownHeading}`,
    selection: draft.selection === undefined ? undefined : `${draft.selection}`,
    visibleText: draft.visibleText === undefined ? undefined : `${draft.visibleText}`,
    sectionText: draft.sectionText === undefined ? undefined : `${draft.sectionText}`,
    documentText: draft.documentText === undefined ? undefined : `${draft.documentText}`,
    scope: actual.scope,
    referencedFiles: [...(draft.referencedFiles ?? [])],
    capturedAt: draft.capturedAt ?? Date.now()
  }
}

export function cloneContextSnapshot(snapshot: ContextSnapshot): ContextSnapshot {
  return {
    ...snapshot,
    visiblePages: snapshot.visiblePages ? [...snapshot.visiblePages] : undefined,
    referencedFiles: [...snapshot.referencedFiles]
  }
}

export const snapshotContextAtSend = captureContextSnapshot
export const deepCloneContextSnapshot = cloneContextSnapshot
