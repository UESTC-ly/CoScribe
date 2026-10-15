import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LearningSnapshot } from '../../../src/shared/learning'
import { parseFlashcards } from '../../../src/plugins/flashcards/flashcard-utils'
import { ProjectPathGuard } from '../security'
import type { PdfTextService } from '../pdf'
import type { ProjectService } from '../project'
import type { AssistantService } from './service'
import type { AssistantDatabase } from './database'
import { LearningService } from './learning-service'
import type { AssistantCommand } from './contract'

const sqlite = await import('node:sqlite').catch(() => null)
const DatabaseClass = sqlite ? (await import('./database')).AssistantDatabase : null

let directory: string
let root: string
let other: string
let database: AssistantDatabase
let service: LearningService
let active: string | null
let projectRevision: number
let settingsRevision: number
let permissions: Set<string>
let projectData: Record<string, unknown>
let projectService: ProjectService
let beforeRead: (() => Promise<void>) | undefined
const inspect = (): LearningSnapshot => database.execute('learning-list') as LearningSnapshot
function raw(payload: Record<string, unknown>): LearningSnapshot { return database.execute('learning-mutate', { ...payload, expectedRevision: inspect().revision }) as LearningSnapshot }
function point(): string { return raw({ op: 'knowledge.save', name: 'RAG', domain: 'AI' }).knowledge[0].id }

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'coscribe-learning-service-')))
  root = path.join(directory, 'project-A')
  other = path.join(directory, 'project-B')
  await mkdir(root)
  await mkdir(other)
  active = root
  settingsRevision = 0
  projectRevision = 0
  beforeRead = undefined
  projectData = {}
  permissions = new Set(['project:read', 'learning:read', 'learning:write'])
  database = new DatabaseClass!(path.join(directory, 'assistant.sqlite'))
  const guards = new Map([[root, new ProjectPathGuard(root)], [other, new ProjectPathGuard(other)]])
  const project = {
    get guard() {
      if (!active) throw new Error('closed')
      return guards.get(active)!
    },
    captureWriteScope() {
      if (!active) throw new Error('closed')
      return { root: active, revision: projectRevision }
    },
    assertWriteScope(scope: {
      root: string
      revision: number
      verify?: () => void
    }) {
      scope.verify?.()
      if (scope.root !== active || scope.revision !== projectRevision) throw new Error('项目已切换')
    },
    async readMetadata() {
      await beforeRead?.()
      return projectData
    },
    async pluginData(name: string) {
      await beforeRead?.()
      return projectData[name] ?? null
    }
  } as unknown as ProjectService
  projectService = project
  const assistant = { workflow: async (command: AssistantCommand, payload: unknown) => database.execute(command, payload) } as AssistantService
  service = new LearningService({ assistant, project, pdf: { pageText: async () => ({ text: 'PDF 原文', page: 1, readable: true }) } as unknown as PdfTextService, settingsRevision: () => settingsRevision, authorize: async (permission) => { if (!permissions.has(permission)) throw new Error('未授权') } })
})
afterEach(async () => {
  vi.restoreAllMocks()
  database.close()
  await rm(directory, { recursive: true, force: true })
})

