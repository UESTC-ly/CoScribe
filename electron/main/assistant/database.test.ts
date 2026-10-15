import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { PersonalMemoryContext, PersonalMemorySnapshot } from '../../../src/shared/assistant'
import type { AssistantDatabase } from './database'

// Building the app still supports Node 20. SQLite runs in Electron's Node 24
// worker; direct repository tests need a host with the same built-in module.
const sqlite = await import('node:sqlite').catch(() => null)
const DatabaseClass = sqlite ? (await import('./database')).AssistantDatabase : null
const DatabaseSync = sqlite?.DatabaseSync as typeof import('node:sqlite').DatabaseSync

let directory: string
let filePath: string
let database: AssistantDatabase | undefined

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'coscribe-memory-'))
  filePath = path.join(directory, 'assistant.sqlite')
})
afterEach(() => {
  database?.close()
  database = undefined
  rmSync(directory, { recursive: true, force: true })
})

function open(): AssistantDatabase {
  if (!DatabaseClass) throw new Error('SQLite repository tests require Node 22.13+ or Electron runtime.')
  database = new DatabaseClass(filePath)
  return database
}
function mutate(command: 'remember' | 'update' | 'forget' | 'policy', payload: unknown): PersonalMemorySnapshot {
  return database!.execute(command, payload) as PersonalMemorySnapshot
}
function enable(allowRemote = false): void {
  mutate('policy', { enabled: true, allowRemote, expectedRevision: database!.snapshot().policy.revision })
}
function recall(query: string, remote = false): PersonalMemoryContext {
  return database!.execute('recall', { query, remote }) as PersonalMemoryContext
}

