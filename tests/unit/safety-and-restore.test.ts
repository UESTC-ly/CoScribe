import { describe, expect, it } from 'vitest'
import type { FileNode, FileOperationProposal, SourceRef, WorkspaceState } from '../../src/shared/types'
import {
  buildFileOperationPreview,
  restoreWorkspaceState,
  serializeWorkspaceState,
  validateFileOperation,
  validateSources
} from '../../src/lib'

const pendingOperation = (overrides: Partial<FileOperationProposal> = {}): FileOperationProposal => ({
  id: 'op-1',
  kind: 'create',
  targetPath: 'notes/topic.md',
  proposedContent: '# Topic',
  summary: 'Create notes',
  status: 'pending',
  ...overrides
})

describe('AI file operation safety', () => {
  it('allows only Markdown targets inside the current project', () => {
    expect(validateFileOperation(pendingOperation(), '/study').safe).toBe(true)
    expect(validateFileOperation(
      pendingOperation({ targetPath: '../outside.md' }),
      '/study'
    )).toMatchObject({ safe: false, code: 'outside-project' })
    expect(validateFileOperation(
      pendingOperation({ targetPath: '/study/image.png' }),
      '/study'
    )).toMatchObject({ safe: false, code: 'unsupported-extension' })
  })

  it('blocks create-overwrite and missing edit targets when the tree is known', () => {
    expect(validateFileOperation(pendingOperation(), '/study', ['/study/notes/topic.md'])).toMatchObject({
      safe: false,
      code: 'already-exists'
    })
    expect(validateFileOperation(
      pendingOperation({ kind: 'replace', targetPath: 'missing.md' }),
      '/study',
      ['/study/existing.md']
    )).toMatchObject({ safe: false, code: 'missing-target' })
  })

  it('builds a plain-text, confirmation-required preview without applying anything', () => {
    const preview = buildFileOperationPreview(pendingOperation({
      kind: 'append',
      targetPath: '/study/notes.md',
      originalContent: 'old',
      proposedContent: 'new',
      expectedModifiedAt: 10
    }), '/study', ['/study/notes.md'])

    expect(preview).toMatchObject({
      safe: true,
      targetLabel: 'notes.md',
      requiresConfirmation: true,
      beforeContent: 'old',
      afterContent: 'old\nnew',
      contentFormat: 'plain-text'
    })
  })
})

describe('source validation', () => {
  const tree: FileNode[] = [
    {
      name: 'book.pdf',
      path: '/study/book.pdf',
      kind: 'pdf',
      size: 20,
      modifiedAt: 1
    },
    {
      name: 'notes.md',
      path: '/study/notes.md',
      kind: 'markdown',
      size: 20,
      modifiedAt: 1
    }
  ]

  it('keeps evidence tied to real files and rejects fabricated pages or excerpts', () => {
    const sources: SourceRef[] = [
      { path: 'book.pdf', label: 'fake label', kind: 'pdf', page: 2, excerpt: 'persistence' },
      { path: 'book.pdf', label: 'book.pdf', kind: 'pdf', page: 99 },
      { path: 'notes.md', label: 'notes.md', kind: 'markdown', heading: 'Checkpointer', excerpt: 'checkpoint' },
      { path: '../secret.md', label: 'secret', kind: 'markdown' }
    ]
    const result = validateSources(sources, {
      projectPath: '/study',
      fileTree: tree,
      fileContents: { 'notes.md': '## Checkpointer\ncheckpoint details' },
      pdfPageTexts: { 'book.pdf': { 2: 'why persistence matters' } },
      pdfPageCounts: { 'book.pdf': 10 }
    })

    expect(result.validSources).toHaveLength(2)
    expect(result.validSources.map((source) => source.label)).toEqual(['book.pdf', 'notes.md'])
    expect(result.rejectedSources.map(({ reason }) => reason)).toEqual([
      'PDF 来源页码超出文档范围。',
      '来源路径不在当前项目内。'
    ])
  })

  it('validates session and general sources against explicit availability', () => {
    const result = validateSources([
      { path: 'session:s1', label: 'invented', kind: 'session' },
      { path: 'general', label: 'model', kind: 'general' }
    ], {
      projectPath: '/study',
      fileTree: tree,
      sessions: [{ id: 's1', title: 'Real session' }],
      allowGeneralKnowledge: false
    })

    expect(result.validSources).toEqual([
      { path: 'session:s1', label: 'Real session', kind: 'session' }
    ])
    expect(result.rejectedSources).toHaveLength(1)
  })

  it('drops an otherwise real citation when AI adds it outside the send-time whitelist', () => {
    const result = validateSources([
      { path: 'book.pdf', label: 'book.pdf', kind: 'pdf', page: 3 }
    ], {
      projectPath: '/study',
      fileTree: tree,
      pdfPageCounts: { 'book.pdf': 10 },
      allowedSources: [
        { path: 'book.pdf', label: 'book.pdf', kind: 'pdf', page: 2 }
      ]
    })

    expect(result.validSources).toEqual([])
    expect(result.rejectedSources[0].reason).toBe('来源不在本次发送上下文的白名单中。')
  })
})

describe('workspace serialization and recovery', () => {
  const persisted: WorkspaceState = {
    version: 1,
    tabs: [
      { id: 'a', path: '/study/a.md', name: 'a.md', kind: 'markdown' },
      { id: 'duplicate', path: '/study/a.md', name: 'copy.md', kind: 'markdown' },
      { id: 'b', path: '/study/missing.pdf', name: 'missing.pdf', kind: 'pdf' }
    ],
    panes: {
      primary: { tabIds: ['a', 'duplicate'], activeTabId: 'duplicate' },
      secondary: { tabIds: ['b'], activeTabId: 'b' }
    },
    activePane: 'secondary',
    split: true,
    pdf: { '/study/missing.pdf': { page: 4, scale: 1.2, fit: 'custom', scrollTop: 300 } },
    markdown: {},
    navSection: 'sessions',
    aiVisible: false,
    leftWidth: 5000,
    aiWidth: 10,
    currentSessionId: 'session-1'
  }

  it('deduplicates tabs, remaps pane ids, clamps layout, and retains missing tabs', () => {
    const restored = restoreWorkspaceState(persisted, { existingPaths: ['/study/a.md'] })

    expect(restored.tabs).toHaveLength(2)
    expect(restored.panes.primary).toEqual({ tabIds: ['a'], activeTabId: 'a' })
    expect(restored.tabs.find((tab) => tab.id === 'b')?.missing).toBe(true)
    expect(restored.leftWidth).toBe(400)
    expect(restored.aiWidth).toBe(300)
  })

  it('returns a detached, schema-clean serialization', () => {
    const serialized = serializeWorkspaceState(persisted)
    serialized.tabs[0].name = 'changed'

    expect(persisted.tabs[0].name).toBe('a.md')
    expect(serialized.version).toBe(1)
  })

  it('falls back safely for corrupt JSON', () => {
    expect(restoreWorkspaceState('{broken')).toMatchObject({
      version: 1,
      tabs: [],
      activePane: 'primary'
    })
  })

  it('clears a stale missing marker when the file exists again', () => {
    const stale = structuredClone(persisted)
    stale.tabs[0].missing = true
    expect(restoreWorkspaceState(stale, { existingPaths: ['/study/a.md'] }).tabs[0].missing).toBeUndefined()
  })
})
