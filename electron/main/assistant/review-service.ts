import path from 'node:path'
import { z } from 'zod'

import type { FileOperationProposal, FileReadResult } from '../../../src/shared/types'
import type { ReviewDraft, ReviewWorkspacePolicy } from '../../../src/shared/assistant'
import { parsePlannerTasks, PLANNER_FILE_PATH } from '../../../src/plugins/planner/planner-utils'
import { projectTargetAllowMissing, type ProjectService, type ProjectWriteScope } from '../project'
import { contentHash, fingerprint } from './automatic-memory'
import { dayWindow, managedBlock, mergeReview } from './review'
import { exportSchema, generateSchema, manualActivitySchema, workspacePolicySchema, type ExportState, type StoredDraft } from './workflows'
import type { AssistantService } from './service'

interface PendingExport { proposal: FileOperationProposal; scope: ProjectWriteScope; journal: ExportState; createdAt: number }
function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }

export class ReviewService {
  private readonly pending = new Map<string, PendingExport>()
  private readonly epochs = new Map<string, number>()
  private readonly busy = new Set<string>()
  constructor(private readonly assistant: AssistantService, private readonly project: ProjectService) {}

  private verify(scope: ProjectWriteScope): void {
    scope.verify?.()
    const current = this.project.captureWriteScope()
    if (current.root !== scope.root || current.revision !== scope.revision) throw new Error('项目已切换，请重新生成复盘预览。')
  }

  async policy(): Promise<ReviewWorkspacePolicy> {
    const scope = this.project.captureWriteScope()
    const result = await this.assistant.workflow<ReviewWorkspacePolicy>('workspace', scope.root)
    this.verify(scope)
    return result
  }

  async setPolicy(payload: unknown): Promise<ReviewWorkspacePolicy> {
    const input = workspacePolicySchema.parse(payload)
    const scope = this.project.captureWriteScope()
    this.epochs.set(scope.root, (this.epochs.get(scope.root) ?? 0) + 1)
    const result = await this.assistant.workflow<ReviewWorkspacePolicy>('workspace-policy', { workspace: scope.root, ...input })
    this.verify(scope)
    return result
  }

  async clear(payload: unknown): Promise<ReviewWorkspacePolicy> {
    const expectedRevision = z.number().int().nonnegative().parse(payload)
    const scope = this.project.captureWriteScope()
    this.epochs.set(scope.root, (this.epochs.get(scope.root) ?? 0) + 1)
    const result = await this.assistant.workflow<ReviewWorkspacePolicy>('clear-review', { workspace: scope.root, expectedRevision })
    this.verify(scope)
    return result
  }

  async addActivity(payload: unknown): Promise<void> {
    const input = manualActivitySchema.parse(payload)
    const scope = this.project.captureWriteScope()
    const policy = await this.policy()
    this.verify(scope)
    const window = dayWindow(input.date, input.timeZone)
    // A selected day is a user report, not an exact event timestamp.
    await this.assistant.workflow('activity', { workspace: scope.root, expectedRevision: policy.revision, key: 'manual:' + input.key, kind: input.kind, summary: input.summary, occurredAt: Math.floor((window.start + window.end) / 2), locator: `${input.date} (${input.timeZone}; 用户指定日期)`, source: 'user-report' })
    this.verify(scope)
  }

  async generate(payload: unknown): Promise<ReviewDraft> {
    const input = generateSchema.parse(payload)
    const scope = this.project.captureWriteScope()
    const policy = await this.policy()
    this.verify(scope)
    let planContent: string | null = null
    const gaps: string[] = []
    if (input.includePlan) {
      try { planContent = (await this.project.read(PLANNER_FILE_PATH)).content }
      catch (error) {
        if (!missing(error)) throw error
        gaps.push('已请求读取项目计划，但计划文件不存在。')
      }
      this.verify(scope)
    } else gaps.push('本次未授权读取项目计划。')
    const plans = planContent === null ? [] : parsePlannerTasks(planContent)
    const draft = await this.assistant.workflow<StoredDraft>('draft', { workspace: scope.root, date: input.date, timeZone: input.timeZone, plans, planContent, gaps, expectedRevision: policy.revision })
    this.verify(scope)
    return draft
  }

