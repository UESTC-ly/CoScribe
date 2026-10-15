import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../src/shared/types'
import type { SettingsStore } from '../settings'
import { ConfiguredResearchModel } from './model'

describe('configured research model compatibility', () => {
  it.each(['chat-completions', 'responses', 'anthropic-messages'] as const)('uses the configured %s endpoint and parses bounded JSON without tools', async (protocol) => {
    const settings = { get: async () => ({ ...DEFAULT_SETTINGS, aiProvider: protocol === 'anthropic-messages' ? 'anthropic' : 'openai', apiProtocol: protocol === 'responses' ? 'responses' : 'chat-completions', baseUrl: 'http://127.0.0.1:4567/v1', anthropicBaseUrl: 'http://127.0.0.1:4567', model: 'research-test', anthropicModel: 'anthropic-test' }), apiKey: async () => 'test-key', anthropicApiKey: async () => 'test-anthropic' } as SettingsStore
    const output = '{"queries":["graph neural networks"]}'
    const response = protocol === 'responses' ? { output: [{ type: 'message', content: [{ type: 'output_text', text: output }] }] } : protocol === 'anthropic-messages' ? { content: [{ type: 'text', text: output }] } : { choices: [{ message: { content: output } }] }
    const fetcher = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }))
    const verify = vi.fn()
    const result = await new ConfiguredResearchModel(settings, fetcher as typeof fetch).complete('Trusted workflow', { topic: 'graph' }, new AbortController().signal, verify)
    expect(result).toEqual({ queries: ['graph neural networks'] })
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toMatch(protocol === 'responses' ? /\/responses$/u : protocol === 'anthropic-messages' ? /\/v1\/messages$/u : /\/chat\/completions$/u)
    const body = JSON.parse(String(init.body))
    expect(body.stream).toBe(false)
    expect(body.tools).toBeUndefined()
    expect(init.redirect).toBe('error')
    expect(verify).toHaveBeenCalledTimes(2)
  })
  it('checks authorization immediately before network access and rejects malformed JSON', async () => {
    const settings = { get: async () => DEFAULT_SETTINGS, apiKey: async () => null } as SettingsStore
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'not json' } }] })))
    const model = new ConfiguredResearchModel(settings, fetcher as typeof fetch)
    await expect(model.complete('workflow', {}, new AbortController().signal, () => { throw new Error('revoked') })).rejects.toThrow('revoked')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(model.complete('workflow', {}, new AbortController().signal, () => undefined)).rejects.toThrow('结构化')
  })
})
