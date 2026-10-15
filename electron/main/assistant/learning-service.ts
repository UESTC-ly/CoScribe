import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'

import type { LearningMutation, LearningSnapshot, LearningSource, LearningSourceInput, LegacyLearningImportResult } from '../../../src/shared/learning'
import { parseFlashcards } from '../../../src/plugins/flashcards/flashcard-utils'
import type { PdfTextService } from '../pdf'
import type { ProjectService, ProjectWriteScope } from '../project'
import type { AssistantService } from './service'
import { learningMutationSchema, learningSourceSchema, legacyImportSchema, scheduleSchema, type LearningImportCard, type StoredLearningSource } from './learning-store'

const MAX_SOURCE_BYTES = 20 * 1024 * 1024
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
const normal = (value: string): string => value.replace(/\s+/gu, ' ').trim()
const corrections = new Set(['knowledge.save', 'knowledge.delete', 'record.save', 'record.delete', 'source.delete', 'relation.delete', 'material.delete', 'review.correct', 'review.delete'])

interface LearningDependencies {
  assistant: AssistantService
  project: ProjectService
  pdf: PdfTextService
  authorize: (permission: 'learning:read' | 'learning:write' | 'project:read') => Promise<void>
  settingsRevision: () => number
}

export class LearningService {
  constructor(private readonly deps: LearningDependencies) { }

  private verify(epoch: number, scope?: ProjectWriteScope): void {
    if (epoch !== this.deps.settingsRevision()) throw new Error('插件授权或设置已变化，请刷新后重试。')
    if (scope) this.deps.project.assertWriteScope(scope)
  }
  private bindScope(epoch: number, scope: ProjectWriteScope): ProjectWriteScope {
    return { ...scope, verify: () => this.verify(epoch, scope) }
  }
  private scope(): ProjectWriteScope | undefined {
    try { return this.deps.project.captureWriteScope() } catch { return undefined }
  }
  private async grant(write = false): Promise<number> {
    const epoch = this.deps.settingsRevision()
    await this.deps.authorize('learning:read')
    if (write) await this.deps.authorize('learning:write')
    this.verify(epoch)
    return epoch
  }

  async inspect(): Promise<LearningSnapshot> {
    // Privacy controls are core app capabilities, available with no project or
    // plugin. They never read project files or send anything to a model.
    return this.deps.assistant.workflow('learning-list', undefined)
  }
  async correct(payload: unknown): Promise<LearningSnapshot> {
    const input = learningMutationSchema.parse(payload)
    if (!corrections.has(input.op) || ((input.op === 'knowledge.save' || input.op === 'record.save') && !input.id)) throw new Error('此入口只能纠正或删除已有学习数据。')
    return this.commit(input)
  }

