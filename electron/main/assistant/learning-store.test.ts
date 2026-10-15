import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { LearningMutation, LearningSnapshot, LegacyLearningImportResult } from '../../../src/shared/learning'
import type { AssistantDatabase } from './database'
import type { AssistantCommand } from './contract'
import { REVIEW_ALGORITHM } from './learning-store'

const sqlite = await import('node:sqlite').catch(() => null)
const DatabaseClass = sqlite ? (await import('./database')).AssistantDatabase : null
const DatabaseSync = sqlite?.DatabaseSync as typeof import('node:sqlite').DatabaseSync

let directory: string
let file: string
let database: AssistantDatabase
const snapshot = (): LearningSnapshot => database.execute('learning-list') as LearningSnapshot
function mutate(input: Omit<LearningMutation, 'expectedRevision'> | Record<string, unknown>, expectedRevision = snapshot().revision): LearningSnapshot {
  return database.execute('learning-mutate', { ...input, expectedRevision }) as LearningSnapshot
}
function point(name = '图论'): string { return mutate({ op: 'knowledge.save', name, domain: '算法' }).knowledge.at(-1)!.id }
function material(knowledgeId: string, relationIds: string[] = []): string {
  const value = mutate({ op: 'material.save', knowledgeId, question: '怎样求最短路径？', answer: '使用 Dijkstra', relationIds, origin: 'model' }).materials.at(-1)!.id
  mutate({ op: 'material.confirm', id: value })
  return value
}
function recall(query = '图论', remote = false): {
  prompt: string
  revision: number
} {
  return database.execute('recall', { query, remote }) as {
    prompt: string
    revision: number
  }
}
function enable(allowRemote = false): void { database.execute('policy', { enabled: true, allowRemote, expectedRevision: database.snapshot().policy.revision }) }
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'coscribe-learning-'))
  file = path.join(directory, 'assistant.sqlite')
  database = new DatabaseClass!(file)
})
afterEach(() => {
  database?.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

describe.skipIf(!sqlite)('global learning state and review transactions', () => {
  it('persists stable IDs, distinct self-statements and review evidence across restart', () => {
    const knowledgeId = point()
    mutate({ op: 'record.save', record: { knowledgeId, kind: 'interest', value: 'following', note: '技术关注' } })
    mutate({ op: 'record.save', record: { knowledgeId, kind: 'stage', value: 'learned', note: '学过这章' } })
    mutate({ op: 'record.save', record: { knowledgeId, kind: 'self-assessment', value: 'confident', note: '用户自评' } })
    const cardId = material(knowledgeId)
    const reviewed = mutate({ op: 'review.submit', materialId: cardId, grade: 'good', submissionId: randomUUID() })
    expect(reviewed.events[0]).toMatchObject({ knowledgeId, materialId: cardId, grade: 'good', algorithmVersion: REVIEW_ALGORITHM })
    expect(reviewed.materials[0].schedule).toMatchObject({ cardId, intervalDays: 1, repetitions: 1 })
    mutate({ op: 'knowledge.save', id: knowledgeId, name: '最短路径图算法', domain: '计算机' })
    const saved = snapshot()
    database.close()
    database = new DatabaseClass!(file)
    expect(snapshot()).toEqual(saved)
    expect(snapshot().records.map((item) => item.kind)).toEqual(['interest', 'stage', 'self-assessment'])
  })

  it('requires confirmation of model relations and materials, never propagating mastery', () => {
    const fromId = point()
    const toId = point('矩阵乘法')
    const relation = mutate({ op: 'relation.save', fromId, toId, kind: 'prerequisite', note: '需要核对', origin: 'model' }).relations[0]
    const pending = mutate({ op: 'material.save', knowledgeId: fromId, question: '应用题', answer: '参考答案', relationIds: [relation.id], origin: 'model' }).materials[0]
    expect((database.execute('learning-due', Date.now()) as { materials: unknown[] }).materials).toEqual([])
    expect(() => mutate({ op: 'material.confirm', id: pending.id })).toThrow('先确认')
    expect(() => mutate({ op: 'review.submit', materialId: pending.id, grade: 'easy', submissionId: randomUUID() })).toThrow('尚未确认')
    mutate({ op: 'relation.confirm', id: relation.id })
    mutate({ op: 'material.confirm', id: pending.id })
    mutate({ op: 'review.submit', materialId: pending.id, grade: 'easy', submissionId: randomUUID() })
    expect(snapshot().records).toEqual([])
    expect(snapshot().events.map((item) => item.knowledgeId)).toEqual([fromId])
    enable()
    expect(recall('矩阵乘法').prompt).toBe('')
    mutate({ op: 'relation.save', id: relation.id, fromId, toId, kind: 'contrast', note: '修正', origin: 'user' })
    expect(snapshot().materials[0].confirmedAt).toBeNull()
    expect(snapshot().materials[0].schedule.repetitions).toBe(1)
  })

  it('deduplicates identical feedback before version checks, rejects changed and competing submissions', () => {
    const cardId = material(point())
    const input = { op: 'review.submit', materialId: cardId, grade: 'good', submissionId: randomUUID() }
    const version = snapshot().revision
    const first = mutate(input, version)
    expect(mutate(input, version)).toEqual(first)
    expect(() => mutate({ ...input, grade: 'easy' }, version)).toThrow('内容已变化')
    expect(() => mutate({ ...input, submissionId: randomUUID() }, version)).toThrow('学习库已变化')
    expect(snapshot().events).toHaveLength(1)
    database.close()
    database = new DatabaseClass!(file)
    expect(mutate(input, version)).toEqual(first)
  })

  it('corrects or deletes evidence immediately and rebuilds the schedule without restoring deleted submissions', () => {
    const cardId = material(point())
    const input = { op: 'review.submit', materialId: cardId, grade: 'easy', submissionId: randomUUID() }
    const first = mutate(input)
    enable()
    expect(recall().prompt).toContain('easy')
    mutate({ op: 'review.correct', id: first.events[0].id, grade: 'again' })
    expect(snapshot().materials[0].schedule.repetitions).toBe(0)
    expect(recall().prompt).toContain('again')
    expect(recall().prompt).not.toContain('easy')
    mutate({ op: 'review.delete', id: first.events[0].id })
    expect(snapshot().materials[0].schedule.lastReviewedAt).toBeUndefined()
    expect(recall().prompt).toBe('')
    expect(() => mutate(input)).toThrow('旧提交不能恢复')
  })

  it('keeps correction/removal out of recall, including old user notes and remote-blocked requests', () => {
    const knowledgeId = point()
    const record = mutate({ op: 'record.save', record: { knowledgeId, kind: 'self-assessment', value: 'confident', note: 'PRIVATE_OLD' } }).records[0]
    expect(recall().prompt).toBe('')
    enable()
    expect(recall().prompt).toContain('confident')
    expect(recall('图论', true).prompt).toBe('')
    mutate({ op: 'record.save', id: record.id, record: { knowledgeId, kind: 'self-assessment', value: 'needs-practice', note: 'PRIVATE_NEW' } })
    expect(recall().prompt).toContain('needs-practice')
    expect(recall().prompt).not.toContain('confident')
    mutate({ op: 'record.delete', id: record.id })
    expect(recall().prompt).toBe('')
    enable(true)
    expect(recall('图论', true).prompt).toBe('')
    const control = new DatabaseSync(file)
    expect(String(control.prepare('SELECT payload FROM learning_state').get()!.payload)).not.toMatch(/PRIVATE_(OLD|NEW)/u)
    control.close()
  })

  it('does not admit forged origins, model mastery, times, unrelated associations or absent references', () => {
    const knowledgeId = point()
    const other = point('其他')
    for (const record of [
      { knowledgeId, kind: 'self-assessment', value: 'confident', note: '', origin: 'model' },
      { knowledgeId, kind: 'model-score', value: 'mastered', note: '' },
      { knowledgeId: randomUUID(), kind: 'stage', value: 'learned', note: '' }
    ]) expect(() => mutate({ op: 'record.save', record })).toThrow()
    const relationId = mutate({ op: 'relation.save', fromId: knowledgeId, toId: other, kind: 'contrast', note: '', origin: 'user' }).relations[0].id
    expect(() => mutate({ op: 'relation.save', fromId: knowledgeId, toId: knowledgeId, kind: 'contrast', note: '', origin: 'user' })).toThrow('不同')
    expect(() => mutate({ op: 'material.save', knowledgeId: point('无关'), question: 'Q', answer: 'A', relationIds: [relationId], origin: 'user' })).toThrow('必须连接')
    const cardId = material(knowledgeId)
    expect(() => mutate({ op: 'review.submit', materialId: cardId, grade: 'good', submissionId: randomUUID(), reviewedAt: 1 })).toThrow()
  })

  it('uses one transaction for feedback, schedule and recall generation, rolling back failures', () => {
    const cardId = material(point())
    const before = snapshot()
    const policy = database.snapshot().policy
    const control = new DatabaseSync(file)
    control.exec("CREATE TRIGGER reject_learning BEFORE UPDATE ON learning_state BEGIN SELECT RAISE(ABORT, 'TEST_FAILURE'); END")
    expect(() => mutate({ op: 'review.submit', materialId: cardId, grade: 'good', submissionId: randomUUID() })).toThrow('TEST_FAILURE')
    expect(snapshot()).toEqual(before)
    expect(database.snapshot().policy).toEqual(policy)
    control.close()
  })

  it('purges a knowledge point and dependent evidence without changing neighboring self-assessments', () => {
    const fromId = point()
    const toId = point('矩阵')
    mutate({ op: 'record.save', record: { knowledgeId: toId, kind: 'self-assessment', value: 'needs-practice', note: '独立' } })
    const relationId = mutate({ op: 'relation.save', fromId, toId, kind: 'application', origin: 'user', note: '' }).relations[0].id
    mutate({ op: 'relation.confirm', id: relationId })
    material(fromId, [relationId])
    material(toId, [relationId])
    mutate({ op: 'knowledge.delete', id: fromId })
    expect(snapshot().relations).toEqual([])
    expect(snapshot().materials).toHaveLength(1)
    expect(snapshot().materials[0].confirmedAt).toBeNull()
    expect(snapshot().records[0].value).toBe('needs-practice')
  })

  it('imports old schedules once, preserves seeds without inventing review events, and reports orphans', () => {
    const source = { id: randomUUID(), kind: 'note', path: '原笔记.md', line: 1, workspace: '/tmp/a', workspaceId: 'a'.repeat(64), projectName: 'A', fingerprint: 'b'.repeat(64), createdAt: Date.now(), updatedAt: Date.now(), revision: 1 }
    const input = { expectedRevision: 0, workspaceId: source.workspaceId, cards: [{ legacyId: 'card-old', question: 'Q', answer: 'A', source, schedule: { cardId: 'card-old', dueAt: 123_000, intervalDays: 6, ease: 2.3, repetitions: 2, lastReviewedAt: 100_000 } }], reviewIds: ['card-old', 'card-orphan'] }
    const first = database.execute('learning-import', input) as LegacyLearningImportResult
    expect(first).toMatchObject({ imported: 1, unmatchedReviewIds: ['card-orphan'] })
    expect(first.snapshot.events).toEqual([])
    expect(first.snapshot.materials[0].schedule).toMatchObject({ dueAt: 123_000, ease: 2.3, repetitions: 2 })
    const cardId = first.snapshot.materials[0].id
    mutate({ op: 'review.submit', materialId: cardId, grade: 'good', submissionId: randomUUID() })
    mutate({ op: 'review.delete', id: snapshot().events[0].id })
    expect(snapshot().materials[0].schedule.repetitions).toBe(2)
    const second = database.execute('learning-import', { ...input, expectedRevision: snapshot().revision }) as LegacyLearningImportResult
    expect(second.imported).toBe(0)
    expect(second.alreadyImported).toBe(1)
    mutate({ op: 'material.delete', id: cardId })
    expect((database.execute('learning-import', { ...input, expectedRevision: snapshot().revision }) as LegacyLearningImportResult).imported).toBe(0)
  })

  it('backs up schema v2 including committed data and preserves memories during migration', () => {
    database.execute('remember', { category: 'goal', text: '迁移保留' })
    database.close()
    const control = new DatabaseSync(file)
    control.exec(`DROP TABLE learning_state;
      DROP TRIGGER memory_markdown_insert; DROP TRIGGER memory_markdown_update; DROP TRIGGER memory_markdown_delete;
      DROP TABLE memory_files; DROP TABLE memory_file_outbox; DROP TABLE memory_vectors; DROP TABLE memory_search_policy; DROP TABLE memory_answer_origins; DROP TABLE memory_answer_pending;
      PRAGMA user_version=2`)
    rmSync(path.join(directory, 'memory'), { recursive: true })
    control.close()
    database = new DatabaseClass!(file)
    expect(database.snapshot().items[0].text).toBe('迁移保留')
    expect(snapshot().knowledge).toEqual([])
    const backups = readdirSync(directory).filter((name) => name.includes('.v2-'))
    expect(backups).toHaveLength(1)
    const backup = new DatabaseSync(path.join(directory, backups[0]))
    expect(backup.prepare('PRAGMA user_version').get()!.user_version).toBe(2)
    expect(backup.prepare('SELECT text FROM memories').get()!.text).toBe('迁移保留')
    backup.close()
  })

  it('fails closed on corrupt learning JSON and dangling relationships without clearing them', () => {
    const knowledgeId = point()
    const control = new DatabaseSync(file)
    control.prepare('UPDATE learning_state SET payload=?').run('{PRIVATE_BROKEN')
    expect(() => snapshot()).toThrow('原数据已保留')
    expect(control.prepare('SELECT payload FROM learning_state').get()!.payload).toBe('{PRIVATE_BROKEN')
    control.close()
    database.close()
    const before = readFileSync(file)
    expect(() => new DatabaseClass!(file)).toThrow('原数据已保留')
    expect(readFileSync(file)).toEqual(before)
    // Reopening errors do not replace the already closed test handle.
    database = { close: () => undefined } as AssistantDatabase
    expect(knowledgeId).toBeTruthy()
  })

  it('keeps recall under budget and excludes unrelated material and sources', () => {
    const knowledgeId = point()
    mutate({ op: 'record.save', record: { knowledgeId, kind: 'stage', value: 'learning', note: 'EXTERNAL_QUOTE' } })
    material(knowledgeId)
    point('钢琴')
    for (let i = 0; i < 4; i++) database.execute('remember', { category: 'preference', text: '偏好 ' + i + 'x'.repeat(900) })
    enable()
    expect(recall().prompt.length).toBeLessThan(4_600)
    expect(recall().prompt).toContain('learning')
    expect(recall().prompt).not.toMatch(/EXTERNAL_QUOTE|Dijkstra|钢琴/u)
  })
  it('replaces the current same-kind statement and never recalls an earlier assessment after deletion', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'))
    const knowledgeId = point()
    const first = mutate({ op: 'record.save', record: { knowledgeId, kind: 'self-assessment', value: 'confident', note: 'OLD' } }).records[0]
    const corrected = mutate({ op: 'record.save', record: { knowledgeId, kind: 'self-assessment', value: 'needs-practice', note: 'NEW' } })
    expect(corrected.records).toHaveLength(1)
    expect(corrected.records[0]).toMatchObject({ id: first.id, revision: 2, value: 'needs-practice' })
    enable()
    expect(recall().prompt).not.toContain('confident')
    mutate({ op: 'record.delete', id: first.id })
    expect(recall().prompt).toBe('')
  })

  it('retains material identity/history when wording changes and invalidates confirmation', () => {
    const knowledgeId = point()
    const cardId = material(knowledgeId)
    mutate({ op: 'review.submit', materialId: cardId, grade: 'good', submissionId: randomUUID() })
    const before = snapshot()
    mutate({ op: 'material.save', id: cardId, knowledgeId, question: '改写措辞', answer: '新答案', relationIds: [], origin: 'user' })
    expect(snapshot().materials[0].id).toBe(cardId)
    expect(snapshot().materials[0].schedule).toEqual(before.materials[0].schedule)
    expect(snapshot().events).toEqual(before.events)
    expect(snapshot().materials[0].confirmedAt).toBeNull()
    expect((database.execute('learning-due', Date.now() + 86_400_000) as { materials: unknown[] }).materials).toEqual([])
  })

  it('limits recent evidence to 30 days and purges old feedback payloads when corrected or deleted', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'))
    const cardId = material(point())
    const input = { op: 'review.submit', materialId: cardId, grade: 'easy', submissionId: randomUUID() }
    const event = mutate(input).events[0]
    enable()
    vi.setSystemTime(new Date('2026-10-07T00:00:00Z'))
    expect(recall().prompt).toBe('')
    mutate({ op: 'review.correct', id: event.id, grade: 'hard' })
    expect(() => mutate(input)).toThrow('已纠正')
    mutate({ op: 'review.delete', id: event.id })
    const control = new DatabaseSync(file)
    const stored = JSON.parse(String(control.prepare('SELECT payload FROM learning_state').get()!.payload))
    expect(stored.submissions).toEqual([{ id: input.submissionId, eventId: null, requestHash: null }])
    control.close()
  })

  it('detects structurally valid JSON with dangling knowledge/evidence relationships', () => {
    const knowledgeId = point()
    mutate({ op: 'record.save', record: { knowledgeId, kind: 'interest', value: 'following', note: '' } })
    const control = new DatabaseSync(file)
    const state = JSON.parse(String(control.prepare('SELECT payload FROM learning_state').get()!.payload))
    state.records[0].knowledgeId = randomUUID()
    control.prepare('UPDATE learning_state SET payload=?').run(JSON.stringify(state))
    expect(() => snapshot()).toThrow('数据损坏')
    expect(JSON.parse(String(control.prepare('SELECT payload FROM learning_state').get()!.payload))).toEqual(state)
    control.close()
  })

})
