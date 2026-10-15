import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SettingsStore } from '../settings'
import type { AssistantCommand } from './contract'
import type { AssistantDatabase } from './database'
import { AssistantService } from './service'

const sqlite = await import('node:sqlite').catch(() => null)
const DatabaseClass = sqlite ? (await import('./database')).AssistantDatabase : null
let directory: string
let database: AssistantDatabase
let service: AssistantService
let indexing: { indexing?: Promise<void>; request: (command: AssistantCommand, payload?: unknown) => Promise<unknown> }

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'coscribe-memory-service-'))
  database = new DatabaseClass!(path.join(directory, 'assistant.sqlite'))
  const settings = { get: async () => ({ aiProfiles: [{ id: 'remote', provider: 'openai', baseUrl: 'https://example.com/v1' }] }), apiKeyForProfile: async () => 'mock-key' } as unknown as SettingsStore
  service = new AssistantService(directory, 'unused-worker', settings)
  indexing = service as unknown as typeof indexing
  // Exercise the real service and repository without launching Electron or a worker.
  vi.spyOn(indexing, 'request').mockImplementation(async (command, payload) => database.execute(command, payload))
})
afterEach(async () => {
  await service.close()
  database.close()
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})
async function settleIndex(): Promise<void> {
  for (let step = 0; step < 5 && indexing.indexing; step += 1) await indexing.indexing
}
async function configure(allowRemote: boolean): Promise<void> {
  await service.remember({ category: 'goal', text: '学习 RAG' })
  await service.setSearch({ profileId: 'remote', model: 'mock-embedding', expectedRevision: (await service.list()).policy.revision })
  await service.setPolicy({ enabled: true, allowRemote, expectedRevision: (await service.list()).policy.revision })
  await settleIndex()
}
function mockEmbeddings() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
    const input = JSON.parse(String(init?.body)).input as string[]
    return new Response(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }), { headers: { 'Content-Type': 'application/json' } })
  })
}

describe.skipIf(!sqlite)('memory service permission, indexing and fallback', () => {
  it('keeps default storage and recall free of embedding network calls', async () => {
    const fetchMock = mockEmbeddings()
    await service.remember({ category: 'goal', text: '学习 RAG' })
    expect(await service.bootstrap('RAG', false)).toMatchObject({ status: 'disabled', prompt: '' })
    await settleIndex()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not send a body or query to remote embedding without the separate grant', async () => {
    const fetchMock = mockEmbeddings()
    await configure(false)
    const context = await service.bootstrap('RAG', false)
    const result = await service.search({ query: 'RAG' }, false, context)
    await settleIndex()
    expect(result.hits).toHaveLength(1)
    expect(result.warning).toContain('未授权远程 embedding')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('embeds only changed bodies, caches query vectors and invalidates corrected indexes', async () => {
    const fetchMock = mockEmbeddings()
    await configure(true)
    expect(fetchMock).toHaveBeenCalledOnce()
    const context = await service.bootstrap('RAG', true)
    await settleIndex()
    await service.search({ query: 'RAG' }, true, context)
    await service.search({ query: 'RAG' }, true, context)
    await settleIndex()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const item = (await service.list()).items[0]
    await service.update({ id: item.id, category: 'goal', text: '学习 RAG 检索评估', expectedRevision: item.revision })
    await settleIndex()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[2][1]?.body)).toContain('检索评估')
    await expect(service.search({ query: 'RAG' }, true, context)).rejects.toThrow('授权已变化')
  })

  it('retains lexical hits and reports coverage when embedding fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('provider failure', { status: 500 }))
    await configure(true)
    const context = await service.bootstrap('RAG', true)
    const result = await service.search({ query: 'RAG' }, true, context)
    expect(result.hits).toHaveLength(1)
    expect(result.warning).toContain('回退到关键词检索')
  })

  it('cancels an in-flight index on revocation without saving a late vector', async () => {
    let finish!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { finish = resolve })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(response)
    await service.remember({ category: 'goal', text: '学习 RAG' })
    await service.setSearch({ profileId: 'remote', model: 'mock-embedding', expectedRevision: (await service.list()).policy.revision })
    await service.setPolicy({ enabled: true, allowRemote: true, expectedRevision: (await service.list()).policy.revision })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    const signal = fetchMock.mock.calls[0][1]?.signal
    await service.setPolicy({ enabled: false, allowRemote: false, expectedRevision: (await service.list()).policy.revision })
    expect(signal?.aborted).toBe(true)
    finish(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { headers: { 'Content-Type': 'application/json' } }))
    await settleIndex()
    const context = await service.bootstrap('RAG', true)
    expect(await service.search({ query: 'RAG' }, true, context)).toMatchObject({ status: 'disabled', hits: [] })
    expect(fetchMock).toHaveBeenCalledOnce()
  })
})
