import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SettingsStore } from '../settings'
import { memoryEmbeddingProvider } from './embeddings'

afterEach(() => vi.restoreAllMocks())
function settings(baseUrl = 'http://127.0.0.1:8080/v1', key = ''): SettingsStore {
  return { get: async () => ({ aiProfiles: [{ id: 'local', provider: 'openai', baseUrl }] }), apiKeyForProfile: vi.fn(async () => key) } as unknown as SettingsStore
}
const config = { profileId: 'local', model: 'embedding-model' }
function response(data: unknown): Response { return new Response(JSON.stringify({ data }), { headers: { 'Content-Type': 'application/json' } }) }

describe('optional memory embedding adapter', () => {
  it('does nothing until a provider and embedding model are explicitly configured', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    expect(await memoryEmbeddingProvider(settings(), { profileId: '', model: '' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('supports a local keyless endpoint and validates response ordering', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }]))
    const provider = (await memoryEmbeddingProvider(settings('http://127.0.0.1:8080/v1/chat/completions'), config))!
    expect(provider.remote).toBe(false)
    expect(await provider.embed(['first', 'second'])).toEqual([[1, 0], [0, 1]])
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/v1/embeddings', expect.objectContaining({ redirect: 'error', headers: { 'Content-Type': 'application/json' } }))
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ model: config.model, input: ['first', 'second'], encoding_format: 'float' })
  })

  it('uses the existing credential store for remote services and never embeds without a key', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(response([{ index: 0, embedding: [1, 0] }]))
    await expect(memoryEmbeddingProvider(settings('https://example.com/v1'), config)).rejects.toThrow('缺少 API Key')
    expect(fetchMock).not.toHaveBeenCalled()
    const provider = (await memoryEmbeddingProvider(settings('https://example.com/v1', 'safe-storage-key'), config))!
    expect(provider.remote).toBe(true)
    await provider.embed(['authorized fact'])
    expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Authorization: 'Bearer safe-storage-key' })
    expect(provider.identity).not.toContain('safe-storage-key')
  })

  it.each([
    { data: [{ index: 1, embedding: [1, 0] }] },
    { data: [{ index: 0, embedding: [] }] },
    { data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1] }] }
  ])('rejects incomplete, duplicate or invalid vectors: %j', async ({ data }) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response(data))
    const provider = (await memoryEmbeddingProvider(settings(), config))!
    await expect(provider.embed(['one'])).rejects.toThrow()
  })

  it('does not expose a provider error body containing sensitive data', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('PRIVATE_SENTINEL', { status: 500 }))
    const provider = (await memoryEmbeddingProvider(settings(), config))!
    await expect(provider.embed(['fact'])).rejects.toThrow('HTTP 500')
    await expect(provider.embed(['fact'])).rejects.not.toThrow('PRIVATE_SENTINEL')
  })
})
