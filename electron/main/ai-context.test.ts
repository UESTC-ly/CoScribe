import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import type { AiOperationMode, ContextSnapshot, SearchResult } from '../../src/shared/types'
import { AiService, organizationRetrievalQuery } from './ai'
import type { PdfTextService } from './pdf'
import type { ProjectService } from './project'
import type { ProjectSearchService } from './search'
import type { SettingsStore } from './settings'

const projectPath = path.resolve('/tmp/coscribe-ai-context')
const documentPath = path.join(projectPath, 'lesson.md')

function snapshot(scope: ContextSnapshot['scope'], overrides: Partial<ContextSnapshot> = {}): ContextSnapshot {
  return {
    projectName: 'Context test',
    projectPath,
    pane: 'primary',
    documentPath,
    kind: 'markdown',
    selection: 'SELECTED_ONLY',
    visibleText: 'VISIBLE_ONLY',
    sectionText: 'SECTION_ONLY',
    documentText: 'SECRET_FULL_DOCUMENT',
    scope,
    referencedFiles: [],
    capturedAt: Date.now(),
    ...overrides
  }
}

function service(results: SearchResult[] = []) {
  const retrieve = vi.fn(async () => results)
  const tree = vi.fn(async () => [{
    name: 'lesson.md',
    path: documentPath,
    kind: 'markdown' as const,
    size: 128,
    modifiedAt: 1
  }, {
    name: 'knowledge',
    path: path.join(projectPath, 'knowledge'),
    kind: 'folder' as const,
    size: 0,
    modifiedAt: 1,
    children: [{
      name: 'existing.md',
      path: path.join(projectPath, 'knowledge', 'existing.md'),
      kind: 'markdown' as const,
      size: 256,
      modifiedAt: 1
    }]
  }])
  const project = {
    info: { name: 'Context test', path: projectPath },
    guard: {
      existing: vi.fn(async (value: string) => path.isAbsolute(value) ? value : path.join(projectPath, value))
    },
    tree,
    read: vi.fn(async () => ({ content: 'REFERENCED_FILE', modifiedAt: 1 }))
  } as unknown as ProjectService
  const ai = new AiService(
    {} as SettingsStore,
    project,
    {} as PdfTextService,
    { retrieve } as unknown as ProjectSearchService
  )
  const exposed = ai as unknown as {
    validatedContext(
      value: ContextSnapshot,
      question: string,
      operationMode?: AiOperationMode
    ): Promise<{ text: string; sources: unknown[] }>
  }
  return { exposed, retrieve, tree }
}