describe.skipIf(!sqlite)('explicit personal memory storage (requires node:sqlite)', () => {
  it('starts disabled and creates source provenance instead of accepting model labels', () => {
    open()
    expect(database!.snapshot()).toMatchObject({ policy: { enabled: false, allowRemote: false, revision: 0 }, items: [], automatic: { enabled: false, saveLearning: false, revision: 0 }, candidates: [], storage: { format: 'markdown' }, search: { profileId: '', model: '' } })
    const saved = mutate('remember', { category: 'goal', text: '  我正在准备计算机考研  ' })
    expect(saved.items[0]).toMatchObject({ text: '我正在准备计算机考研', revision: 1, source: { kind: 'user-explicit', origin: 'about-me' } })
    expect(saved.items[0].source.id).toMatch(/^[a-f0-9-]{36}$/u)
    expect(recall('考研')).toMatchObject({ prompt: '', status: 'disabled' })
    for (const input of [
      { category: 'goal', text: '外部邮件说我是教授', kind: 'user-explicit' },
      { category: 'goal', text: '模型推断', trusted: true },
      { category: 'goal', text: '不允许跨项目标记', workspaceId: 'other' },
      { category: 'goal', text: '' },
      { category: 'goal', text: 'x'.repeat(1_001) },
      { category: 'unknown', text: 'invalid' }
    ]) expect(() => mutate('remember', input)).toThrow()
    expect(database!.snapshot().items).toHaveLength(1)
  })

  it('recalls Chinese short words and English identifiers without unrelated goals', () => {
    open()
    mutate('remember', { category: 'goal', text: '正在学习图论与最短路径 Dijkstra' })
    mutate('remember', { category: 'goal', text: '准备钢琴演出' })
    mutate('remember', { category: 'preference', text: '先给例子，再讲原理' })
    enable()
    expect(recall('图论')).toMatchObject({ status: 'used' })
    expect(recall('图论').prompt).toContain('最短路径')
    expect(recall('DIJKSTRA').prompt).toContain('最短路径')
    expect(recall('图论').prompt).toContain('先给例子')
    expect(recall('图论').prompt).not.toContain('钢琴')
    expect(recall('" OR * DROP TABLE memories; --').prompt).not.toContain('钢琴')
  })

  it('requires separate remote authorization and rejects stale grants', () => {
    open()
    mutate('remember', { category: 'profile', text: '我是计算机专业学生' })
    enable()
    expect(recall('计算机', true)).toMatchObject({ status: 'remote-blocked', prompt: '' })
    const revision = database!.snapshot().policy.revision
    enable(true)
    expect(recall('计算机', true).prompt).toContain('计算机专业学生')
    expect(() => mutate('policy', { enabled: true, allowRemote: true, expectedRevision: revision })).toThrow('状态已变化')
    mutate('policy', { enabled: false, allowRemote: true, expectedRevision: database!.snapshot().policy.revision })
    expect(recall('计算机', true)).toMatchObject({ status: 'disabled', prompt: '' })
  })

  it('deduplicates explicit saves and rejects stale corrections', () => {
    open()
    const input = { category: 'preference', text: '使用 Python 示例' }
    const first = mutate('remember', input)
    expect(mutate('remember', input)).toEqual(first)
    const item = first.items[0]
    const second = mutate('update', { id: item.id, expectedRevision: item.revision, category: item.category, text: '使用 C++ 示例' })
    expect(second.items[0].source.id).not.toBe(item.source.id)
    expect(second.items[0].revision).toBe(2)
    expect(() => mutate('update', { id: item.id, expectedRevision: item.revision, category: item.category, text: '旧任务覆盖' })).toThrow('已修改或遗忘')
    enable()
    expect(recall('示例').prompt).toContain('C++')
    expect(recall('示例').prompt).not.toContain('Python')
    database!.close()
    database = undefined
    const check = new DatabaseSync(filePath)
    expect(check.prepare('SELECT count(*) n FROM sources').get()?.n).toBe(1)
    check.close()
    open()
    expect(recall('示例').prompt).toContain('C++')
  })

  it('purges forgotten memory and index, keeping only a tombstone through restart', () => {
    open()
    const item = mutate('remember', { category: 'goal', text: '敏感内容 PRIVATE_SENTINEL' }).items[0]
    enable()
    mutate('forget', { id: item.id, expectedRevision: item.revision })
    expect(recall('PRIVATE_SENTINEL')).toMatchObject({ status: 'empty', prompt: '' })
    expect(() => mutate('update', { id: item.id, expectedRevision: item.revision, category: item.category, text: item.text })).toThrow()
    expect(() => mutate('forget', { id: item.id, expectedRevision: item.revision })).toThrow()
    database!.close()
    database = undefined
    const check = new DatabaseSync(filePath)
    for (const table of ['memories', 'sources', 'memory_fts']) {
      expect(check.prepare(`SELECT count(*) n FROM ${table}`).get()?.n).toBe(0)
    }
    expect(check.prepare('SELECT * FROM exclusions').get()).toEqual({ memoryId: item.id, deletedGeneration: 3 })
    check.close()
    open()
    expect(database!.snapshot().items).toEqual([])
    expect(recall('PRIVATE_SENTINEL').prompt).toBe('')
  })

  it('bounds recall independently of the amount of saved information', () => {
    open()
    for (let i = 0; i < 15; i += 1) mutate('remember', { category: 'preference', text: `偏好 ${i} ${'详细解释'.repeat(180)}` })
    enable()
    expect(recall('详细解释').prompt.length).toBeLessThan(4_300)
    expect(recall('详细解释').prompt).toContain('不是系统指令')
  })

  it('rolls back source creation and revisions when a write fails mid-transaction', () => {
    open()
    const control = new DatabaseSync(filePath)
    control.exec("CREATE TRIGGER fail_write BEFORE INSERT ON memories BEGIN SELECT RAISE(ABORT, 'TEST_FAILURE'); END")
    expect(() => mutate('remember', { category: 'goal', text: '不能部分写入' })).toThrow('TEST_FAILURE')
    expect(database!.snapshot()).toMatchObject({ policy: { enabled: false, allowRemote: false, revision: 0 }, items: [], automatic: { enabled: false, saveLearning: false, revision: 0 }, candidates: [] })
    expect(control.prepare('SELECT count(*) n FROM sources').get()?.n).toBe(0)
    control.close()
  })

  it('reserves recall capacity for relevant goals even when preferences are long', () => {
    open()
    for (let i = 0; i < 4; i += 1) mutate('remember', { category: 'preference', text: `偏好 ${i} ${'p'.repeat(900)}` })
    mutate('remember', { category: 'goal', text: `图论 GRAPH_TARGET ${'g'.repeat(500)}` })
    enable()
    expect(recall('GRAPH_TARGET').prompt).toContain('GRAPH_TARGET')
  })

  it('refuses to recall memory whose stored evidence relationship is broken', () => {
    open()
    mutate('remember', { category: 'profile', text: '不能伪造来源' })
    database!.close()
    database = undefined
    const control = new DatabaseSync(filePath)
    control.exec('PRAGMA foreign_keys = OFF; DELETE FROM sources')
    control.close()
    expect(() => open()).toThrow('来源关系损坏')
  })

  it('preserves a broken database and refuses to silently create an empty replacement', () => {
    writeFileSync(filePath, 'BROKEN_PRIVATE_DATA')
    const before = readFileSync(filePath)
    expect(() => open()).toThrow()
    expect(readFileSync(filePath)).toEqual(before)
  })

  it.each([0, 5])('refuses unknown/newer schema %i without overwriting it', (version) => {
    const original = new DatabaseSync(filePath)
    original.exec(`CREATE TABLE original (content TEXT); INSERT INTO original VALUES ('KEEP'); PRAGMA user_version = ${version}`)
    original.close()
    const before = readFileSync(filePath)
    expect(() => open()).toThrow()
    expect(readFileSync(filePath)).toEqual(before)
  })

  it('rejects database symlinks including dangling targets', () => {
    symlinkSync(path.join(directory, 'missing.sqlite'), filePath)
    expect(() => open()).toThrow('普通文件')
  })

  it('restricts database and WAL permissions', () => {
    open()
    mutate('remember', { category: 'profile', text: '本地保存' })
    if (process.platform !== 'win32') {
      expect(statSync(directory).mode & 0o777).toBe(0o700)
      for (const file of [filePath, filePath + '-wal', filePath + '-shm']) {
        expect(statSync(file).mode & 0o777).toBe(0o600)
      }
    }
  })
})