  async prepareExport(payload: unknown): Promise<FileOperationProposal> {
    const input = exportSchema.parse(payload)
    const scope = this.project.captureWriteScope()
    const draft = await this.assistant.workflow<StoredDraft>('get-draft', { workspace: scope.root, id: input.draftId })
    this.verify(scope)
    const policy = await this.policy()
    this.verify(scope)
    if (policy.revision !== draft.workspaceRevision) throw new Error('活动记录授权已变化，请重新生成复盘。')
    const target = input.targetPath ?? `每日笔记/${draft.date}.md`
    if (!/\.(?:md|markdown)$/iu.test(target)) throw new Error('复盘只能写入项目内 Markdown 文件。')
    // Resolve through the project guard even when the file does not exist.
    const targetPath = await projectTargetAllowMissing(scope.root, target)
    this.verify(scope)
    let current: FileReadResult | null = null
    try { current = await this.project.read(targetPath) }
    catch (error) { if (!missing(error)) throw error }
    this.verify(scope)
    let previous = await this.assistant.workflow<ExportState | null>('export-state', { workspace: scope.root, targetPath, date: draft.date, timeZone: draft.timeZone })
    this.verify(scope)
    const beforeHash = current ? contentHash(current.content) : null
    if (previous?.state === 'prepared') {
      // Never replay an uncertain write. Reconcile by actual disk content.
      if (beforeHash === previous.afterHash) previous = { ...previous, state: 'committed' }
      else if (beforeHash === previous.beforeHash) previous = { ...previous, state: 'committed', blockHash: previous.previousBlockHash ?? contentHash(''), afterHash: beforeHash ?? contentHash('') }
      else throw new Error('上次复盘写入中断且文件已变化，请检查原文件并选择其他目标文件。')
      if (policy.revision !== previous.workspaceRevision) throw new Error('中断写入的授权已变化，请检查原文件并选择其他目标文件。')
      await this.assistant.workflow('export-finish', { workspace: scope.root, export: previous })
      this.verify(scope)
    }
    const proposedContent = mergeReview(current?.content ?? '', draft.markdown, draft.date, draft.timeZone, previous?.blockHash ?? null)
    const proposal = await this.project.prepareAiOperation({ kind: current ? 'replace' : 'create', targetPath, proposedContent, summary: `写入 ${draft.date} 复盘（仅管理复盘区块）` })
    this.verify(scope)
    if ((proposal.originalContent ?? null) !== (current?.content ?? null)) { this.project.discardAiOperation(proposal.id); throw new Error('文件在生成预览期间发生变化，请重新预览。') }
    const block = managedBlock(proposedContent, draft.date, draft.timeZone)!
    const journal: ExportState = { targetPath: proposal.targetPath, date: draft.date, timeZone: draft.timeZone, state: 'prepared', beforeHash, afterHash: contentHash(proposedContent), blockHash: contentHash(block), previousBlockHash: previous?.blockHash ?? null, workspaceRevision: policy.revision, draftId: draft.id }
    for (const [id, pending] of this.pending) if (Date.now() - pending.createdAt > 3_600_000) { this.pending.delete(id); this.project.discardAiOperation(id) }
    if (this.pending.size >= 100) { this.project.discardAiOperation(proposal.id); throw new Error('复盘预览过多，请重启应用后继续。') }
    // Only this service can accept the bound proposal; generic AI acceptance
    // cannot bypass its durable journal or generation checks.
    this.project.discardAiOperation(proposal.id)
    this.pending.set(proposal.id, { proposal, scope, journal, createdAt: Date.now() })
    return proposal
  }

  async commitExport(payload: unknown): Promise<FileReadResult> {
    const id = z.uuid().parse(payload)
    const pending = this.pending.get(id)
    if (!pending || Date.now() - pending.createdAt > 3_600_000) throw new Error('复盘预览已失效，请重新预览。')
    const { proposal, journal } = pending
    const epoch = this.epochs.get(pending.scope.root) ?? 0
    const scope = { ...pending.scope, verify: () => { if ((this.epochs.get(pending.scope.root) ?? 0) !== epoch) throw new Error('复盘记录授权已变化，本次写入已停止。') } }
    const lock = JSON.stringify([scope.root, journal.targetPath])
    if (this.busy.has(lock)) throw new Error('此文件正在写入，请核对结果后重试。')
    this.busy.add(lock)
    try {
      this.verify(scope)
      const policy = await this.policy()
      this.verify(scope)
      if (policy.revision !== journal.workspaceRevision) throw new Error('复盘记录授权已变化，请重新预览。')
      let current: FileReadResult | null = null
      try { current = await this.project.read(journal.targetPath) }
      catch (error) { if (!missing(error)) throw error }
      this.verify(scope)
      if ((current ? contentHash(current.content) : null) !== journal.beforeHash || (current && current.modifiedAt !== proposal.expectedModifiedAt)) throw new Error('文件在预览后已被修改，请重新预览。')
      if (current && current.content === proposal.proposedContent) { this.pending.delete(id); return current }
      await this.assistant.workflow('export-prepare', { workspace: scope.root, export: journal })
      this.verify(scope)
      // Recheck consent after the persisted preparation, immediately before IO.
      if ((await this.policy()).revision !== journal.workspaceRevision) throw new Error('复盘记录授权已变化，请重新预览。')
      this.verify(scope)
      const result = current
        ? await this.project.saveMarkdown(journal.targetPath, proposal.proposedContent ?? '', current.modifiedAt, scope)
        : await this.project.createMarkdown(journal.targetPath, proposal.proposedContent ?? '', scope)
      this.verify(scope)
      if (contentHash(result.content) !== journal.afterHash) throw new Error('写入后内容校验失败，请核对原文件。')
      await this.assistant.workflow('export-finish', { workspace: scope.root, export: { ...journal, state: 'committed' } })
      this.verify(scope)
      this.pending.delete(id)
      return result
    } finally { this.busy.delete(lock) }
  }

  async noteSaved(scope: ProjectWriteScope, policy: ReviewWorkspacePolicy, before: FileReadResult | null, after: FileReadResult): Promise<FileReadResult> {
    if (after.kind !== 'markdown' || after.content === before?.content) return after
    try {
      this.verify(scope)
      await this.assistant.workflow('activity', { workspace: scope.root, expectedRevision: policy.revision, key: 'note:' + fingerprint(JSON.stringify([after.path, before?.content, after.content, after.modifiedAt])), kind: 'note-edited', summary: `保存笔记：${path.relative(scope.root, after.path)}`, occurredAt: Date.now(), source: 'app-event', locator: path.relative(scope.root, after.path) })
      this.verify(scope)
      return after
    } catch {
      return { ...after, warnings: [...(after.warnings ?? []), '笔记已保存，但活动账本未能记录；复盘中可能缺少此次活动。'] }
    }
  }
}
