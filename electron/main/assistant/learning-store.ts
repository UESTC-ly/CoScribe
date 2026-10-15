import { createHash, randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

import type { LearningMutation, LearningRecord, LearningSnapshot, LearningSource, LegacyLearningImportResult } from '../../../src/shared/learning'
import { initialReviewState, scheduleReview } from '../../../src/plugins/flashcards/flashcard-utils'
import { memoryTokens } from './contract'

export const REVIEW_ALGORITHM = 'coscribe-sm2-v1'
const id = z.uuid()
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const revision = z.number().int().nonnegative()
const identity = { id, createdAt: time, updatedAt: time, revision: z.number().int().positive() }
const sourceId = id.optional()
const grade = z.enum(['again', 'hard', 'good', 'easy'])
const relationKind = z.enum(['prerequisite', 'part-of', 'contrast', 'application'])
const origin = z.enum(['user', 'model'])
const note = z.string().trim().max(1_000)
const fields = { expectedRevision: revision }
const deletion = { ...fields, id }
export const learningSourceSchema = z.strictObject({
  kind: z.enum(['project', 'note', 'literature', 'selection']), path: z.string().min(1).max(1_024).optional(),
  referenceId: z.string().min(1).max(200).optional(), quote: z.string().min(1).max(2_000).optional(),
  page: z.number().int().min(1).max(100_000).optional(), line: z.number().int().min(1).max(1_000_000).optional()
}).superRefine((value, ctx) => {
  if (value.kind === 'project' && (value.path || value.quote || value.referenceId || value.page || value.line)) ctx.addIssue({ code: 'custom', message: '项目来源不能附带文件或选区。' })
  if (['note', 'selection'].includes(value.kind) && !value.path) ctx.addIssue({ code: 'custom', message: '笔记或选区需要项目文件。' })
  if (value.kind === 'selection' && !value.quote) ctx.addIssue({ code: 'custom', message: '选区来源需要原文。' })
  if (value.kind === 'literature' && !value.referenceId) ctx.addIssue({ code: 'custom', message: '文献来源需要文献 ID。' })
})
const recordBase = { knowledgeId: id, sourceId, note }
export const learningRecordSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...recordBase, kind: z.literal('interest'), value: z.enum(['following', 'not-following']) }),
  z.strictObject({ ...recordBase, kind: z.literal('stage'), value: z.enum(['not-started', 'learning', 'learned', 'paused']) }),
  z.strictObject({ ...recordBase, kind: z.literal('self-assessment'), value: z.enum(['unassessed', 'needs-practice', 'confident']) })
])
export const learningMutationSchema = z.discriminatedUnion('op', [
  z.strictObject({ ...fields, op: z.literal('knowledge.save'), id: id.optional(), name: z.string().trim().min(1).max(200), domain: z.string().trim().max(100) }),
  z.strictObject({ ...deletion, op: z.literal('knowledge.delete') }),
  z.strictObject({ ...fields, op: z.literal('source.attach'), knowledgeId: id, source: learningSourceSchema }),
  z.strictObject({ ...deletion, op: z.literal('source.relink'), source: learningSourceSchema }),
  z.strictObject({ ...deletion, op: z.literal('source.delete') }),
  z.strictObject({ ...fields, op: z.literal('record.save'), id: id.optional(), record: learningRecordSchema }),
  z.strictObject({ ...deletion, op: z.literal('record.delete') }),
  z.strictObject({ ...fields, op: z.literal('relation.save'), id: id.optional(), fromId: id, toId: id, kind: relationKind, sourceId, note, origin }),
  z.strictObject({ ...deletion, op: z.literal('relation.confirm') }),
  z.strictObject({ ...deletion, op: z.literal('relation.delete') }),
  z.strictObject({ ...fields, op: z.literal('material.save'), id: id.optional(), knowledgeId: id, question: z.string().trim().min(1).max(2_000), answer: z.string().trim().min(1).max(4_000), sourceId, relationIds: z.array(id).max(20), origin }),
  z.strictObject({ ...deletion, op: z.literal('material.confirm') }),
  z.strictObject({ ...deletion, op: z.literal('material.delete') }),
  z.strictObject({ ...fields, op: z.literal('review.submit'), submissionId: id, materialId: id, grade }),
  z.strictObject({ ...deletion, op: z.literal('review.correct'), grade }),
  z.strictObject({ ...deletion, op: z.literal('review.delete') })
])
export const legacyImportSchema = z.strictObject({ expectedRevision: revision, paths: z.array(z.string().min(1).max(1_024)).max(100) })
export const scheduleSchema = z.strictObject({
  cardId: z.string().min(1).max(200), dueAt: time, intervalDays: z.number().finite().min(0).max(365_000),
  ease: z.number().finite().min(1.3).max(100), repetitions: z.number().int().min(0).max(100_000), lastReviewedAt: time.optional()
})
const storedSourceSchema = z.strictObject({
  ...learningSourceSchema.shape, ...identity, workspace: z.string().min(1).max(4_096), workspaceId: z.string().length(64),
  projectName: z.string().min(1).max(200), fingerprint: z.string().length(64).nullable()
})
export type StoredLearningSource = z.infer<typeof storedSourceSchema>
const stateSchema = z.strictObject({
  revision,
  knowledge: z.array(z.strictObject({ ...identity, name: z.string().min(1).max(200), domain: z.string().max(100), sourceIds: z.array(id).max(50) })).max(500),
  sources: z.array(storedSourceSchema).max(2_000),
  records: z.array(z.discriminatedUnion('kind', [
    learningRecordSchema.options[0].extend({ ...identity, origin: z.literal('user-explicit') }),
    learningRecordSchema.options[1].extend({ ...identity, origin: z.literal('user-explicit') }),
    learningRecordSchema.options[2].extend({ ...identity, origin: z.literal('user-explicit') })
  ])).max(2_000),
  relations: z.array(z.strictObject({ ...identity, fromId: id, toId: id, kind: relationKind, sourceId, note, origin, confirmedAt: time.nullable() })).max(2_000),
  materials: z.array(z.strictObject({ ...identity, knowledgeId: id, question: z.string().min(1).max(2_000), answer: z.string().min(1).max(4_000), sourceId, relationIds: z.array(id).max(20), origin: z.enum(['user', 'model', 'legacy-import']), confirmedAt: time.nullable(), schedule: scheduleSchema, algorithmVersion: z.literal(REVIEW_ALGORITHM) })).max(2_000),
  events: z.array(z.strictObject({ id, submissionId: id, materialId: id, knowledgeId: id, grade, reviewedAt: time, updatedAt: time, revision: z.number().int().positive(), nextDueAt: time, materialRevision: z.number().int().positive(), sourceId, sourceRevision: z.number().int().positive().optional(), algorithmVersion: z.literal(REVIEW_ALGORITHM) })).max(5_000),
  seeds: z.record(id, scheduleSchema),
  imports: z.array(z.strictObject({ workspaceId: z.string().length(64), legacyId: z.string().max(200), materialId: id.nullable() })).max(5_000),
  submissions: z.array(z.strictObject({ id, eventId: id.nullable(), requestHash: z.string().length(64).nullable() })).max(10_000)
})
type LearningState = Omit<z.infer<typeof stateSchema>, 'records'> & { records: LearningRecord[] }
export interface LearningImportCard {
  legacyId: string
  question: string
  answer: string
  source: StoredLearningSource
  schedule?: z.infer<typeof scheduleSchema>
}

