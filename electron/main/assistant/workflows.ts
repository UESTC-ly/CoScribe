import { randomUUID } from 'node:crypto'
import { chmodSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'

import type { AutomaticMemoryPolicy, MemoryCandidate, PersonalMemoryInput, ReviewActivity, ReviewDraft, ReviewWorkspacePolicy } from '../../../src/shared/assistant'
import { extractMemories, fingerprint, type ExtractedMemory } from './automatic-memory'
import { memoryTokens, type AssistantCommand } from './contract'
import { dayWindow, renderReview, validDay } from './review'

const revision = z.number().int().nonnegative()
const workspace = z.string().min(1).max(4_096)
const day = z.string().refine(validDay, '日期无效。')
const zone = z.string().min(1).max(100).refine((value) => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true } catch { return false } }, '时区无效。')
export const automaticSchema = z.strictObject({ enabled: z.boolean(), saveLearning: z.boolean(), expectedRevision: revision })
export const candidateSchema = z.strictObject({ id: z.uuid(), action: z.enum(['accept', 'dismiss']), replaceId: z.uuid().optional(), expectedRevision: z.number().int().positive().optional() })
export const workspacePolicySchema = z.strictObject({ recording: z.boolean(), expectedRevision: revision })
export const manualActivitySchema = z.strictObject({ date: day, timeZone: zone, kind: z.enum(['completed', 'unresolved', 'reflection']), summary: z.string().trim().min(1).max(1_000), key: z.uuid() })
export const generateSchema = z.strictObject({ date: day, timeZone: zone, includePlan: z.boolean() })
export const exportSchema = z.strictObject({ draftId: z.uuid(), targetPath: z.string().trim().min(1).max(1_024).optional() })
const observeSchema = z.strictObject({ workspace, sessionId: z.string().max(200), text: z.string().max(100_000), sourceKey: z.string().length(64), automaticRevision: revision, workspaceRevision: revision, occurredAt: z.number().int().positive() })
const activitySchema = z.strictObject({ workspace, expectedRevision: revision, key: z.string().max(200), kind: z.enum(['conversation', 'note-edited', 'completed', 'unresolved', 'reflection']), summary: z.string().min(1).max(1_000), occurredAt: z.number().int().positive(), locator: z.string().max(1_024), source: z.enum(['app-event', 'user-report']) })
const draftSchema = z.strictObject({ workspace, date: day, timeZone: zone, planContent: z.string().max(1_000_000).nullable(), plans: z.array(z.strictObject({ date: z.string(), time: z.string(), title: z.string().max(1_000), status: z.enum(['待办', '进行中', '已完成']), priority: z.enum(['低', '中', '高']), notes: z.string().max(10_000) })).max(2_000), gaps: z.array(z.string().max(500)).max(20), expectedRevision: revision })

export interface StoredDraft extends ReviewDraft { workspaceRevision: number }
export interface ExportState { targetPath: string; date: string; timeZone: string; state: 'prepared' | 'committed'; beforeHash: string | null; afterHash: string; blockHash: string; previousBlockHash: string | null; workspaceRevision: number; draftId: string }

