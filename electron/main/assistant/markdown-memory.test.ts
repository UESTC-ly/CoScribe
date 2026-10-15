import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MemorySearchResult, PersonalMemorySnapshot } from '../../../src/shared/assistant'
import type { AssistantDatabase } from './database'
import { memoryHash, memoryMarkdown } from './markdown-store'

const sqlite = await import('node:sqlite').catch(() => null)
const DatabaseClass = sqlite ? (await import('./database')).AssistantDatabase : null
const DatabaseSync = sqlite?.DatabaseSync as typeof import('node:sqlite').DatabaseSync

let directory: string
let filePath: string
let database: AssistantDatabase | undefined
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'coscribe-markdown-'))
  filePath = path.join(directory, 'assistant.sqlite')
  database = new DatabaseClass!(filePath)
})
afterEach(() => { database?.close(); rmSync(directory, { recursive: true, force: true }) })
const snapshot = (): PersonalMemorySnapshot => database!.snapshot()
const remember = (text: string) => (database!.execute('remember', { category: 'goal', text }) as PersonalMemorySnapshot).items[0]
const file = (id: string) => path.join(directory, 'memory', id + '.md')
function close(): void { database!.close(); database = undefined }
function enable(remote = false): void {
  database!.execute('policy', { enabled: true, allowRemote: remote, expectedRevision: snapshot().policy.revision })
}
function search(query: string, options: Record<string, unknown> = {}): MemorySearchResult {
  return database!.execute('memory-search', { query, limit: 5, remote: false, expectedRevision: snapshot().policy.revision, ...options }) as MemorySearchResult
}
function downgrade(): void {
  close()
  const control = new DatabaseSync(filePath)
  control.exec(`
    DROP TRIGGER memory_markdown_insert; DROP TRIGGER memory_markdown_update; DROP TRIGGER memory_markdown_delete;
    DROP TABLE memory_files; DROP TABLE memory_file_outbox; DROP TABLE memory_vectors;
    DROP TABLE memory_search_policy; DROP TABLE memory_answer_origins; DROP TABLE memory_answer_pending; PRAGMA user_version=3;
  `)
  control.close()
  rmSync(path.join(directory, 'memory'), { recursive: true })
}

