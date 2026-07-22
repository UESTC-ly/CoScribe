import { describe, expect, it } from 'vitest'
import type { ChatMessage, FileReadResult, OpenTab, ProjectInfo } from '../../src/shared/types'
import { createAppStore, selectDirtyDocuments } from '../../src/store'

const project: ProjectInfo = {
  name: 'Study',
  path: '/study',
  openedAt: 10,
  exists: true
}

const tab = (id: string, path: string, kind: OpenTab['kind'] = 'markdown'): OpenTab => ({
  id,
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind
})

const documentResult = (overrides: Partial<FileReadResult> = {}): FileReadResult => ({
  path: '/study/notes.md',
  kind: 'markdown',
  content: 'saved',
  modifiedAt: 1,
  size: 5,
  ...overrides
})

const message = (id: string, content: string, createdAt: number): ChatMessage => ({
  id,
  role: 'user',
  content,
  createdAt
})

describe('renderer store tabs and panes', () => {
  it('deduplicates a file globally and focuses the pane where it is already open', () => {
    const store = createAppStore()
    store.getState().setProject(project)
    store.getState().openTab(tab('a', '/study/a.md'), 'primary')
    store.getState().openTab(tab('duplicate', '/study/a.md'), 'secondary')

    const { workspace } = store.getState()
    expect(workspace.tabs).toHaveLength(1)
    expect(workspace.panes.primary.tabIds).toEqual(['a'])
    expect(workspace.panes.secondary.tabIds).toEqual([])
    expect(workspace.activePane).toBe('primary')
  })

  it('moves, reorders, closes tabs, and keeps active focus deterministic', () => {
    const store = createAppStore()
    const actions = store.getState()
    actions.setProject(project)
    actions.openTab(tab('a', '/study/a.md'))
    actions.openTab(tab('b', '/study/b.md'))
    actions.openTab(tab('c', '/study/c.md'))
    actions.reorderTab('primary', 'a', 3)
    expect(store.getState().workspace.panes.primary.tabIds).toEqual(['b', 'c', 'a'])

    store.getState().moveTab('c', 'secondary')
    expect(store.getState().workspace).toMatchObject({ activePane: 'secondary', split: true })
    expect(store.getState().workspace.panes.secondary).toEqual({ tabIds: ['c'], activeTabId: 'c' })

    store.getState().closeTab('c')
    expect(store.getState().workspace.tabs.map(({ id }) => id)).toEqual(['a', 'b'])
    expect(store.getState().workspace.activePane).toBe('primary')
  })

  it('serializes a detached workspace and marks externally deleted tabs missing', () => {
    const store = createAppStore()
    store.getState().setProject(project)
    store.getState().openTab(tab('a', '/study/a.md'))
    store.getState().setFileTree([])
    expect(store.getState().workspace.tabs[0].missing).toBe(true)

    const persisted = store.getState().serializeWorkspace()
    persisted.tabs[0].name = 'mutated'
    expect(store.getState().workspace.tabs[0].name).toBe('a.md')
  })

  it('releases a clean closed document buffer but preserves unsaved content', () => {
    const store = createAppStore()
    store.getState().setProject(project)
    store.getState().openTab(tab('notes', '/study/notes.md'))
    store.getState().loadDocument(documentResult())
    store.getState().setDocumentContext('/study/notes.md', { documentText: 'large cached text' })
    store.getState().closeTab('notes')
    expect(store.getState().documents['/study/notes.md']).toBeUndefined()
    expect(store.getState().documentContexts['/study/notes.md']).toBeUndefined()

    store.getState().openTab(tab('dirty', '/study/notes.md'))
    store.getState().loadDocument(documentResult())
    store.getState().updateDocument('/study/notes.md', 'unsaved')
    store.getState().closeTab('dirty')
    expect(store.getState().documents['/study/notes.md']).toMatchObject({ content: 'unsaved', dirty: true })
  })
})

