import path from 'node:path'
import { Worker } from 'node:worker_threads'

import type { MemorySearchResult, PersonalMemoryContext, PersonalMemorySnapshot, ReviewWorkspacePolicy } from '../../../src/shared/assistant'
import { automaticSchema, candidateSchema } from './workflows'
import { fingerprint } from './automatic-memory'
import { forgetSchema, memoryReadSchema, memorySearchSchema, policySchema, rememberSchema, searchPolicySchema, updateSchema, type AssistantCommand, type AssistantWorkerResponse } from './contract'
import { memoryEmbeddingProvider } from './embeddings'
import type { SettingsStore } from '../settings'

export class AssistantService {
  private worker: Worker | undefined
  private sequence = 0
  private closed = false
  private failure: Error | undefined
  private initialized = false
  private indexing: Promise<void> | undefined
  private embeddingAbort = new AbortController()
  private embeddingWarning = ''
  private readonly queryVectors = new Map<string, number[]>()
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(private readonly dataDirectory: string, private readonly workerPath: string, private readonly settings?: SettingsStore) {}

  private fail(error: Error): void {
    this.failure = error
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }

  private request<T>(command: AssistantCommand, payload?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('个人记忆服务已关闭。'))
    if (this.failure) return Promise.reject(this.failure)
    if (!this.worker) {
      this.worker = new Worker(this.workerPath, { workerData: { filePath: path.join(this.dataDirectory, 'assistant', 'assistant.sqlite') } })
      this.worker.unref()
      this.worker.on('message', (response: AssistantWorkerResponse) => {
        this.initialized = true
        const request = this.pending.get(response.id)
        if (!request) return
        clearTimeout(request.timer)
        this.pending.delete(response.id)
        if (response.error) request.reject(new Error(response.error))
        else request.resolve(response.value)
      })
      this.worker.on('error', () => this.fail(new Error('个人记忆存储进程不可用，操作结果需重启后核对。')))
      this.worker.on('exit', () => {
        if (!this.closed) this.fail(new Error('个人记忆存储进程已退出，请重启应用。'))
      })
    }
    const worker = this.worker
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        // A timed-out write may already be committed; never automatically retry.
        this.fail(new Error('个人记忆操作超时，结果需重新核对。请重启应用后查看，勿重复提交。'))
        void worker.terminate()
      }, this.initialized ? 5_000 : 30_000)
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer })
      worker.postMessage({ id, command, payload })
    })
  }

  list(): Promise<PersonalMemorySnapshot> { return this.request('list') }
  private async mutate(command: AssistantCommand, payload: unknown): Promise<PersonalMemorySnapshot> {
    this.embeddingAbort.abort()
    this.embeddingAbort = new AbortController()
    this.queryVectors.clear()
    const snapshot = await this.request<PersonalMemorySnapshot>(command, payload)
    this.scheduleIndex()
    return snapshot
  }
  remember(input: unknown): Promise<PersonalMemorySnapshot> { return this.mutate('remember', rememberSchema.parse(input)) }
  update(input: unknown): Promise<PersonalMemorySnapshot> { return this.mutate('update', updateSchema.parse(input)) }
  forget(input: unknown): Promise<PersonalMemorySnapshot> { return this.mutate('forget', forgetSchema.parse(input)) }
  setPolicy(input: unknown): Promise<PersonalMemorySnapshot> { return this.mutate('policy', policySchema.parse(input)) }
  async setSearch(input: unknown): Promise<PersonalMemorySnapshot> {
    const value = searchPolicySchema.parse(input)
    if (value.profileId && this.settings && !(await this.settings.get()).aiProfiles.some((profile) => profile.id === value.profileId && profile.provider === 'openai')) throw new Error('请选择现有的 OpenAI-compatible 服务配置。')
    return this.mutate('search-policy', value)
  }
  setAutomatic(input: unknown): Promise<PersonalMemorySnapshot> { return this.request('automatic', automaticSchema.parse(input)) }
  rebuildIndex(input: unknown): Promise<PersonalMemorySnapshot> { return this.mutate('rebuild-index', input) }
  resolveCandidate(input: unknown): Promise<PersonalMemorySnapshot> { return this.mutate('candidate', candidateSchema.parse(input)) }

  workflow<T>(command: Exclude<AssistantCommand, 'list' | 'remember' | 'update' | 'forget' | 'policy' | 'recall' | 'revision' | 'close' | 'automatic' | 'candidate'>, payload: unknown): Promise<T> {
    return this.request(command, payload)
  }

  async observationGrant(workspace: string): Promise<{ automaticRevision: number; workspaceRevision: number; occurredAt: number }> {
    const occurredAt = Date.now()
    const snapshot = await this.list()
    const review = await this.workflow<ReviewWorkspacePolicy>('workspace', workspace)
    return { automaticRevision: snapshot.automatic.revision, workspaceRevision: review.revision, occurredAt }
  }

  async observeChat(workspace: string, sessionId: string, text: string, grant: { automaticRevision: number; workspaceRevision: number; occurredAt: number }): Promise<void> {
    await this.workflow('observe', { workspace, sessionId, text, sourceKey: fingerprint(JSON.stringify([workspace, sessionId, text])), ...grant })
  }

  async context(query: string, remote: boolean): Promise<PersonalMemoryContext> {
    try {
      return await this.request('recall', { query: query.slice(0, 20_000), remote })
    } catch {
      return { prompt: '', revision: null, status: 'unavailable' }
    }
  }

  async bootstrap(query: string, remote: boolean): Promise<PersonalMemoryContext> {
    try {
      this.scheduleIndex()
      return await this.request('recall', { query: query.slice(0, 20_000), remote, coreOnly: true })
    } catch { return { prompt: '', revision: null, status: 'unavailable' } }
  }

  private scheduleIndex(): void {
    if (!this.settings || this.indexing || this.closed) return
    const signal = this.embeddingAbort.signal
    this.indexing = (async () => {
      const snapshot = await this.list()
      if (!snapshot.policy.enabled || !snapshot.search?.model) return
      const provider = await memoryEmbeddingProvider(this.settings!, snapshot.search)
      if (!provider || (provider.remote && !snapshot.policy.allowRemote)) return
      const input = { identity: provider.identity, remote: provider.remote, expectedRevision: snapshot.policy.revision }
      const corpus = await this.request<Array<{ id: string; text: string; textHash: string }>>('embedding-corpus', input)
      for (let index = 0; index < corpus.length; index += 32) {
        if (signal.aborted) return
        await this.assertCurrent({ prompt: 'index', revision: snapshot.policy.revision, status: 'used' })
        const batch = corpus.slice(index, index + 32)
        const vectors = await provider.embed(batch.map((item) => item.text), signal)
        if (signal.aborted) return
        await this.request('embedding-save', { ...input, items: batch.map((item, offset) => ({ id: item.id, textHash: item.textHash, vector: vectors[offset] })) })
      }
      this.embeddingWarning = ''
    })().catch(() => { if (!signal.aborted) this.embeddingWarning = '语义索引暂不可用，本次保留关键词检索；后续搜索会重试。' }).finally(() => {
      this.indexing = undefined
      if (signal.aborted && !this.closed) this.scheduleIndex()
    })
  }

  async search(input: unknown, remote: boolean, context: PersonalMemoryContext, signal?: AbortSignal): Promise<MemorySearchResult> {
    const query = memorySearchSchema.parse(input)
    await this.assertCurrent(context)
    let vector: number[] | undefined
    let identity: string | undefined
    let warning = this.embeddingWarning
    const snapshot = await this.list()
    if (snapshot.policy.enabled && (!remote || snapshot.policy.allowRemote) && this.settings && snapshot.search?.model) {
      try {
        const provider = await memoryEmbeddingProvider(this.settings, snapshot.search)
        if (provider && (!provider.remote || snapshot.policy.allowRemote)) {
          identity = provider.identity
          const key = fingerprint(JSON.stringify([identity, query.query]))
          vector = this.queryVectors.get(key) ?? (await provider.embed([query.query], signal))[0]
          if (vector) {
            this.queryVectors.set(key, vector)
            if (this.queryVectors.size > 64) this.queryVectors.delete(this.queryVectors.keys().next().value!)
          }
          if (this.indexing) warning = '语义索引正在更新，本次结果可能仅覆盖部分语义候选；关键词索引已核对。'
        } else warning = '未授权远程 embedding，使用本地关键词检索。'
      } catch {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        warning = '语义检索暂不可用，已回退到关键词检索。'
      }
    }
    const result = await this.request<MemorySearchResult>('memory-search', { ...query, remote, expectedRevision: context.revision ?? snapshot.policy.revision, ...(vector && identity ? { vector, identity } : {}) })
    this.scheduleIndex()
    return { ...result, ...(warning ? { warning } : {}) }
  }

  async read(input: unknown, remote: boolean, context: PersonalMemoryContext): Promise<unknown> {
    await this.assertCurrent(context)
    return this.request('memory-read', { ...memoryReadSchema.parse(input), remote, expectedRevision: context.revision })
  }

  async staleAnswers(sessionId: string, revision: number, all = false): Promise<string[]> {
    return this.request('answer-stale', { sessionId: fingerprint(sessionId), revision, all })
  }

  async historyAccess(remote: boolean): Promise<PersonalMemoryContext> {
    try { return await this.request('history-access', { remote }) }
    catch { return { prompt: '', revision: null, status: 'unavailable' } }
  }

  async beginAnswer(sessionId: string, requestId: string, revision: number): Promise<void> {
    await this.request('answer-begin', { sessionId: fingerprint(sessionId), requestId, revision })
  }

  async recordAnswer(sessionId: string, content: string, revision: number, requestId?: string): Promise<void> {
    await this.request('answer-record', { sessionId: fingerprint(sessionId), hash: fingerprint(content.trim()), revision, ...(requestId ? { requestId } : {}) })
  }

  async assertCurrent(context: PersonalMemoryContext): Promise<void> {
    if (context.revision === null) return
    if (await this.request<number>('revision') !== context.revision) {
      throw new Error('个人记忆或授权已变化，请重新发送请求。')
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    try {
      if (this.worker && !this.failure) await this.request('close')
    } finally {
      this.closed = true
      this.embeddingAbort.abort()
      this.fail(new Error('个人记忆服务已关闭。'))
      await this.worker?.terminate()
    }
  }
}
