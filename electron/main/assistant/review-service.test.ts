import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectService } from '../project'
import { ProjectPathGuard } from '../security'
import type { SettingsStore } from '../settings'
import type { AssistantService } from './service'
import type { AssistantDatabase } from './database'
import type { AssistantCommand } from './contract'
import { ReviewService } from './review-service'
import { contentHash } from './automatic-memory'
import { managedBlock } from './review'
import type { ExportState, StoredDraft } from './workflows'

const sqlite = await import('node:sqlite').catch(() => null)
const DatabaseClass = sqlite ? (await import('./database')).AssistantDatabase : null
let directory: string
let project: ProjectService
let database: AssistantDatabase
let service: AssistantService
let review: ReviewService
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'coscribe-review-service-'))
  project = new ProjectService({} as SettingsStore, () => undefined, () => undefined)
  ;(project as unknown as { guardValue: ProjectPathGuard }).guardValue = new ProjectPathGuard(directory)
  if (DatabaseClass) {
    database = new DatabaseClass(path.join(directory, '.test-data', 'assistant.sqlite'))
    service = { workflow: async (command: AssistantCommand, payload: unknown) => database.execute(command, payload) } as AssistantService
    review = new ReviewService(service, project)
  }
})
afterEach(async () => { vi.restoreAllMocks(); database?.close(); await rm(directory, { recursive: true, force: true }) })
const input = { date: '2026-10-07', timeZone: 'Asia/Shanghai', includePlan: false }
async function preview(targetPath = '每日笔记/2026-10-07.md') {
  const draft = await review.generate(input)
  const proposal = await review.prepareExport({ draftId: draft.id, targetPath })
  return { draft, proposal }
}
function switchProject(): void { (project as unknown as { projectRevision: number }).projectRevision += 1 }

