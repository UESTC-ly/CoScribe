import { useCallback, useEffect, useId, useRef, type RefObject } from 'react'

const HIGHLIGHT_NAME = 'coscribe-ai-context-selection'
const activeRanges = new Map<string, Range>()

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void
  delete: (name: string) => void
}

interface HighlightConstructor {
  new (...ranges: Range[]): unknown
}

function highlightApi(): { registry: HighlightRegistry; Highlight: HighlightConstructor } | null {
  const registry = (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights
  const Highlight = (globalThis as unknown as { Highlight?: HighlightConstructor }).Highlight
  return registry && Highlight ? { registry, Highlight } : null
}

function refreshHighlight(): void {
  const api = highlightApi()
  if (!api) return
  if (activeRanges.size === 0) {
    api.registry.delete(HIGHLIGHT_NAME)
    return
  }
  api.registry.set(HIGHLIGHT_NAME, new api.Highlight(...activeRanges.values()))
}

function textRange(root: HTMLElement, query: string): Range | null {
  if (!query) return null
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let joined = ''
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    nodes.push(text)
    joined += text.data
  }
  const start = joined.indexOf(query)
  if (start < 0) return null
  const end = start + query.length
  let cursor = 0
  let startNode: Text | null = null
  let endNode: Text | null = null
  let startOffset = 0
  let endOffset = 0
  for (const node of nodes) {
    const next = cursor + node.data.length
    if (!startNode && start >= cursor && start <= next) {
      startNode = node
      startOffset = Math.min(node.data.length, start - cursor)
    }
    if (end >= cursor && end <= next) {
      endNode = node
      endOffset = Math.min(node.data.length, end - cursor)
      break
    }
    cursor = next
  }
  if (!startNode || !endNode) return null
  const range = document.createRange()
  range.setStart(startNode, startOffset)
  range.setEnd(endNode, endOffset)
  return range
}

interface PersistentDomSelectionOptions {
  rootRef: RefObject<HTMLElement | null>
  selectionText?: string
  revealToken?: number
  clearToken?: number
  contentKey?: unknown
}

export function usePersistentDomSelection({
  rootRef,
  selectionText,
  revealToken = 0,
  clearToken = 0,
  contentKey,
}: PersistentDomSelectionOptions): { captureSelection: () => string; clearSelection: () => void } {
  const ownerId = useId()
  const rangeRef = useRef<Range | null>(null)
  const textRef = useRef('')
  const revealTimeoutRef = useRef<number | null>(null)

  const removeRange = useCallback(() => {
    rangeRef.current = null
    textRef.current = ''
    activeRanges.delete(ownerId)
    const root = rootRef.current
    root?.removeAttribute('data-ai-context-selection')
    root?.classList.remove('is-revealing-ai-selection')
    if (revealTimeoutRef.current !== null) {
      window.clearTimeout(revealTimeoutRef.current)
      revealTimeoutRef.current = null
    }
    refreshHighlight()
  }, [ownerId, rootRef])

  const installRange = useCallback((range: Range, text: string) => {
    const root = rootRef.current
    if (!root || !root.contains(range.startContainer) || !root.contains(range.endContainer)) return
    const cloned = range.cloneRange()
    rangeRef.current = cloned
    textRef.current = text
    activeRanges.set(ownerId, cloned)
    root.dataset.aiContextSelection = 'true'
    refreshHighlight()
  }, [ownerId, rootRef])

  const captureSelection = useCallback((): string => {
    const root = rootRef.current
    const selection = window.getSelection()
    if (!root || !selection || selection.rangeCount === 0) {
      removeRange()
      return ''
    }
    const range = selection.getRangeAt(0)
    const text = selection.toString().trim()
    if (!text || !root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      removeRange()
      return ''
    }
    installRange(range, text)
    return text
  }, [installRange, removeRange, rootRef])

  useEffect(() => {
    const root = rootRef.current
    const text = selectionText?.trim()
    if (!root || !text) return
    const current = rangeRef.current
    if (
      current &&
      textRef.current === text &&
      root.contains(current.startContainer) &&
      root.contains(current.endContainer)
    ) {
      installRange(current, text)
      return
    }
    const restored = textRange(root, text)
    if (restored) installRange(restored, text)
  }, [contentKey, installRange, rootRef, selectionText])

  useEffect(() => {
    if (clearToken <= 0) return
    removeRange()
  }, [clearToken, removeRange])

  useEffect(() => {
    if (revealToken <= 0) return
    const root = rootRef.current
    const text = selectionText?.trim()
    if (!root || !text) return
    const current = rangeRef.current
    const range = current && root.contains(current.startContainer)
      ? current
      : textRange(root, text)
    if (!range) return
    installRange(range, text)
    const target = range.startContainer instanceof HTMLElement
      ? range.startContainer
      : range.startContainer.parentElement
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    root.classList.add('is-revealing-ai-selection')
    if (revealTimeoutRef.current !== null) window.clearTimeout(revealTimeoutRef.current)
    revealTimeoutRef.current = window.setTimeout(() => {
      root.classList.remove('is-revealing-ai-selection')
      revealTimeoutRef.current = null
    }, 1_100)
  }, [installRange, revealToken, rootRef, selectionText])

  useEffect(() => removeRange, [removeRange])

  return { captureSelection, clearSelection: removeRange }
}