describe('AI context scope boundaries', () => {
  it('builds the organization retrieval query from recent conversation instead of the synthetic action', () => {
    const query = organizationRetrievalQuery([
      { role: 'user', content: `OLD_TOPIC_${'x'.repeat(1_200)}` },
      { role: 'user', content: 'RECENT_API_AUTH_TOPIC' },
      { role: 'assistant', content: 'RECENT_MIDDLEWARE_RESULT' },
      { role: 'user', content: '请整理笔记' }
    ])

    expect(query).toContain('RECENT_API_AUTH_TOPIC')
    expect(query).toContain('RECENT_MIDDLEWARE_RESULT')
    expect(query).not.toContain('请整理笔记')
    expect(query.indexOf('RECENT_MIDDLEWARE_RESULT')).toBeLessThan(query.indexOf('OLD_TOPIC_'))
  })

  it('prioritizes selection while keeping visible scope out of the full document', async () => {
    const { exposed } = service()
    const result = await exposed.validatedContext(snapshot('visible'), 'explain this')

    expect(result.text).toContain('VISIBLE_ONLY')
    expect(result.text).toContain('SELECTED_ONLY')
    expect(result.text).not.toContain('SECTION_ONLY')
    expect(result.text).not.toContain('SECRET_FULL_DOCUMENT')
  })

  it('does not silently widen an empty selection', async () => {
    const { exposed } = service()
    const result = await exposed.validatedContext(snapshot('selection', { selection: '' }), 'explain this')

    expect(result.text).toContain('未自动扩大')
    expect(result.text).not.toContain('VISIBLE_ONLY')
    expect(result.text).not.toContain('SECRET_FULL_DOCUMENT')
  })

  it('provides the exact current Markdown path as the default note target', async () => {
    const { exposed } = service()
    const result = await exposed.validatedContext(snapshot('document'), '记笔记')

    expect(result.text).toContain('上下文范围：document')
    expect(result.text).toContain('当前文档项目内相对路径：lesson.md')
    expect(result.text).toContain('当前笔记写入目标：lesson.md')
    expect(result.text).toContain('默认对此文件使用 append')
  })

  it('lets project-note organization choose a destination instead of targeting the open Markdown file', async () => {
    const { exposed, retrieve, tree } = service()
    const result = await exposed.validatedContext(
      snapshot('project'),
      'API authentication middleware',
      'organize-project-notes'
    )

    expect(tree).toHaveBeenCalledOnce()
    expect(retrieve).toHaveBeenCalledWith('API authentication middleware', 10)
    expect(result.text).toContain('项目目录结构')
    expect(result.text).toContain('knowledge/existing.md')
    expect(result.text).toContain('当前打开文档仅供参考')
    expect(result.text).toContain('lesson.md')
    expect(result.text).not.toContain('当前笔记写入目标')
    expect(result.text).not.toContain('默认对此文件使用 append')
  })

  it('grounds flashcard generation in project retrieval and the bounded project tree', async () => {
    const resultPath = path.join(projectPath, 'knowledge', 'rag.md')
    const { exposed, retrieve, tree } = service([{
      id: 'rag-result', type: 'content', path: resultPath, title: 'rag.md', excerpt: 'RAG uses retrieval.', kind: 'markdown', line: 3, score: 90
    }])
    const result = await exposed.validatedContext(snapshot('project'), 'RAG retrieval', 'generate-flashcards')

    expect(tree).toHaveBeenCalledOnce()
    expect(retrieve).toHaveBeenCalledWith('RAG retrieval', 10)
    expect(result.text).toContain('闪卡模式')
    expect(result.text).toContain('RAG uses retrieval.')
    expect(result.sources).toEqual([expect.objectContaining({ path: resultPath, line: 3 })])
  })

  it('keeps extracted PPTX text and source type in document context', async () => {
    const slidesPath = path.join(projectPath, 'slides.pptx')
    const { exposed } = service()
    const result = await exposed.validatedContext(snapshot('document', {
      documentPath: slidesPath,
      documentName: 'slides.pptx',
      kind: 'pptx',
      selection: '',
      visibleText: '',
      sectionText: '',
      documentText: '[幻灯片 1]\nPPTX_EXTRACTED_TEXT'
    }), '总结演示文稿')

    expect(result.text).toContain('PPTX_EXTRACTED_TEXT')
    expect(result.sources).toEqual([expect.objectContaining({ path: slidesPath, kind: 'pptx' })])
  })

  it('keeps isolated browser text and the verified web source without treating it as a project file', async () => {
    const { exposed } = service()
    const result = await exposed.validatedContext(snapshot('selection', {
      documentPath: undefined,
      documentName: 'Electron security guide',
      kind: undefined,
      webUrl: 'https://example.com/security',
      selection: 'WEB_SELECTION',
      visibleText: '',
      sectionText: '',
      documentText: ''
    }), 'explain the selection')

    expect(result.text).toContain('当前网页：Electron security guide')
    expect(result.text).toContain('网页来源：https://example.com/security')
    expect(result.text).toContain('WEB_SELECTION')
    expect(result.sources).toEqual([expect.objectContaining({
      path: 'https://example.com/security',
      kind: 'web',
      label: 'Electron security guide'
    })])
  })

  it('uses app-owned retrieval only for explicit project scope', async () => {
    const resultPath = path.join(projectPath, 'retrieved.md')
    const { exposed, retrieve } = service([{
      id: 'retrieved',
      type: 'content',
      path: resultPath,
      title: 'retrieved.md',
      excerpt: 'PROJECT_RETRIEVAL_RESULT',
      kind: 'markdown',
      line: 3,
      score: 42
    }])
    const result = await exposed.validatedContext(snapshot('project'), 'Where is retrieval?')

    expect(retrieve).toHaveBeenCalledWith('Where is retrieval?', 10)
    expect(result.text).toContain('PROJECT_RETRIEVAL_RESULT')
    expect(result.text).not.toContain('SECRET_FULL_DOCUMENT')
    expect(result.sources).toHaveLength(1)
  })

  it('sends no project material in general scope', async () => {
    const { exposed, retrieve } = service()
    const result = await exposed.validatedContext(snapshot('general', {
      referencedFiles: [documentPath]
    }), 'general question')

    expect(retrieve).not.toHaveBeenCalled()
    expect(result.text).not.toContain('VISIBLE_ONLY')
    expect(result.text).not.toContain('SECRET_FULL_DOCUMENT')
    expect(result.text).not.toContain('REFERENCED_FILE')
    expect(result.sources).toHaveLength(0)
  })
})