describe.skipIf(!sqlite)('confirmed review export and recovery', () => {
  it('creates missing directories only after confirmation and blocks generic AI acceptance', async () => {
    const { proposal } = await preview()
    await expect(readFile(proposal.targetPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(project.applyAiOperation({ ...proposal, status: 'accepted' })).rejects.toThrow('已失效')
    const result = await review.commitExport(proposal.id)
    expect(result.content).toContain('2026-10-07 每日复盘')
    expect(await readFile(proposal.targetPath, 'utf8')).toBe(result.content)
    await expect(review.commitExport(proposal.id)).rejects.toThrow('已失效')
    const again = await preview()
    const unchanged = await review.commitExport(again.proposal.id)
    expect(unchanged.modifiedAt).toBe(result.modifiedAt)
    expect((unchanged.content.match(/:start -->/gu) ?? []).length).toBe(1)
  })
  it('preserves all manual content outside its block and stops when that block is edited', async () => {
    const filePath = path.join(directory, 'notes.md')
    const handwritten = '# 人工笔记\n\n原文  \n'
    await writeFile(filePath, handwritten)
    const { proposal } = await preview('notes.md')
    expect(proposal.proposedContent?.startsWith(handwritten)).toBe(true)
    const written = await review.commitExport(proposal.id)
    await writeFile(filePath, written.content + '\n后续手写文字  \n')
    await review.addActivity({ date: input.date, timeZone: input.timeZone, kind: 'completed', summary: '用户报告的完成项', key: crypto.randomUUID() })
    const updated = await preview('notes.md')
    const result = await review.commitExport(updated.proposal.id)
    expect(result.content).toContain('用户报告的完成项')
    expect(result.content.startsWith(handwritten)).toBe(true)
    expect(result.content.endsWith('\n后续手写文字  \n')).toBe(true)
    await writeFile(filePath, result.content.replace('用户报告的完成项', '区块内人工修改'))
    await expect(preview('notes.md')).rejects.toThrow('人工修改')
    expect(await readFile(filePath, 'utf8')).toContain('区块内人工修改')
  })
  it('rejects changed disk content, project lifecycle, stale consent and forged IDs without writing', async () => {
    await writeFile(path.join(directory, 'note.md'), '# BEFORE')
    const first = await preview('note.md')
    await writeFile(path.join(directory, 'note.md'), '# EXTERNAL')
    await expect(review.commitExport(first.proposal.id)).rejects.toThrow('预览后已被修改')
    expect(await readFile(path.join(directory, 'note.md'), 'utf8')).toBe('# EXTERNAL')
    const second = await preview()
    switchProject()
    await expect(review.commitExport(second.proposal.id)).rejects.toThrow('项目已切换')
    const third = await preview('other.md')
    await review.setPolicy({ recording: true, expectedRevision: (await review.policy()).revision })
    await expect(review.commitExport(third.proposal.id)).rejects.toThrow('授权已变化')
    await expect(review.prepareExport({ draftId: third.draft.id })).rejects.toThrow('授权已变化')
    await expect(review.commitExport(crypto.randomUUID())).rejects.toThrow('已失效')
    await expect(readFile(path.join(directory, 'other.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects traversal, internal metadata and symlink targets', async () => {
    await symlink(path.join(directory, 'original.md'), path.join(directory, 'linked.md'))
    for (const target of ['../outside.md', '.coscribe/private.md', 'linked.md', 'review.ts']) await expect(preview(target)).rejects.toThrow()
  })
  it('checks scope and consent again inside atomic writes when revocation races IO', async () => {
    const { proposal } = await preview()
    const create = project.createMarkdown.bind(project)
    vi.spyOn(project, 'createMarkdown').mockImplementation(async (filePath, content, scope) => {
      await review.setPolicy({ recording: true, expectedRevision: (await review.policy()).revision })
      return create(filePath, content, scope)
    })
    await expect(review.commitExport(proposal.id)).rejects.toThrow('授权已变化')
    await expect(readFile(proposal.targetPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('records only changed notes under the captured grant and reports failed logging without failing a successful save', async () => {
    const off = await review.policy()
    const scope = project.captureWriteScope()
    const file = await project.createMarkdown('note.md', '# 内容')
    await review.noteSaved(scope, off, null, file)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
    expect((await review.generate({ ...input, date: today })).activityCount).toBe(0)
    const on = await review.setPolicy({ recording: true, expectedRevision: off.revision })
    const next = await project.saveMarkdown('note.md', '# 修改')
    await review.noteSaved(scope, on, file, next)
    await review.noteSaved(scope, on, next, next)
    expect((await review.generate({ ...input, date: today })).activityCount).toBe(1)
    await review.setPolicy({ recording: false, expectedRevision: on.revision })
    const warned = await review.noteSaved(scope, on, file, next)
    expect(warned.warnings?.[0]).toContain('笔记已保存')
  })
  it.each(['before', 'after', 'unknown'] as const)('reconciles a crash at %s without replaying a blind write', async (phase) => {
    await writeFile(path.join(directory, 'crash.md'), '# 原始内容\n')
    const { draft, proposal } = await preview('crash.md')
    const row: ExportState = { targetPath: proposal.targetPath, date: draft.date, timeZone: draft.timeZone, state: 'prepared', beforeHash: contentHash(proposal.originalContent!), afterHash: contentHash(proposal.proposedContent!), blockHash: contentHash(managedBlock(proposal.proposedContent!, draft.date, draft.timeZone)!), previousBlockHash: null, workspaceRevision: (draft as StoredDraft).workspaceRevision, draftId: draft.id }
    database.execute('export-prepare', { workspace: project.guard.root, export: row })
    if (phase !== 'before') await writeFile(proposal.targetPath, phase === 'after' ? proposal.proposedContent! : '# 不明变动')
    // New process has no cached approval; it must generate a fresh preview.
    review = new ReviewService(service, project)
    await expect(review.commitExport(proposal.id)).rejects.toThrow('已失效')
    if (phase === 'unknown') {
      await expect(review.prepareExport({ draftId: draft.id, targetPath: 'crash.md' })).rejects.toThrow('写入中断且文件已变化')
      expect(await readFile(proposal.targetPath, 'utf8')).toBe('# 不明变动')
    } else {
      const fresh = await review.prepareExport({ draftId: draft.id, targetPath: 'crash.md' })
      await review.commitExport(fresh.id)
      expect((await readFile(proposal.targetPath, 'utf8')).match(/:start -->/gu)).toHaveLength(1)
    }
  })
  it('leaves a recoverable prepared record when disk commit succeeds but SQLite completion fails', async () => {
    const { draft, proposal } = await preview()
    const original = service.workflow.bind(service)
    const fault = vi.spyOn(service, 'workflow').mockImplementation(async (command, payload) => {
      if (command === 'export-finish') throw new Error('SIMULATED_CRASH')
      return original(command, payload)
    })
    await expect(review.commitExport(proposal.id)).rejects.toThrow('SIMULATED_CRASH')
    expect(await readFile(proposal.targetPath, 'utf8')).toContain('每日复盘')
    fault.mockRestore()
    review = new ReviewService(service, project)
    const fresh = await review.prepareExport({ draftId: draft.id })
    await review.commitExport(fresh.id)
    expect((await readFile(proposal.targetPath, 'utf8')).match(/:start -->/gu)).toHaveLength(1)
  })
})