export function migrateLearning(db: DatabaseSync, filePath: string, backup: boolean): void {
  if (backup) {
    const destination = filePath + '.v2-' + randomUUID() + '.bak'
    db.prepare('VACUUM INTO ?').run(destination)
    chmodSync(destination, 0o600)
  }
  const initial: LearningState = { revision: 0, knowledge: [], sources: [], records: [], relations: [], materials: [], events: [], seeds: {}, imports: [], submissions: [] }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE learning_state (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); PRAGMA user_version=3;')
    db.prepare('INSERT INTO learning_state VALUES(1,?)').run(JSON.stringify(initial))
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

export class LearningStore {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(action: () => T) => T) { }

  private read(): LearningState {
    try {
      const row = this.db.prepare('SELECT payload FROM learning_state WHERE id=1').get()
      if (!row || typeof row.payload !== 'string' || Buffer.byteLength(row.payload) > 4 * 1024 * 1024) throw new Error('invalid')
      const state = stateSchema.parse(JSON.parse(row.payload)) as LearningState
      this.validate(state)
      return state
    } catch { throw new Error('学习库数据损坏或格式不兼容，原数据已保留；请恢复备份后重试。') }
  }

  private validate(state: LearningState): void {
    const knowledge = new Set(state.knowledge.map((item) => item.id))
    const sources = new Set(state.sources.map((item) => item.id))
    const relations = new Set(state.relations.map((item) => item.id))
    const materials = new Map(state.materials.map((item) => [item.id, item]))
    const events = new Set(state.events.map((item) => item.id))
    const submissions = new Map(state.submissions.map((item) => [item.id, item]))
    if (new Set(state.records.map((item) => item.knowledgeId + ':' + item.kind)).size !== state.records.length) throw new Error('duplicate state')
    for (const rows of [state.knowledge, state.sources, state.records, state.relations, state.materials, state.events, state.submissions]) {
      if (new Set(rows.map((item) => item.id)).size !== rows.length) throw new Error('duplicate')
    }
    for (const source of state.sources) {
      const { id: _id, workspace: _workspace, workspaceId: _workspaceId, projectName: _projectName, fingerprint: _fingerprint, createdAt: _createdAt, updatedAt: _updatedAt, revision: _revision, ...input } = source
      learningSourceSchema.parse(input)
    }
    for (const point of state.knowledge) if (point.sourceIds.some((value) => !sources.has(value))) throw new Error('source')
    for (const item of [...state.records, ...state.materials]) {
      if (!knowledge.has(item.knowledgeId) || (item.sourceId && !sources.has(item.sourceId))) throw new Error('knowledge')
    }
    for (const relation of state.relations) if (!knowledge.has(relation.fromId) || !knowledge.has(relation.toId) || relation.fromId === relation.toId || (relation.sourceId && !sources.has(relation.sourceId))) throw new Error('relation')
    for (const material of state.materials) {
      if (material.schedule.cardId !== material.id || !state.seeds[material.id] || material.relationIds.some((value) => {
        const relation = state.relations.find((item) => item.id === value)
        return !relations.has(value) || !relation || (relation.fromId !== material.knowledgeId && relation.toId !== material.knowledgeId)
      })) throw new Error('material')
    }
    for (const event of state.events) {
      if ((event.sourceId && !sources.has(event.sourceId)) || materials.get(event.materialId)?.knowledgeId !== event.knowledgeId || submissions.get(event.submissionId)?.eventId !== event.id) throw new Error('event')
    }
    for (const entry of state.imports) if (entry.materialId && !materials.has(entry.materialId)) throw new Error('import')
    for (const entry of state.submissions) if (entry.eventId && !events.has(entry.eventId)) throw new Error('submission')
  }

  private save(state: LearningState): void {
    state.revision += 1
    if (!stateSchema.safeParse(state).success) throw new Error('学习数据达到条目或调度上限，本次修改未保存。请备份并整理后重试。')
    this.validate(state)
    const json = JSON.stringify(state)
    if (Buffer.byteLength(json) > 4 * 1024 * 1024) throw new Error('学习库达到 4 MB 上限，请先备份并整理。')
    this.db.prepare('UPDATE learning_state SET payload=? WHERE id=1').run(json)
    this.db.exec('UPDATE policy SET revision=revision+1 WHERE id=1')
  }

  private dto(state: LearningState): LearningSnapshot {
    const { seeds: _seeds, imports: _imports, submissions: _submissions, ...snapshot } = state
    return { ...snapshot, sources: state.sources.map(({ workspace: _workspace, ...item }) => ({ ...item, status: 'unverified' as const })) }
  }
  snapshot(): LearningSnapshot { return this.dto(this.read()) }
  sources(): StoredLearningSource[] { return this.read().sources }

  private expected(state: LearningState, value: number): void {
    if (state.revision !== value) throw new Error('学习库已变化，未覆盖其他修改。请刷新后核对并重试。')
  }
  private find<T extends { id: string }>(rows: T[], value: string): T {
    const item = rows.find((row) => row.id === value)
    if (!item) throw new Error('记录已删除或不存在，请刷新后重试。')
    return item
  }
  private stamp<T extends {
    updatedAt: number
    revision: number
  }>(item: T): void {
    item.updatedAt = Date.now()
    item.revision += 1
  }
  private newIdentity(): {
    id: string
    createdAt: number
    updatedAt: number
    revision: number
  } {
    const now = Date.now()
    return { id: randomUUID(), createdAt: now, updatedAt: now, revision: 1 }
  }
  private assertSource(state: LearningState, value?: string): void { if (value) this.find(state.sources, value) }

  private removeMaterial(state: LearningState, materialId: string): void {
    state.materials = state.materials.filter((item) => item.id !== materialId)
    const removedEvents = new Set(state.events.filter((item) => item.materialId === materialId).map((item) => item.id))
    state.events = state.events.filter((item) => item.materialId !== materialId)
    delete state.seeds[materialId]
    for (const entry of state.submissions) if (entry.eventId && removedEvents.has(entry.eventId)) {
      entry.eventId = null
      entry.requestHash = null
    }
    for (const entry of state.imports) if (entry.materialId === materialId) entry.materialId = null
  }
  private removeSource(state: LearningState, source: string): void {
    state.sources = state.sources.filter((item) => item.id !== source)
    for (const point of state.knowledge) if (point.sourceIds.includes(source)) {
      point.sourceIds = point.sourceIds.filter((value) => value !== source)
      this.stamp(point)
    }
    for (const event of state.events) if (event.sourceId === source) {
      delete event.sourceId
      delete event.sourceRevision
      this.stamp(event)
    }
    for (const item of [...state.records, ...state.relations, ...state.materials]) if (item.sourceId === source) {
      delete item.sourceId
      this.stamp(item)
    }
  }
  private invalidateRelation(state: LearningState, relationId: string, remove: boolean): void {
    for (const material of state.materials) if (material.relationIds.includes(relationId)) {
      if (remove) material.relationIds = material.relationIds.filter((value) => value !== relationId)
      material.confirmedAt = null
      this.stamp(material)
    }
  }
  private replay(state: LearningState, materialId: string, correctedEventId?: string): void {
    const material = this.find(state.materials, materialId)
    let schedule = state.seeds[materialId]
    for (const event of state.events.filter((item) => item.materialId === materialId).sort((a, b) => a.reviewedAt - b.reviewedAt)) {
      schedule = scheduleReview(schedule, event.grade, event.reviewedAt)
      if (event.nextDueAt !== schedule.dueAt && event.id !== correctedEventId) this.stamp(event)
      event.nextDueAt = schedule.dueAt
    }
    material.schedule = schedule
    this.stamp(material)
  }

  mutate(payload: unknown): LearningSnapshot {
    const input: LearningMutation = learningMutationSchema.parse(payload)
    return this.transaction(() => {
      const state = this.read()
      if (input.op === 'review.submit') {
        const previous = state.submissions.find((item) => item.id === input.submissionId)
        if (previous) {
          if (!previous.eventId) throw new Error('此复习记录已删除，旧提交不能恢复。')
          if (!previous.requestHash) throw new Error('此复习记录已纠正，旧提交不能恢复。')
          if (previous.requestHash !== this.submissionHash(input.materialId, input.grade)) throw new Error('同一复习提交标识的内容已变化，请核对后使用新的标识。')
          return this.dto(state)
        }
      }
      this.expected(state, input.expectedRevision)
      if (input.op === 'knowledge.save') {
        if (input.id) {
          const point = this.find(state.knowledge, input.id)
          point.name = input.name
          point.domain = input.domain
          this.stamp(point)
        }
        else state.knowledge.push({ ...this.newIdentity(), name: input.name, domain: input.domain, sourceIds: [] })
      } else if (input.op === 'knowledge.delete') {
        const point = this.find(state.knowledge, input.id)
        for (const material of state.materials.filter((item) => item.knowledgeId === point.id)) this.removeMaterial(state, material.id)
        for (const relation of state.relations.filter((item) => item.fromId === point.id || item.toId === point.id)) this.invalidateRelation(state, relation.id, true)
        state.relations = state.relations.filter((item) => item.fromId !== point.id && item.toId !== point.id)
        state.records = state.records.filter((item) => item.knowledgeId !== point.id)
        state.knowledge = state.knowledge.filter((item) => item.id !== point.id)
        for (const source of point.sourceIds) {
          if (!state.knowledge.some((item) => item.sourceIds.includes(source)) && ![...state.records, ...state.relations, ...state.materials].some((item) => item.sourceId === source)) this.removeSource(state, source)
        }
      } else if (input.op === 'record.save') {
        this.find(state.knowledge, input.record.knowledgeId)
        this.assertSource(state, input.record.sourceId)
        const previous = input.id ? this.find(state.records, input.id) : state.records.find((item) => item.knowledgeId === input.record.knowledgeId && item.kind === input.record.kind)
        if (state.records.some((item) => item.id !== previous?.id && item.knowledgeId === input.record.knowledgeId && item.kind === input.record.kind)) throw new Error('已有此类学习状态，请纠正已有记录。')
        if (previous && previous.knowledgeId !== input.record.knowledgeId) throw new Error('学习记录不能转移到另一个知识点。')
        const updatedAt = Math.max(Date.now(), ...state.records.filter((item) => item.knowledgeId === input.record.knowledgeId && item.kind === input.record.kind).map((item) => item.updatedAt + 1))
        if (previous) {
          const next = { ...input.record, id: previous.id, createdAt: previous.createdAt, updatedAt, revision: previous.revision + 1, origin: 'user-explicit' as const }
          state.records[state.records.indexOf(previous)] = next
        } else state.records.push({ ...input.record, ...this.newIdentity(), updatedAt, origin: 'user-explicit' })
      } else if (input.op === 'record.delete') {
        this.find(state.records, input.id)
        state.records = state.records.filter((item) => item.id !== input.id)
      } else if (input.op === 'relation.save') {
        this.find(state.knowledge, input.fromId)
        this.find(state.knowledge, input.toId)
        this.assertSource(state, input.sourceId)
        if (input.fromId === input.toId) throw new Error('关联需要两个不同的知识点。')
        const previous = input.id ? this.find(state.relations, input.id) : undefined
        const relation = { ...(previous ?? this.newIdentity()), fromId: input.fromId, toId: input.toId, kind: input.kind, sourceId: input.sourceId, note: input.note, origin: input.origin, confirmedAt: null }
        if (previous) {
          this.stamp(relation)
          state.relations[state.relations.indexOf(previous)] = relation
          this.invalidateRelation(state, previous.id, false)
          for (const material of state.materials) {
            if (material.knowledgeId !== relation.fromId && material.knowledgeId !== relation.toId) material.relationIds = material.relationIds.filter((value) => value !== relation.id)
          }
        }
        else state.relations.push(relation)
      } else if (input.op === 'relation.confirm') {
        const relation = this.find(state.relations, input.id)
        relation.confirmedAt = Date.now()
        this.stamp(relation)
      } else if (input.op === 'relation.delete') {
        this.find(state.relations, input.id)
        this.invalidateRelation(state, input.id, true)
        state.relations = state.relations.filter((item) => item.id !== input.id)
      } else if (input.op === 'material.save') {
        this.find(state.knowledge, input.knowledgeId)
        this.assertSource(state, input.sourceId)
        for (const relationId of input.relationIds) {
          const relation = this.find(state.relations, relationId)
          if (relation.fromId !== input.knowledgeId && relation.toId !== input.knowledgeId) throw new Error('题目关联必须连接本知识点。')
        }
        const previous = input.id ? this.find(state.materials, input.id) : undefined
        if (previous && previous.knowledgeId !== input.knowledgeId) throw new Error('有复习历史的题目不能转移知识点。')
        const identity = previous ?? this.newIdentity()
        const material: LearningState['materials'][number] = { ...identity, knowledgeId: input.knowledgeId, question: input.question, answer: input.answer, sourceId: input.sourceId, relationIds: [...new Set(input.relationIds)], origin: input.origin, confirmedAt: null, schedule: previous?.schedule ?? initialReviewState(identity.id), algorithmVersion: REVIEW_ALGORITHM }
        if (previous) {
          this.stamp(material)
          state.materials[state.materials.indexOf(previous)] = material
        }
        else {
          state.materials.push(material)
          state.seeds[material.id] = material.schedule
        }
      } else if (input.op === 'material.confirm') {
        const material = this.find(state.materials, input.id)
        if (material.relationIds.some((value) => !this.find(state.relations, value).confirmedAt)) throw new Error('请先确认题目使用的关联关系。')
        material.confirmedAt = Date.now()
        this.stamp(material)
      } else if (input.op === 'material.delete') {
        this.find(state.materials, input.id)
        this.removeMaterial(state, input.id)
      } else if (input.op === 'review.submit') {
        const material = this.find(state.materials, input.materialId)
        if (!material.confirmedAt || material.relationIds.some((value) => !this.find(state.relations, value).confirmedAt)) throw new Error('复习题目或关联尚未确认。')
        const now = Math.max(Date.now(), ...state.events.filter((item) => item.materialId === material.id).map((item) => item.reviewedAt))
        const materialRevision = material.revision
        material.schedule = scheduleReview(material.schedule, input.grade, now)
        this.stamp(material)
        const event: LearningState['events'][number] = { id: randomUUID(), submissionId: input.submissionId, materialId: material.id, knowledgeId: material.knowledgeId, grade: input.grade, reviewedAt: now, updatedAt: now, revision: 1, nextDueAt: material.schedule.dueAt, materialRevision, ...(material.sourceId ? { sourceId: material.sourceId, sourceRevision: this.find(state.sources, material.sourceId).revision } : {}), algorithmVersion: REVIEW_ALGORITHM }
        state.events.push(event)
        state.submissions.push({ id: input.submissionId, requestHash: this.submissionHash(material.id, input.grade), eventId: event.id })
      } else if (input.op === 'review.correct' || input.op === 'review.delete') {
        const event = this.find(state.events, input.id)
        if (input.op === 'review.correct') {
          event.grade = input.grade
          for (const submission of state.submissions) if (submission.eventId === event.id) submission.requestHash = null
          this.stamp(event)
        }
        else {
          state.events = state.events.filter((item) => item.id !== event.id)
          for (const submission of state.submissions) if (submission.eventId === event.id) {
            submission.eventId = null
            submission.requestHash = null
          }
        }
        this.replay(state, event.materialId, input.op === 'review.correct' ? event.id : undefined)
      } else throw new Error('来源操作必须通过主进程校验。')
      this.save(state)
      return this.dto(state)
    })
  }

  private submissionHash(materialId: string, grade: string): string {
    return createHash('sha256').update(JSON.stringify([materialId, grade])).digest('hex')
  }

  attach(payload: {
    expectedRevision: number
    knowledgeId?: string
    id?: string
    source: StoredLearningSource
  }): LearningSnapshot {
    return this.transaction(() => {
      const state = this.read()
      this.expected(state, payload.expectedRevision)
      const source = storedSourceSchema.parse(payload.source)
      if (payload.id) {
        const previous = this.find(state.sources, payload.id)
        if (previous.workspaceId !== source.workspaceId) throw new Error('来源只能在原项目内重新关联。')
        state.sources[state.sources.indexOf(previous)] = { ...source, id: previous.id, createdAt: previous.createdAt, revision: previous.revision + 1 }
      } else {
        const point = this.find(state.knowledge, payload.knowledgeId ?? '')
        state.sources.push(source)
        point.sourceIds.push(source.id)
        this.stamp(point)
      }
      this.save(state)
      return this.dto(state)
    })
  }

  deleteSource(payload: {
    expectedRevision: number
    id: string
  }): LearningSnapshot {
    return this.transaction(() => {
      const state = this.read()
      this.expected(state, payload.expectedRevision)
      this.find(state.sources, payload.id)
      this.removeSource(state, payload.id)
      this.save(state)
      return this.dto(state)
    })
  }

  importLegacy(payload: {
    expectedRevision: number
    workspaceId: string
    cards: LearningImportCard[]
    reviewIds: string[]
  }): LegacyLearningImportResult {
    return this.transaction(() => {
      const state = this.read()
      this.expected(state, payload.expectedRevision)
      let imported = 0
      let alreadyImported = 0
      for (const card of payload.cards) {
        if (state.imports.some((item) => item.workspaceId === payload.workspaceId && item.legacyId === card.legacyId)) {
          alreadyImported += 1
          continue
        }
        const source = storedSourceSchema.parse(card.source)
        const point = { ...this.newIdentity(), name: card.question.slice(0, 200), domain: '导入闪卡', sourceIds: [source.id] }
        const identity = this.newIdentity()
        const schedule = card.schedule ? { ...scheduleSchema.parse(card.schedule), cardId: identity.id } : initialReviewState(identity.id)
        state.knowledge.push(point)
        state.sources.push(source)
        state.materials.push({ ...identity, knowledgeId: point.id, question: card.question, answer: card.answer, sourceId: source.id, relationIds: [], origin: 'legacy-import', confirmedAt: Date.now(), schedule, algorithmVersion: REVIEW_ALGORITHM })
        state.seeds[identity.id] = schedule
        state.imports.push({ workspaceId: payload.workspaceId, legacyId: card.legacyId, materialId: identity.id })
        imported += 1
      }
      if (imported) this.save(state)
      return { snapshot: this.dto(state), imported, alreadyImported, unmatchedReviewIds: payload.reviewIds.filter((value) => !state.imports.some((item) => item.workspaceId === payload.workspaceId && item.legacyId === value)) }
    })
  }

  due(through: number): {
    revision: number
    materials: LearningSnapshot['materials']
  } {
    const state = this.read()
    return { revision: state.revision, materials: state.materials.filter((item) => item.confirmedAt !== null && item.schedule.dueAt <= through && item.relationIds.every((value) => this.find(state.relations, value).confirmedAt !== null)).sort((a, b) => a.schedule.dueAt - b.schedule.dueAt || a.id.localeCompare(b.id)) }
  }

  recall(query: string, budget: number, ids?: string[]): string {
    const state = this.read()
    const tokens = memoryTokens(query).filter((token) => [...token].length > 1).slice(0, 32)
    if (!tokens.length && !ids?.length) return ''
    const points = state.knowledge.map((point) => ({ point, tokens: memoryTokens(point.name + ' ' + point.domain) }))
      .map((entry) => ({ ...entry, score: tokens.filter((token) => entry.tokens.includes(token)).length }))
      .filter((entry) => ids ? ids.includes(entry.point.id) : entry.score > 0).sort((a, b) => b.score - a.score || b.point.updatedAt - a.point.updatedAt).slice(0, 6)
    const selected: unknown[] = []
    for (const { point } of points) {
      const latest = (kind: LearningRecord['kind']) => state.records.filter((item) => item.knowledgeId === point.id && item.kind === kind).reverse().sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const records = ['interest', 'stage', 'self-assessment'].map((kind) => latest(kind as LearningRecord['kind'])).filter((item) => !!item)
      const reviews = state.events.filter((item) => item.knowledgeId === point.id && item.reviewedAt >= Date.now() - 30 * 86_400_000).reverse().sort((a, b) => b.reviewedAt - a.reviewedAt).slice(0, 3)
      if (!records.length && !reviews.length) continue
      // External text, questions, answers and absolute paths never enter recall.
      const evidenceSourceIds = [...new Set([...records.map((item) => item?.sourceId), ...reviews.map((item) => item.sourceId)].filter((value) => !!value))]
      const value = {
        knowledgeId: point.id,
        name: point.name,
        domain: point.domain,
        userStatements: records.map((item) => ({
          kind: item!.kind, value: item!.value, origin: item!.origin,
          sourceId: item!.sourceId ?? null, recordedAt: item!.updatedAt, revision: item!.revision
        })),
        reviewEvidenceWindowDays: 30,
        recentReviewEvidence: reviews.map(({ id, grade, reviewedAt, revision, materialRevision, sourceId, sourceRevision, algorithmVersion }) => ({
          id, grade, reviewedAt, revision, materialRevision, sourceId, sourceRevision, algorithmVersion
        })),
        evidenceSources: evidenceSourceIds.map((id) => {
          const source = state.sources.find((item) => item.id === id)!
          return {
            id: source.id, kind: source.kind, projectName: source.projectName,
            locator: source.path ?? source.referenceId ?? null, sourceRevision: source.revision, availability: 'not-checked'
          }
        })
      }
      if (JSON.stringify([...selected, value]).length <= budget) selected.push(value)
    }
    return selected.length ? JSON.stringify(selected) : ''
  }
}