  private async digest(filePath: string, scope: ProjectWriteScope): Promise<{
    bytes: Buffer
    relative: string
  }> {
    this.deps.project.assertWriteScope(scope)
    const guard = this.deps.project.guard
    const canonical = await guard.existing(filePath, 'file')
    this.deps.project.assertWriteScope(scope)
    const descriptor = await guard.openReadOnly(canonical)
    try {
      this.deps.project.assertWriteScope(scope)
      const info = await descriptor.stat()
      this.deps.project.assertWriteScope(scope)
      if (info.size > MAX_SOURCE_BYTES) throw new Error('学习来源超过 20 MB 上限。')
      const bytes = Buffer.alloc(Math.min(MAX_SOURCE_BYTES + 1, info.size + 1))
      const { bytesRead } = await descriptor.read(bytes, 0, bytes.length, 0)
      const after = await descriptor.stat()
      if (bytesRead !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('来源在读取期间变化，请刷新后重试。')
      this.deps.project.assertWriteScope(scope)
      return { bytes: bytes.subarray(0, bytesRead), relative: path.relative(scope.root, canonical).split(path.sep).join('/') }
    } finally { await descriptor.close() }
  }

  private async reference(referenceId: string, scope: ProjectWriteScope): Promise<{
    fingerprint: string
    pdfPath?: string
  }> {
    const library = await this.deps.project.pluginData('references', scope)
    this.deps.project.assertWriteScope(scope)
    const parsed = z.object({ references: z.array(z.object({ id: z.string(), pdfPath: z.string().optional() }).passthrough()) }).parse(library)
    const reference = parsed.references.find((item) => item.id === referenceId)
    if (!reference) throw new Error('文献来源已删除或不属于当前项目。')
    return { fingerprint: hash(JSON.stringify(reference)), pdfPath: reference.pdfPath }
  }

  private async source(input: LearningSourceInput, scope: ProjectWriteScope, verifiedFile?: {
    bytes: Buffer
    relative: string
  }): Promise<StoredLearningSource> {
    const source = learningSourceSchema.parse(input)
    let fingerprint: string | null = null
    let relative: string | undefined
    if (source.kind === 'literature') {
      const reference = await this.reference(source.referenceId!, scope)
      fingerprint = reference.fingerprint
      if (source.path && (!reference.pdfPath || (await this.deps.project.guard.existing(reference.pdfPath, 'file')) !== (await this.deps.project.guard.existing(source.path, 'file')))) throw new Error('文献文件与文献库关联不一致。')
    }
    if (source.path) {
      const file = verifiedFile ?? await this.digest(source.path, scope)
      relative = file.relative
      if (source.kind !== 'literature') fingerprint = hash(file.bytes)
      if (source.quote) {
        let content = file.bytes.toString('utf8')
        if (/\.pdf$/iu.test(relative)) {
          if (!source.page) throw new Error('PDF 选区需要页码。')
          content = (await this.deps.pdf.pageText(source.path, source.page)).text
        } else if (!/\.(?:md|markdown|txt|[cm]?[jt]sx?|py|cpp|c|h|hpp|json|yaml|yml|html|css|rs|go)$/iu.test(relative)) throw new Error('本轮选区支持文本笔记、代码和可提取正文的 PDF。')
        if (!normal(content).includes(normal(source.quote))) throw new Error('选区原文无法在已保存来源中核对。请保存笔记或重新选择。')
      }
    }
    this.deps.project.assertWriteScope(scope)
    const now = Date.now()
    return { ...source, ...(relative ? { path: relative } : {}), id: randomUUID(), workspace: scope.root, workspaceId: hash(scope.root), projectName: path.basename(scope.root).slice(0, 200), fingerprint, createdAt: now, updatedAt: now, revision: 1 }
  }

  async list(): Promise<LearningSnapshot> {
    const epoch = await this.grant()
    const baseScope = this.scope()
    const scope = baseScope ? this.bindScope(epoch, baseScope) : undefined
    const snapshot = await this.inspect()
    this.verify(epoch, scope)
    const stored = await this.deps.assistant.workflow<StoredLearningSource[]>('learning-sources', undefined)
    this.verify(epoch, scope)
    if (stored.length && scope) {
      await this.deps.authorize('project:read')
      this.verify(epoch, scope)
    }
    const statuses = new Map<string, LearningSource['status']>()
    const fileFingerprints = new Map<string, string>()
    const fileFingerprint = async (file: string): Promise<string> => {
      const cached = fileFingerprints.get(file)
      if (cached) return cached
      const fingerprint = hash((await this.digest(file, scope!)).bytes)
      fileFingerprints.set(file, fingerprint)
      return fingerprint
    }
    // Closed projects are never probed from disk. Global facts and manually
    // saved material remain available; missing evidence is visibly qualified.
    for (const source of stored) {
      if (!scope || source.workspace !== scope.root) {
        statuses.set(source.id, 'project-closed')
        continue
      }
      try {
        let fingerprint: string | null = null
        if (source.kind === 'literature') {
          fingerprint = (await this.reference(source.referenceId!, scope)).fingerprint
          if (source.path) await fileFingerprint(source.path)
        } else if (source.path) fingerprint = await fileFingerprint(source.path)
        else await this.deps.project.guard.existing('.', 'directory')
        statuses.set(source.id, fingerprint === source.fingerprint ? 'available' : 'changed')
      } catch (error) {
        this.verify(epoch, scope)
        statuses.set(source.id, (error as NodeJS.ErrnoException).code === 'ENOENT' || (error instanceof Error && error.message.includes('已删除')) ? 'missing' : 'blocked')
      }
      this.verify(epoch, scope)
    }
    // A concurrent correction must never return a new set of source statuses
    // on an old snapshot that could then overwrite the correction.
    const current = await this.inspect()
    this.verify(epoch, scope)
    if (current.revision !== snapshot.revision) throw new Error('学习库在查询期间变化，请刷新后重试。')
    return { ...snapshot, sources: snapshot.sources.map((source) => ({ ...source, status: statuses.get(source.id) ?? 'unverified' })) }
  }

  async mutate(payload: unknown): Promise<LearningSnapshot> {
    const input = learningMutationSchema.parse(payload)
    const epoch = await this.grant(true)
    if (input.op === 'source.attach' || input.op === 'source.relink') {
      await this.deps.authorize('project:read')
      const scope = this.bindScope(epoch, this.deps.project.captureWriteScope())
      this.verify(epoch, scope)
      const source = await this.source(input.source, scope)
      this.verify(epoch, scope)
      return this.deps.assistant.workflow('learning-attach', { expectedRevision: input.expectedRevision, source, ...(input.op === 'source.attach' ? { knowledgeId: input.knowledgeId } : { id: input.id }) })
    }
    this.verify(epoch)
    return this.commit(input)
  }
  private commit(input: LearningMutation): Promise<LearningSnapshot> {
    return this.deps.assistant.workflow(input.op === 'source.delete' ? 'learning-source-delete' : 'learning-mutate', input.op === 'source.delete' ? { expectedRevision: input.expectedRevision, id: input.id } : input)
  }

  async due(through?: unknown): Promise<{
    revision: number
    materials: LearningSnapshot['materials']
  }> {
    const epoch = await this.grant()
    const timestamp = through === undefined ? Date.now() : z.number().int().nonnegative().max(Date.now() + 86_400_000).parse(through)
    const value = await this.deps.assistant.workflow<{
      revision: number
      materials: LearningSnapshot['materials']
    }>('learning-due', timestamp)
    this.verify(epoch)
    return value
  }

  async importLegacy(payload: unknown): Promise<LegacyLearningImportResult> {
    const input = legacyImportSchema.parse(payload)
    const epoch = await this.grant(true)
    await this.deps.authorize('project:read')
    const scope = this.bindScope(epoch, this.deps.project.captureWriteScope())
    this.verify(epoch, scope)
    const metadata = await this.deps.project.readMetadata<unknown>('plugin-data', {}, scope)
    this.verify(epoch, scope)
    const allPlugins = z.record(z.string(), z.unknown()).safeParse(metadata)
    if (!allPlugins.success) throw new Error('旧项目插件数据损坏或格式无效，未导入；原数据已保留。')
    const legacy = allPlugins.data.flashcards ?? null
    const reviews = legacy === null ? {} : z.strictObject({ reviews: z.record(z.string().max(200), scheduleSchema) }).parse(legacy).reviews
    for (const [key, schedule] of Object.entries(reviews)) if (key !== schedule.cardId) throw new Error('旧闪卡 ID 与进度不一致，未导入；原项目数据已保留。')
    const cards: LearningImportCard[] = []
    const paths = new Set<string>()
    for (const inputPath of input.paths) {
      const file = await this.digest(inputPath, scope)
      this.verify(epoch, scope)
      if (!/\.(?:md|markdown)$/iu.test(file.relative) || file.bytes.length > 1_000_000) throw new Error('旧闪卡导入仅支持 1 MB 以内的 Markdown。')
      if (paths.has(file.relative)) continue
      paths.add(file.relative)
      // The old UI parsed absolute paths, so preserve that exact identity.
      for (const card of parseFlashcards(file.bytes.toString('utf8'), path.join(scope.root, file.relative))) {
        if (card.question.length > 2_000 || card.answer.length > 4_000) throw new Error('旧卡片正文超过上限，请先整理后导入。')
        if (cards.length >= 500) throw new Error('单次导入超过 500 张，请分批选择来源。')
        const source = await this.source({ kind: 'note', path: file.relative, line: card.line }, scope, file)
        cards.push({ legacyId: card.id, question: card.question, answer: card.answer, source, schedule: reviews[card.id] })
      }
    }
    this.verify(epoch, scope)
    return this.deps.assistant.workflow('learning-import', { expectedRevision: input.expectedRevision, workspaceId: hash(scope.root), cards, reviewIds: Object.keys(reviews) })
  }
}