describe.skipIf(!sqlite)('learning source and authorization boundary', () => {
  it('binds sources to the main-process project and verifies saved selections', async () => {
    await writeFile(path.join(root, '笔记.md'), '# RAG\n\n检索  增强生成')
    const knowledgeId = point()
    const result = await service.mutate({ op: 'source.attach', knowledgeId, source: { kind: 'selection', path: '笔记.md', quote: '检索 增强生成' }, expectedRevision: inspect().revision })
    expect(result.sources[0]).toMatchObject({ path: '笔记.md', projectName: 'project-A', kind: 'selection' })
    expect(JSON.stringify(result)).not.toContain(directory)
    expect((await service.list()).sources[0].status).toBe('available')
    await expect(service.mutate({ op: 'source.attach', knowledgeId, source: { kind: 'selection', path: '笔记.md', quote: '模型虚构的文字' }, expectedRevision: inspect().revision })).rejects.toThrow('无法在已保存来源中核对')
    await expect(service.mutate({ op: 'source.attach', knowledgeId, source: { kind: 'note', path: '笔记.md', workspace: other }, expectedRevision: inspect().revision })).rejects.toThrow()
    expect(inspect().sources).toHaveLength(1)
  })

  it('keeps history on rename and relinks the same source ID, exposing changed/missing sources', async () => {
    await writeFile(path.join(root, '旧.md'), '原内容')
    const knowledgeId = point()
    const source = (await service.mutate({ op: 'source.attach', knowledgeId, source: { kind: 'note', path: '旧.md' }, expectedRevision: inspect().revision })).sources[0]
    raw({ op: 'record.save', record: { knowledgeId, kind: 'stage', value: 'learned', note: '', sourceId: source.id } })
    const card = raw({ op: 'material.save', knowledgeId, question: 'Q', answer: 'A', relationIds: [], sourceId: source.id, origin: 'user' }).materials[0]
    raw({ op: 'material.confirm', id: card.id })
    raw({ op: 'review.submit', materialId: card.id, grade: 'good', submissionId: randomUUID() })
    const before = inspect()
    await rename(path.join(root, '旧.md'), path.join(root, '新.md'))
    expect((await service.list()).sources[0].status).toBe('missing')
    await service.mutate({ op: 'source.relink', id: source.id, source: { kind: 'note', path: '新.md' }, expectedRevision: inspect().revision })
    expect(inspect().sources[0].id).toBe(source.id)
    expect(inspect().events).toEqual(before.events)
    expect(inspect().materials[0].schedule).toEqual(before.materials[0].schedule)
    await writeFile(path.join(root, '新.md'), '修正后内容')
    expect((await service.list()).sources[0].status).toBe('changed')
  })

  it('queries global records across projects and after close without probing closed source files', async () => {
    await writeFile(path.join(root, '资料.md'), '资料')
    const knowledgeId = point()
    await service.mutate({ op: 'source.attach', knowledgeId, source: { kind: 'note', path: '资料.md' }, expectedRevision: inspect().revision })
    raw({ op: 'record.save', record: { knowledgeId, kind: 'self-assessment', value: 'needs-practice', note: '' } })
    active = other
    projectRevision += 1
    const global = await service.list()
    expect(global.knowledge[0].id).toBe(knowledgeId)
    expect(global.sources[0].status).toBe('project-closed')
    await expect(service.mutate({ op: 'source.relink', id: global.sources[0].id, source: { kind: 'project' }, expectedRevision: global.revision })).rejects.toThrow('原项目')
    active = null
    projectRevision += 1
    expect((await service.list()).records[0].value).toBe('needs-practice')
    expect((await service.list()).sources[0].status).toBe('project-closed')
  })

  it('rejects traversal, symlinks and invalid literature identities', async () => {
    await writeFile(path.join(other, 'secret.md'), '私密')
    await symlink(path.join(other, 'secret.md'), path.join(root, 'link.md'))
    const knowledgeId = point()
    for (const inputPath of ['../project-B/secret.md', path.join(other, 'secret.md'), 'link.md']) {
      await expect(service.mutate({ op: 'source.attach', knowledgeId, source: { kind: 'note', path: inputPath }, expectedRevision: inspect().revision })).rejects.toThrow()
    }
    projectData.references = { references: [{ id: 'paper', title: '文献', pdfPath: path.join(other, 'secret.md') }] }
    await expect(service.mutate({ op: 'source.attach', knowledgeId, source: { kind: 'literature', referenceId: 'paper', path: 'link.md' }, expectedRevision: inspect().revision })).rejects.toThrow()
    await expect(service.mutate({ op: 'source.attach', knowledgeId, source: { kind: 'literature', referenceId: 'missing' }, expectedRevision: inspect().revision })).rejects.toThrow('文献来源已删除')
    expect(inspect().sources).toEqual([])
  })

  it('requires plugin permissions while retaining core inspection/correction/forget controls', async () => {
    const knowledgeId = point()
    permissions.clear()
    settingsRevision += 1
    await expect(service.list()).rejects.toThrow('未授权')
    await expect(service.due()).rejects.toThrow('未授权')
    await expect(service.mutate({ op: 'knowledge.delete', id: knowledgeId, expectedRevision: inspect().revision })).rejects.toThrow('未授权')
    expect((await service.inspect()).knowledge).toHaveLength(1)
    await expect(service.correct({ op: 'knowledge.save', name: '伪造', domain: '', expectedRevision: inspect().revision })).rejects.toThrow('只能纠正')
    await expect(service.correct({ op: 'review.submit', materialId: randomUUID(), submissionId: randomUUID(), grade: 'good', expectedRevision: inspect().revision })).rejects.toThrow('只能纠正')
    await service.correct({ op: 'knowledge.save', id: knowledgeId, name: '纠正', domain: '', expectedRevision: inspect().revision })
    await service.correct({ op: 'knowledge.delete', id: knowledgeId, expectedRevision: inspect().revision })
    expect(inspect().knowledge).toEqual([])
  })

  it('rejects source/import work started before authorization revocation or a project switch', async () => {
    await writeFile(path.join(root, '卡片.md'), 'Q:: Q\nA:: A')
    const openReadOnly = vi.spyOn(projectService.guard, 'openReadOnly')
    beforeRead = async () => {
      settingsRevision += 1
      permissions.clear()
    }
    await expect(service.importLegacy({ paths: ['卡片.md'], expectedRevision: 0 })).rejects.toThrow('授权或设置已变化')
    expect(inspect().materials).toEqual([])
    expect(openReadOnly).not.toHaveBeenCalled()
    permissions = new Set(['project:read', 'learning:read', 'learning:write'])
    beforeRead = async () => {
      active = other
      projectRevision += 1
    }
    await expect(service.importLegacy({ paths: ['卡片.md'], expectedRevision: 0 })).rejects.toThrow('项目已切换')
    expect(inspect().materials).toEqual([])
  })

  it('imports exact absolute legacy identities without overwriting project data and reports corruption', async () => {
    const content = 'Q:: 检索的作用？\nA:: 找到相关资料'
    const inputPath = path.join(root, '卡片.md')
    await writeFile(inputPath, content)
    const legacyId = parseFlashcards(content, inputPath)[0].id
    const legacy = { reviews: { [legacyId]: { cardId: legacyId, dueAt: 500_000, ease: 2.5, repetitions: 2, intervalDays: 6 } } }
    projectData.flashcards = legacy
    const result = await service.importLegacy({ paths: [inputPath], expectedRevision: 0 })
    expect(result.imported).toBe(1)
    expect(result.snapshot.materials[0].schedule.dueAt).toBe(500_000)
    expect(projectData.flashcards).toEqual(legacy)
    expect(await readFile(inputPath, 'utf8')).toBe(content)
    projectData.flashcards = { reviews: { broken: { dueAt: 'bad' } } }
    await expect(service.importLegacy({ paths: [inputPath], expectedRevision: inspect().revision })).rejects.toThrow()
    expect(inspect().materials).toHaveLength(1)
  })

  it('commits only one of two concurrent modifications from the same version', async () => {
    const expectedRevision = inspect().revision
    const result = await Promise.allSettled([
      service.mutate({ op: 'knowledge.save', name: '并发一', domain: '', expectedRevision }),
      service.mutate({ op: 'knowledge.save', name: '并发二', domain: '', expectedRevision })
    ])
    expect(result.filter((entry) => entry.status === 'fulfilled')).toHaveLength(1)
    expect(result.filter((entry) => entry.status === 'rejected')).toHaveLength(1)
    expect(inspect().knowledge).toHaveLength(1)
  })
  it('verifies PDF selections and binds literature without turning their text into user state', async () => {
    await writeFile(path.join(root, 'paper.pdf'), '%PDF-test')
    projectData.references = { references: [{ id: 'paper', title: '文献', pdfPath: path.join(root, 'paper.pdf') }] }
    const knowledgeId = point()
    await service.mutate({ op: 'source.attach', knowledgeId, source: { kind: 'literature', referenceId: 'paper', path: 'paper.pdf', quote: 'PDF 原文', page: 1 }, expectedRevision: inspect().revision })
    expect((await service.list()).sources[0].status).toBe('available')
    expect(inspect().records).toEqual([])
    await expect(service.mutate({ op: 'source.attach', knowledgeId, source: { kind: 'selection', path: 'paper.pdf', quote: 'PDF 原文' }, expectedRevision: inspect().revision })).rejects.toThrow('需要页码')
    projectData.references = { references: [] }
    expect((await service.list()).sources[0].status).toBe('missing')
  })

})