describe('renderer store documents and context', () => {
  it('tracks dirty content and exposes an external version instead of overwriting it', () => {
    const store = createAppStore()
    store.getState().loadDocument(documentResult())
    store.getState().updateDocument('/study/notes.md', 'local edit')
    store.getState().loadDocument(documentResult({ content: 'external edit', modifiedAt: 2, size: 13 }))

    const conflicted = store.getState().documents['/study/notes.md']
    expect(conflicted.content).toBe('local edit')
    expect(conflicted.externalVersion?.content).toBe('external edit')
    expect(selectDirtyDocuments(store.getState())).toHaveLength(1)

    store.getState().resolveDocumentConflict('/study/notes.md', 'keep')
    const kept = store.getState().documents['/study/notes.md']
    expect(kept.content).toBe('local edit')
    expect(kept.savedContent).toBe('external edit')
    expect(kept.dirty).toBe(true)
  })

  it('does not lose edits typed while an earlier save is in flight', () => {
    const store = createAppStore()
    store.getState().loadDocument(documentResult({ content: 'A', size: 1 }))
    store.getState().updateDocument('/study/notes.md', 'B')
    store.getState().updateDocument('/study/notes.md', 'C')
    store.getState().markDocumentSaved(documentResult({ content: 'B', modifiedAt: 2, size: 1 }))

    expect(store.getState().documents['/study/notes.md']).toMatchObject({
      content: 'C',
      savedContent: 'B',
      modifiedAt: 2,
      dirty: true
    })
  })

  it('captures the active pane context as a send-time snapshot', () => {
    const store = createAppStore()
    store.getState().setProject(project)
    store.getState().openTab(tab('pdf', '/study/book.pdf', 'pdf'), 'secondary')
    store.getState().updatePdfState('/study/book.pdf', { page: 17 })
    const pages = [16, 17]
    store.getState().setDocumentContext('/study/book.pdf', {
      selection: 'persist this',
      visibleText: 'visible page',
      visiblePages: pages
    }, 100)
    store.getState().setReferencedFiles(['/study/notes.md'])

    const snapshot = store.getState().captureActiveContext(undefined, 200)
    pages.push(18)
    store.getState().setDocumentContext('/study/book.pdf', { selection: 'changed' })

    expect(snapshot).toMatchObject({
      pane: 'secondary',
      documentName: 'book.pdf',
      pdfPage: 17,
      selection: 'persist this',
      scope: 'selection',
      capturedAt: 200
    })
    expect(snapshot?.visiblePages).toEqual([16, 17])
    expect(snapshot?.referencedFiles).toEqual(['/study/notes.md'])
    expect(store.getState().documentContexts['/study/book.pdf'].visiblePages).toEqual([16, 17])
  })
})

describe('renderer store session isolation', () => {
  it('updates only the named session and keeps context snapshots detached', () => {
    const store = createAppStore()
    store.getState().setProject(project)
    store.getState().createSession('LangGraph', 'a', 1)
    store.getState().createSession('FastAPI', 'b', 2)
    const sourcePages = [17]
    const first = message('m1', 'why?', 3)
    first.context = {
      projectName: 'Study',
      projectPath: '/study',
      pane: 'primary',
      visiblePages: sourcePages,
      scope: 'visible',
      referencedFiles: [],
      capturedAt: 3
    }
    store.getState().addMessage('a', first)
    sourcePages.push(18)

    expect(store.getState().sessions.find(({ id }) => id === 'a')?.messages).toHaveLength(1)
    expect(store.getState().sessions.find(({ id }) => id === 'b')?.messages).toEqual([])
    expect(store.getState().sessions.find(({ id }) => id === 'a')?.messages[0].context?.visiblePages).toEqual([17])

    store.getState().addMessage('b', message('m2', 'route?', 4))
    store.getState().deleteSession('b')
    expect(store.getState().workspace.currentSessionId).toBe('a')
    expect(store.getState().sessions[0].messages[0].content).toBe('why?')
  })

  it('keeps untouched session and message references stable during streamed updates', () => {
    const store = createAppStore()
    store.getState().setProject(project)
    store.getState().createSession('A', 'a', 1)
    store.getState().createSession('B', 'b', 2)
    store.getState().addMessage('a', message('a1', 'first', 3))
    store.getState().addMessage('a', message('a2', 'stream', 4))
    store.getState().addMessage('b', message('b1', 'unrelated', 5))
    const beforeA = store.getState().sessions.find(({ id }) => id === 'a')!
    const beforeB = store.getState().sessions.find(({ id }) => id === 'b')!
    const beforeFirstMessage = beforeA.messages[0]

    store.getState().updateMessage('a', 'a2', (current) => ({ ...current, content: `${current.content} delta` }), 6)

    const afterA = store.getState().sessions.find(({ id }) => id === 'a')!
    const afterB = store.getState().sessions.find(({ id }) => id === 'b')!
    expect(afterA).not.toBe(beforeA)
    expect(afterA.messages[0]).toBe(beforeFirstMessage)
    expect(afterB).toBe(beforeB)
    expect(afterA.messages[1].content).toBe('stream delta')
  })
})