export function migrateWorkflows(db: DatabaseSync, filePath: string, backup: boolean): void {
  // VACUUM INTO includes committed WAL contents. No copying a live db file.
  if (backup) {
    const destination = filePath + '.v1-' + randomUUID() + '.bak'
    db.prepare('VACUUM INTO ?').run(destination)
    chmodSync(destination, 0o600)
  }
  db.exec('PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE')
  try {
    db.exec(`
      CREATE TABLE sources_v2 (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('user-explicit','user-stated')), origin TEXT NOT NULL CHECK(origin IN ('about-me','chat')), recordedAt INTEGER NOT NULL, quote TEXT, sessionId TEXT);
      INSERT INTO sources_v2 (id,kind,origin,recordedAt) SELECT id,kind,origin,recordedAt FROM sources;
      DROP TABLE sources;
      ALTER TABLE sources_v2 RENAME TO sources;
      CREATE TABLE automatic_policy (id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL, saveLearning INTEGER NOT NULL, revision INTEGER NOT NULL);
      INSERT INTO automatic_policy VALUES(1,0,0,0);
      CREATE TABLE memory_origins (memoryId TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE, slot TEXT NOT NULL, factHash TEXT NOT NULL, sourceKey TEXT NOT NULL);
      CREATE TABLE memory_candidates (id TEXT PRIMARY KEY, category TEXT NOT NULL, text TEXT NOT NULL, quote TEXT NOT NULL, sessionId TEXT NOT NULL, createdAt INTEGER NOT NULL, slot TEXT NOT NULL, factHash TEXT NOT NULL, sourceKey TEXT NOT NULL, automaticRevision INTEGER NOT NULL);
      CREATE UNIQUE INDEX candidate_fact ON memory_candidates(factHash);
      CREATE TABLE auto_exclusions (key TEXT PRIMARY KEY);
      CREATE TABLE observed_chat (key TEXT PRIMARY KEY);
      CREATE TABLE review_workspaces (workspace TEXT PRIMARY KEY, recording INTEGER NOT NULL, revision INTEGER NOT NULL, since INTEGER);
      CREATE TABLE review_activity (id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES review_workspaces(workspace), kind TEXT NOT NULL, summary TEXT NOT NULL, occurredAt INTEGER NOT NULL, source TEXT NOT NULL, locator TEXT NOT NULL, eventKey TEXT NOT NULL, UNIQUE(workspace,eventKey));
      CREATE INDEX review_date ON review_activity(workspace,occurredAt);
      CREATE TABLE review_drafts (id TEXT PRIMARY KEY, workspace TEXT NOT NULL REFERENCES review_workspaces(workspace), watermark TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(workspace,watermark));
      CREATE TABLE review_exports (workspace TEXT NOT NULL REFERENCES review_workspaces(workspace), targetPath TEXT NOT NULL, date TEXT NOT NULL, timeZone TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(workspace,targetPath,date,timeZone));
      PRAGMA user_version = 2;
    `)
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('助理数据库迁移来源检查失败，原数据备份已保留。')
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
  finally { db.exec('PRAGMA foreign_keys = ON') }
}

export class AssistantWorkflows {
  constructor(private readonly db: DatabaseSync, private readonly transaction: <T>(action: () => T) => T) {}

  automatic(): AutomaticMemoryPolicy {
    const row = this.db.prepare('SELECT * FROM automatic_policy WHERE id=1').get()!
    return { enabled: row.enabled === 1, saveLearning: row.saveLearning === 1, revision: Number(row.revision) }
  }

  candidates(): MemoryCandidate[] {
    return this.db.prepare('SELECT * FROM memory_candidates ORDER BY createdAt DESC,id').all().map((row) => ({
      id: String(row.id), category: row.category as MemoryCandidate['category'], text: String(row.text), quote: String(row.quote), sessionId: String(row.sessionId), createdAt: Number(row.createdAt), conflict: this.conflict(String(row.slot), row.category as PersonalMemoryInput['category'])
    }))
  }

  private conflict(slot: string, category: PersonalMemoryInput['category']): boolean {
    // Manually authored facts lack a slot: conservatively require confirmation
    // whenever another fact of that category exists.
    return !!this.db.prepare('SELECT m.id FROM memories m LEFT JOIN memory_origins o ON o.memoryId=m.id WHERE m.category=? AND (o.slot=? OR o.slot IS NULL) LIMIT 1').get(category, slot)
  }

  protect(memoryId: string, text: string): void {
    const origin = this.db.prepare('SELECT * FROM memory_origins WHERE memoryId=?').get(memoryId)
    const slotKey = typeof origin?.slot === 'string' && origin.slot.startsWith('learning:') ? fingerprint('slot:' + origin.slot) : undefined
    for (const key of [fingerprint(text), origin?.sourceKey, origin?.factHash, slotKey]) {
      if (typeof key === 'string') this.db.prepare('INSERT OR IGNORE INTO auto_exclusions VALUES(?)').run(key)
    }
    this.db.prepare('DELETE FROM memory_candidates WHERE factHash=? OR sourceKey=? OR (? IS NOT NULL AND slot=?)').run(fingerprint(text), origin?.sourceKey ?? '', slotKey ?? null, origin?.slot ?? '')
    this.db.prepare('DELETE FROM memory_origins WHERE memoryId=?').run(memoryId)
  }

  private insertMemory(fact: ExtractedMemory, sessionId: string, sourceKey: string, automatic: boolean): void {
    if (Number(this.db.prepare('SELECT count(*) n FROM memories').get()?.n) >= 500) throw new Error('个人记忆已达上限，请先整理。')
    const now = Date.now()
    const id = randomUUID()
    const sourceId = randomUUID()
    this.db.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?)').run(sourceId, automatic ? 'user-stated' : 'user-explicit', 'chat', now, fact.quote, sessionId)
    this.db.prepare('INSERT INTO memories VALUES(?,?,?,1,?,?,?)').run(id, fact.category, fact.text, now, now, sourceId)
    this.db.prepare('INSERT INTO memory_fts(memoryId,tokens) VALUES(?,?)').run(id, memoryTokens(fact.text).join(' '))
    this.db.prepare('INSERT INTO memory_origins VALUES(?,?,?,?)').run(id, fact.slot, fingerprint(fact.text), sourceKey)
    this.db.exec('UPDATE policy SET revision=revision+1 WHERE id=1')
  }

  workspace(root: string): ReviewWorkspacePolicy {
    this.db.prepare('INSERT OR IGNORE INTO review_workspaces VALUES(?,0,0,NULL)').run(root)
    const row = this.db.prepare('SELECT * FROM review_workspaces WHERE workspace=?').get(root)!
    return { recording: row.recording === 1, revision: Number(row.revision), since: row.since === null ? null : Number(row.since) }
  }

  private activity(payload: unknown): void {
    const input = activitySchema.parse(payload)
    const policy = this.workspace(input.workspace)
    if (policy.revision !== input.expectedRevision) throw new Error('活动记录授权已变化，请刷新后重试。')
    if (input.source === 'app-event' && (!policy.recording || input.occurredAt < (policy.since ?? Infinity))) return
    const previous = this.db.prepare('SELECT kind,summary,source,locator FROM review_activity WHERE workspace=? AND eventKey=?').get(input.workspace, input.key)
    if (previous) {
      if (previous.kind !== input.kind || previous.summary !== input.summary || previous.source !== input.source || previous.locator !== input.locator) throw new Error('同一活动提交标识的内容已变化，请创建新的补充。')
      return
    }
    const count = Number(this.db.prepare('SELECT count(*) n FROM review_activity WHERE workspace=?').get(input.workspace)?.n)
    if (count >= 10_000) throw new Error('活动账本已达 10,000 条上限，请导出并清理。')
    this.db.prepare('INSERT OR IGNORE INTO review_activity VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), input.workspace, input.kind, input.summary, input.occurredAt, input.source, input.locator, input.key)
  }

  execute(command: AssistantCommand, payload: unknown): unknown {
    return this.transaction(() => {
      if (command === 'automatic') {
        const input = automaticSchema.parse(payload)
        if (this.automatic().revision !== input.expectedRevision) throw new Error('自动记忆授权已变化，请刷新后重试。')
        this.db.prepare('UPDATE automatic_policy SET enabled=?,saveLearning=?,revision=revision+1 WHERE id=1').run(Number(input.enabled), Number(input.saveLearning))
        // Pending work from an older grant is never accepted under a new one.
        this.db.exec('DELETE FROM memory_candidates; UPDATE policy SET revision=revision+1 WHERE id=1')
      } else if (command === 'candidate') {
        const input = candidateSchema.parse(payload)
        const row = this.db.prepare('SELECT * FROM memory_candidates WHERE id=?').get(input.id)
        const grant = this.automatic()
        if (!row || !grant.enabled || row.automaticRevision !== grant.revision) throw new Error('候选或授权已变化，请刷新后重试。')
        if (input.action === 'dismiss') {
          this.db.prepare('INSERT OR IGNORE INTO auto_exclusions VALUES(?)').run(row.factHash)
          if (String(row.slot).startsWith('learning:')) this.db.prepare('INSERT OR IGNORE INTO auto_exclusions VALUES(?)').run(fingerprint('slot:' + String(row.slot)))
        } else {
          if (input.replaceId) {
            const previous = this.db.prepare('SELECT * FROM memories WHERE id=? AND revision=?').get(input.replaceId, input.expectedRevision ?? -1)
            if (!previous || previous.category !== row.category) throw new Error('待替换记忆已变化或类别不符，请刷新。')
            this.protect(String(previous.id), String(previous.text))
            this.db.prepare('DELETE FROM memory_fts WHERE memoryId=?').run(previous.id)
            this.db.prepare('DELETE FROM memories WHERE id=?').run(previous.id)
            this.db.prepare('DELETE FROM sources WHERE id=?').run(previous.sourceId)
          }
          if (!this.db.prepare('SELECT id FROM memories WHERE category=? AND text=?').get(row.category, row.text)) {
            this.insertMemory({ category: row.category as PersonalMemoryInput['category'], text: String(row.text), quote: String(row.quote), slot: String(row.slot), autoEligible: false }, String(row.sessionId), String(row.sourceKey), false)
          }
        }
        this.db.prepare('DELETE FROM memory_candidates WHERE id=?').run(input.id)
      } else if (command === 'observe') {
        const input = observeSchema.parse(payload)
        const grant = this.automatic()
        const review = this.workspace(input.workspace)
        if (review.revision === input.workspaceRevision && review.recording && input.text.trim()) {
          this.activity({ workspace: input.workspace, expectedRevision: review.revision, key: 'chat:' + input.sourceKey, kind: 'conversation', summary: '提交对话：' + input.text.slice(0, 900), occurredAt: input.occurredAt, locator: input.sessionId, source: 'app-event' })
        }
        if (!grant.enabled || grant.revision !== input.automaticRevision || this.db.prepare('SELECT key FROM observed_chat WHERE key=?').get(input.sourceKey)) return
        this.db.prepare('INSERT INTO observed_chat VALUES(?)').run(input.sourceKey)
        for (const fact of extractMemories(input.text)) {
          const factHash = fingerprint(fact.text)
          if (this.db.prepare('SELECT key FROM auto_exclusions WHERE key IN (?,?,?) LIMIT 1').get(factHash, input.sourceKey, fingerprint('slot:' + fact.slot)) || this.db.prepare('SELECT id FROM memories WHERE category=? AND text=?').get(fact.category, fact.text)) continue
          const conflict = this.conflict(fact.slot, fact.category)
          if (grant.saveLearning && fact.autoEligible && !conflict) this.insertMemory(fact, input.sessionId, input.sourceKey, true)
          else if (Number(this.db.prepare('SELECT count(*) n FROM memory_candidates').get()?.n) < 200) {
            this.db.prepare('INSERT OR IGNORE INTO memory_candidates VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), fact.category, fact.text, fact.quote, input.sessionId, input.occurredAt, fact.slot, factHash, input.sourceKey, grant.revision)
          }
        }
      } else if (command === 'workspace') {
        return this.workspace(workspace.parse(payload))
      } else if (command === 'workspace-policy') {
        const input = z.strictObject({ workspace, ...workspacePolicySchema.shape }).parse(payload)
        const previous = this.workspace(input.workspace)
        if (previous.revision !== input.expectedRevision) throw new Error('活动记录授权已变化，请刷新后重试。')
        this.db.prepare('UPDATE review_workspaces SET recording=?,revision=revision+1,since=? WHERE workspace=?').run(Number(input.recording), input.recording ? Date.now() : null, input.workspace)
        return this.workspace(input.workspace)
      } else if (command === 'activity') {
        this.activity(payload)
      } else if (command === 'draft') {
        const input = draftSchema.parse(payload)
        const policy = this.workspace(input.workspace)
        if (policy.revision !== input.expectedRevision) throw new Error('活动记录授权已变化，请重新生成。')
        const window = dayWindow(input.date, input.timeZone)
        const rows = this.db.prepare('SELECT id,kind,summary,occurredAt,source,locator FROM review_activity WHERE workspace=? AND occurredAt>=? AND occurredAt<? ORDER BY occurredAt,id LIMIT 501').all(input.workspace, window.start, window.end) as unknown as ReviewActivity[]
        const gaps = [...input.gaps, '仅覆盖本项目开启记录后的对话提交、笔记编辑和用户补充；未读取旧会话、系统日历或邮箱。', '记录对话或保存笔记不代表掌握知识；用户补充属于自述。']
        if (!policy.recording) gaps.push('当前自动活动记录已关闭，草稿仍包含此前已记录活动与手动补充。')
        if (rows.length > 500) gaps.push('本日记录超过 500 条，当前草稿仅展示前 500 条。')
        const activities = rows.slice(0, 500)
        const watermark = fingerprint(JSON.stringify({ date: input.date, timeZone: input.timeZone, activities, planContent: input.planContent, plans: input.plans, gaps, policy }))
        const existing = this.db.prepare('SELECT payload FROM review_drafts WHERE workspace=? AND watermark=?').get(input.workspace, watermark)
        if (existing) return JSON.parse(String(existing.payload)) as StoredDraft
        if (Number(this.db.prepare('SELECT count(*) n FROM review_drafts WHERE workspace=?').get(input.workspace)?.n) >= 2_000) throw new Error('复盘草稿已达上限，请导出并清理账本。')
        const draft: StoredDraft = { id: randomUUID(), date: input.date, timeZone: input.timeZone, createdAt: Date.now(), markdown: renderReview({ date: input.date, timeZone: input.timeZone, activities, plans: input.plans, gaps }), activityCount: activities.length, gaps, workspaceRevision: policy.revision }
        this.db.prepare('INSERT INTO review_drafts VALUES(?,?,?,?)').run(draft.id, input.workspace, watermark, JSON.stringify(draft))
        return draft
      } else if (command === 'get-draft') {
        const input = z.strictObject({ workspace, id: z.uuid() }).parse(payload)
        const row = this.db.prepare('SELECT payload FROM review_drafts WHERE workspace=? AND id=?').get(input.workspace, input.id)
        if (!row) throw new Error('复盘草稿不存在或属于其他项目。')
        return JSON.parse(String(row.payload)) as StoredDraft
      } else if (command === 'export-state') {
        const input = z.strictObject({ workspace, targetPath: z.string(), date: day, timeZone: zone }).parse(payload)
        const row = this.db.prepare('SELECT payload FROM review_exports WHERE workspace=? AND targetPath=? AND date=? AND timeZone=?').get(input.workspace, input.targetPath, input.date, input.timeZone)
        return row ? JSON.parse(String(row.payload)) as ExportState : null
      } else if (command === 'export-prepare' || command === 'export-finish') {
        const input = z.strictObject({ workspace, export: z.strictObject({ targetPath: z.string().min(1).max(4_096), date: day, timeZone: zone, state: z.enum(['prepared', 'committed']), beforeHash: z.string().length(64).nullable(), afterHash: z.string().length(64), blockHash: z.string().length(64), previousBlockHash: z.string().length(64).nullable(), workspaceRevision: revision, draftId: z.uuid() }) }).parse(payload)
        if (this.workspace(input.workspace).revision !== input.export.workspaceRevision) throw new Error('复盘记录授权已变化，请重新预览。')
        if ((command === 'export-prepare') !== (input.export.state === 'prepared')) throw new Error('复盘写入状态无效。')
        if (command === 'export-prepare') {
          const previous = this.db.prepare('SELECT payload FROM review_exports WHERE workspace=? AND targetPath=? AND date=? AND timeZone=?').get(input.workspace, input.export.targetPath, input.export.date, input.export.timeZone)
          if (previous && (JSON.parse(String(previous.payload)) as ExportState).state === 'prepared') throw new Error('上次写入尚未核对，请重新预览。')
        }
        this.db.prepare('INSERT OR REPLACE INTO review_exports VALUES(?,?,?,?,?)').run(input.workspace, input.export.targetPath, input.export.date, input.export.timeZone, JSON.stringify(input.export))
      } else if (command === 'clear-review') {
        const input = z.strictObject({ workspace, expectedRevision: revision }).parse(payload)
        if (this.workspace(input.workspace).revision !== input.expectedRevision) throw new Error('活动记录授权已变化，请刷新。')
        for (const table of ['review_exports', 'review_drafts', 'review_activity']) this.db.prepare(`DELETE FROM ${table} WHERE workspace=?`).run(input.workspace)
        this.db.prepare('UPDATE review_workspaces SET recording=0,revision=revision+1,since=NULL WHERE workspace=?').run(input.workspace)
        return this.workspace(input.workspace)
      } else throw new Error('未知助理工作流。')
      return null
    })
  }
}
