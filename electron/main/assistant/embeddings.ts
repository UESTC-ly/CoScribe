import { z } from 'zod'
import { isLoopbackHost, sanitizeBaseUrl, type SettingsStore } from '../settings'
import type { MemorySearchPolicy } from '../../../src/shared/assistant'

export interface MemoryEmbeddingProvider {
  identity: string
  remote: boolean
  embed: (texts: string[], signal?: AbortSignal) => Promise<number[][]>
}

export async function memoryEmbeddingProvider(settings: SettingsStore, config: MemorySearchPolicy): Promise<MemoryEmbeddingProvider | null> {
  if (!config.profileId || !config.model) return null
  const profile = (await settings.get()).aiProfiles.find((profile) => profile.id === config.profileId && profile.provider === 'openai')
  if (!profile) throw new Error('记忆 embedding 服务不存在，请重新选择。')
  const base = sanitizeBaseUrl(profile.baseUrl, '', '记忆 embedding 服务').replace(/\/(?:chat\/completions|responses)\/?$/u, '').replace(/\/+$/u, '')
  const endpoint = base + '/embeddings'
  const remote = !isLoopbackHost(new URL(endpoint).hostname)
  const key = await settings.apiKeyForProfile(profile.id)
  if (remote && !key) throw new Error('记忆 embedding 服务缺少 API Key。')
  const identity = JSON.stringify([endpoint, config.model])
  return {
    identity, remote,
    async embed(texts, signal) {
      const response = await fetch(endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(8_000), ...(signal ? [signal] : [])]),
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify({ model: config.model, input: texts, encoding_format: 'float' })
      })
      if (!response.ok) throw new Error(`记忆 embedding 服务失败（HTTP ${response.status}）。`)
      // Do not expose endpoint responses, credentials or memory bodies in logs.
      if (!response.body) throw new Error('记忆 embedding 响应为空。')
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let body = ''
      let size = 0
      try {
        while (true) {
          const chunk = await reader.read()
          size += chunk.value?.byteLength ?? 0
          if (size > 10_000_000) { await reader.cancel(); throw new Error('记忆 embedding 响应过大。') }
          body += decoder.decode(chunk.value, { stream: !chunk.done })
          if (chunk.done) break
        }
      } finally { reader.releaseLock() }
      const value = z.object({ data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.array(z.number().finite()).min(1).max(8_192) })).max(32) }).parse(JSON.parse(body))
      const ordered = value.data.sort((a, b) => a.index - b.index)
      if (ordered.length !== texts.length || ordered.some((item, index) => item.index !== index || item.embedding.length !== ordered[0]!.embedding.length)) throw new Error('记忆 embedding 数量或维度无效。')
      return ordered.map((item) => item.embedding)
    }
  }
}