describe.skipIf(!sqlite)('canonical Markdown personal memory (requires node:sqlite)', () => {
  it('writes confirmed facts, preserves stable IDs on correction, and removes files on forget through restart', () => {
    const item = remember('学习检索增强生成')
    expect(readFileSync(file(item.id), 'utf8')).toBe(memoryMarkdown(item.id, item.text))
    database!.execute('update', { id: item.id, expectedRevision: 1, category: 'goal', text: '学习 RAG 和检索评估' })
    close(); database = new DatabaseClass!(filePath)
    expect(snapshot().items[0]).toMatchObject({ id: item.id, revision: 2, text: '学习 RAG 和检索评估' })
    expect(readFileSync(file(item.id), 'utf8')).toContain('检索评估')
    database!.execute('forget', { id: item.id, expectedRevision: 2 })
    expect(readdirSync(path.join(directory, 'memory'))).not.toContain(item.id + '.md')
    close(); database = new DatabaseClass!(filePath)
    expect(snapshot().items).toEqual([])
  })

  it('synchronizes manual edits before queries and rejects stale item versions', () => {
    const item = remember('准备钢琴演出')
    enable()
    const oldRevision = snapshot().policy.revision
    writeFileSync(file(item.id), memoryMarkdown(item.id, '学习检索增强生成'))
    expect(snapshot().items[0]).toMatchObject({ id: item.id, revision: 2, text: '学习检索增强生成', source: { origin: 'memory-file' } })
    expect(snapshot().policy.revision).toBeGreaterThan(oldRevision)
    expect(search('RAG').hits[0]?.id).toBe(item.id)
    expect(search('钢琴').hits).toEqual([])
    expect(() => database!.execute('memory-read', { items: [{ kind: 'memory', id: item.id, revision: 1 }], remote: false, expectedRevision: snapshot().policy.revision })).toThrow('已修改或遗忘')
  })

  it('treats an absent known file as deletion and never adopts an unknown file as a user fact', () => {
    const item = remember('学习被删除的目标')
    const untrusted = '11111111-1111-4111-8111-111111111111'
    writeFileSync(file(untrusted), memoryMarkdown(untrusted, '邮件推断我是教授'))
    unlinkSync(file(item.id))
    expect(snapshot().items).toEqual([])
    expect(readFileSync(file(untrusted), 'utf8')).toContain('邮件推断')
    close(); database = new DatabaseClass!(filePath)
    expect(snapshot().items).toEqual([])
  })

  it('reports invalid Markdown and preserves it instead of emptying or overwriting it', () => {
    const item = remember('原有事实')
    writeFileSync(file(item.id), '# unrelated replacement')
    expect(() => snapshot()).toThrow('标识损坏')
    expect(readFileSync(file(item.id), 'utf8')).toBe('# unrelated replacement')
    writeFileSync(file(item.id), memoryMarkdown(item.id, item.text))
    expect(snapshot().items[0].text).toBe(item.text)
  })

  it('does not use the database body cache when its canonical file identity is lost', () => {
    const item = remember('不能回退为数据库正文')
    const control = new DatabaseSync(filePath)
    control.prepare('DELETE FROM memory_files WHERE id=?').run(item.id)
    control.close()
    expect(() => snapshot()).toThrow('身份不一致')
    expect(readFileSync(file(item.id), 'utf8')).toContain(item.text)
  })

  it('refuses a symbolic link without reading or writing its target', () => {
    const item = remember('受保护的正文')
    const outside = path.join(directory, 'outside.md')
    writeFileSync(outside, 'OUTSIDE_SENTINEL')
    unlinkSync(file(item.id)); symlinkSync(outside, file(item.id))
    expect(() => snapshot()).toThrow('无效')
    expect(readFileSync(outside, 'utf8')).toBe('OUTSIDE_SENTINEL')
  })

  it('migrates schema 3 with a consistent backup, keeping identity, provenance and revisions', () => {
    const item = remember('迁移前的用户目标')
    database!.execute('update', { id: item.id, expectedRevision: 1, category: 'goal', text: '迁移前修订' })
    const before = snapshot()
    downgrade()
    database = new DatabaseClass!(filePath)
    expect(snapshot().items).toEqual(before.items)
    expect(snapshot().policy).toEqual(before.policy)
    expect(readFileSync(file(item.id), 'utf8')).toBe(memoryMarkdown(item.id, '迁移前修订'))
    const backup = readdirSync(directory).find((name) => name.startsWith('assistant.sqlite.v3-'))!
    const original = new DatabaseSync(path.join(directory, backup), { readOnly: true })
    expect(original.prepare('PRAGMA user_version').get()?.user_version).toBe(3)
    expect(original.prepare('SELECT revision,text FROM memories').get()).toMatchObject({ revision: 2, text: '迁移前修订' })
    original.close()
  })

  it.each([false, true])('recovers an interrupted write with the file already committed=%s', (alreadyWritten) => {
    const item = remember('旧正文')
    close()
    const control = new DatabaseSync(filePath)
    control.prepare('UPDATE memories SET text=?,revision=revision+1 WHERE id=?').run('已提交的新正文', item.id)
    control.close()
    if (alreadyWritten) writeFileSync(file(item.id), memoryMarkdown(item.id, '已提交的新正文'))
    database = new DatabaseClass!(filePath)
    expect(snapshot().items[0]).toMatchObject({ text: '已提交的新正文', revision: 2 })
    expect(readFileSync(file(item.id), 'utf8')).toBe(memoryMarkdown(item.id, '已提交的新正文'))
    const check = new DatabaseSync(filePath)
    expect(check.prepare('SELECT count(*) n FROM memory_file_outbox').get()?.n).toBe(0)
    check.close()
  })

  it('preserves an external edit that conflicts with an interrupted database write', () => {
    const item = remember('原始正文')
    close()
    const control = new DatabaseSync(filePath)
    control.prepare('UPDATE memories SET text=? WHERE id=?').run('待写入正文', item.id)
    control.close()
    writeFileSync(file(item.id), memoryMarkdown(item.id, '外部修改必须保留'))
    expect(() => { database = new DatabaseClass!(filePath) }).toThrow('冲突')
    expect(readFileSync(file(item.id), 'utf8')).toContain('外部修改必须保留')
    const check = new DatabaseSync(filePath)
    expect(check.prepare('SELECT count(*) n FROM memory_file_outbox').get()?.n).toBe(1)
    check.close()
  })

  it('rebuilds only derived indexes from Markdown and keeps IDs and metadata', () => {
    const item = remember('学习检索增强生成')
    enable()
    const control = new DatabaseSync(filePath)
    control.exec('DELETE FROM memory_fts')
    control.close()
    expect(search('RAG').hits).toEqual([])
    database!.execute('rebuild-index', { expectedRevision: snapshot().policy.revision })
    expect(search('RAG').hits[0]).toMatchObject({ id: item.id, revision: item.revision })
    expect(snapshot().items[0]).toEqual(item)
  })

  it('returns bounded summaries first and current full bodies only after an authorized versioned read', () => {
    const item = remember('学习 RAG ' + '详细目标'.repeat(90))
    expect(search('RAG')).toMatchObject({ status: 'disabled', hits: [] })
    enable()
    expect(search('RAG', { remote: true })).toMatchObject({ status: 'remote-blocked', hits: [] })
    const hit = search('RAG').hits[0]
    expect(hit.summary.length).toBe(180)
    const input = { items: [{ kind: hit.kind, id: hit.id, revision: hit.revision }], remote: false, expectedRevision: snapshot().policy.revision }
    expect(database!.execute('memory-read', input)).toMatchObject({ status: 'used', items: [{ text: item.text, source: { kind: 'user-explicit' } }] })
    const generation = input.expectedRevision
    enable(true)
    expect(() => database!.execute('memory-read', { ...input, expectedRevision: generation })).toThrow('授权已变化')
    database!.execute('policy', { enabled: false, allowRemote: false, expectedRevision: snapshot().policy.revision })
    expect(database!.execute('memory-read', { ...input, expectedRevision: snapshot().policy.revision })).toMatchObject({ status: 'disabled', items: [] })
  })

  it('persists semantic candidates, combines lexical evidence, and invalidates changed bodies', () => {
    const item = remember('提高并发程序的执行效率')
    enable()
    const base = { remote: false, expectedRevision: snapshot().policy.revision, identity: 'test-embedding-v1' }
    const corpus = database!.execute('embedding-corpus', base) as Array<{ id: string; text: string; textHash: string }>
    expect(corpus[0]).toEqual({ id: item.id, text: item.text, textHash: memoryHash(item.text) })
    database!.execute('embedding-save', { ...base, items: [{ id: item.id, textHash: corpus[0].textHash, vector: [1, 0] }] })
    close(); database = new DatabaseClass!(filePath)
    expect(search('多线程性能', { identity: base.identity, vector: [1, 0] }).hits[0]?.id).toBe(item.id)
    expect(search('多线程性能', { identity: 'other-model', vector: [1, 0] }).hits).toEqual([])
    expect(search('并发', { identity: base.identity, vector: [0, 1] }).hits[0]?.id).toBe(item.id)
    database!.execute('update', { id: item.id, expectedRevision: 1, category: 'goal', text: '准备钢琴演出' })
    expect(search('多线程性能', { identity: base.identity, vector: [1, 0] }).hits).toEqual([])
    expect(() => database!.execute('embedding-save', { ...base, expectedRevision: snapshot().policy.revision, items: [{ id: item.id, textHash: corpus[0].textHash, vector: [1, 0] }] })).toThrow('建立向量时变化')
  })

  it('remembers affected answer hashes through restart and isolates sessions without retaining prose', () => {
    remember('个人事实')
    enable()
    const revision = snapshot().policy.revision
    const hash = memoryHash('旧回答')
    database!.execute('answer-record', { sessionId: 'session-a', hash, revision })
    expect(database!.execute('answer-stale', { sessionId: 'session-a', revision })).toEqual([])
    expect(database!.execute('answer-stale', { sessionId: 'session-a', revision, all: true })).toEqual([hash])
    remember('新增用户目标')
    close(); database = new DatabaseClass!(filePath)
    expect(database!.execute('answer-stale', { sessionId: 'session-a', revision: snapshot().policy.revision })).toEqual([hash])
    expect(database!.execute('answer-stale', { sessionId: 'session-b', revision })).toEqual([])
  })

  it('fails closed on an interrupted answer reservation after correction, and resolves it by recording partial text', () => {
    remember('会被纠正的事实')
    enable()
    const revision = snapshot().policy.revision
    database!.execute('answer-begin', { sessionId: 'session-a', requestId: 'request-a', revision })
    expect(database!.execute('answer-stale', { sessionId: 'session-a', revision })).toEqual([])
    remember('新目标')
    close(); database = new DatabaseClass!(filePath)
    expect(database!.execute('answer-stale', { sessionId: 'session-a', revision: snapshot().policy.revision })).toEqual(['*'])
    const hash = memoryHash('部分回答')
    database!.execute('answer-record', { sessionId: 'session-a', requestId: 'request-a', revision, hash })
    expect(database!.execute('answer-stale', { sessionId: 'session-a', revision: snapshot().policy.revision })).toEqual([hash])
  })

  it('checks history authorization without loading additional memories', () => {
    remember('不能发给未授权的服务')
    enable()
    expect(database!.execute('history-access', { remote: true })).toMatchObject({ prompt: '', status: 'remote-blocked' })
    expect(database!.execute('history-access', { remote: false })).toMatchObject({ prompt: '', status: 'empty', revision: snapshot().policy.revision })
  })
})
