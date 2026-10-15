import type { SettingsStore } from '../settings'
import { aiRequestHeaders, anthropicMessagesRequestBody, anthropicResult, resolveActiveAiRequestTarget, responsesResult } from '../ai'
import { record, responseBytes } from './providers'

export interface ResearchModel { complete: (system: string, input: unknown, signal: AbortSignal, verify: () => void) => Promise<unknown> }
export class ConfiguredResearchModel implements ResearchModel {
  constructor(private readonly settings: SettingsStore, private readonly fetcher: typeof fetch = (...args) => fetch(...args)) {}
  async complete(system: string, input: unknown, signal: AbortSignal, verify: () => void): Promise<unknown> {
    const preferences = await this.settings.get()
    const target = resolveActiveAiRequestTarget(preferences)
    if (!target.model.trim()) throw new Error('请先配置 AI 模型。')
    const key = target.provider === 'anthropic' ? await this.settings.anthropicApiKey() : await this.settings.apiKey()
    const content = JSON.stringify(input)
    const messages = [{ role: 'user' as const, content }]
    const body = target.protocol === 'anthropic-messages'
      ? { ...anthropicMessagesRequestBody({ model: target.model, effort: preferences.reasoningEffort, maxTokens: 6_000, system, messages }), stream: false }
      : target.protocol === 'responses'
        ? { model: target.model, instructions: system, input: messages, max_output_tokens: 6_000, stream: false }
        : { model: target.model, messages: [{ role: 'system', content: system }, ...messages], stream: false, max_tokens: 6_000 }
    verify()
    signal.throwIfAborted()
    const response = await this.fetcher(target.endpoint, { method: 'POST', redirect: 'error', headers: aiRequestHeaders(target.provider, key, 'application/json'), body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]) })
    if (!response.ok) { await response.body?.cancel(); throw new Error(`研究 AI 请求失败（HTTP ${response.status}）。`) }
    const value: unknown = JSON.parse((await responseBytes(response, 1024 * 1024)).toString('utf8'))
    verify()
    const text = target.protocol === 'responses' ? responsesResult(value).content : target.protocol === 'anthropic-messages' ? anthropicResult(value).content : record(record((record(value).choices as unknown[])?.[0]).message).content
    if (typeof text !== 'string') throw new Error('研究 AI 未返回文本。')
    try { return JSON.parse(text.replace(/^\s*```(?:json)?\s*/u, '').replace(/\s*```\s*$/u, '')) }
    catch { throw new Error('研究 AI 返回的结构化结果无效，请重试。') }
  }
}
