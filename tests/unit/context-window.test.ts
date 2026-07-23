import { describe, expect, it } from 'vitest'

import {
  defaultContextWindowTokens,
  estimateContentTokens,
  estimateTextTokens,
  planContextWindow
} from '../../src/lib/context-window'

describe('context window planning', () => {
  it('uses conservative provider defaults and allows a bounded override', () => {
    expect(defaultContextWindowTokens('openai', 'gpt-5.6-terra')).toBe(128_000)
    expect(defaultContextWindowTokens('anthropic', 'claude-sonnet-4-6')).toBe(200_000)

    const plan = planContextWindow({
      provider: 'openai',
      model: 'custom-model',
      windowTokens: 16_000,
      outputReserveTokens: 2_000,
      messages: [{ role: 'user', content: 'hello' }]
    })
    expect(plan.usage.windowTokens).toBe(16_000)
    expect(plan.usage.maximumInputTokens).toBe(14_000)
  })

  it('counts CJK conservatively without counting base64 image bytes as text', () => {
    expect(estimateTextTokens('中文测试')).toBe(4)
    expect(estimateTextTokens('hello world')).toBeLessThan(6)
    expect(estimateContentTokens([
      { type: 'text', text: '解释图片' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(50_000)}` } }
    ])).toBeLessThan(2_000)
  })

  it('keeps the full message list when comfortably within budget', () => {
    const messages = [
      { role: 'user' as const, content: '问题' },
      { role: 'assistant' as const, content: '回答' }
    ]
    const plan = planContextWindow({
      provider: 'openai',
      model: 'gpt-5.6-terra',
      messages,
      systemPrompt: '安全规则'
    })
    expect(plan.messages).toEqual(messages)
    expect(plan.usage.compactedMessageCount).toBe(0)
    expect(plan.usage.status).toBe('comfortable')
  })

  it('compresses early history but preserves recent turns and the UI-owned input array', () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: (index % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `${index}:${'长内容'.repeat(1_000)}`
    }))
    const snapshot = structuredClone(messages)
    const plan = planContextWindow({
      provider: 'openai',
      model: 'small',
      windowTokens: 8_192,
      outputReserveTokens: 1_024,
      minimumRecentMessages: 4,
      messages
    })

    expect(plan.usage.compactedMessageCount).toBeGreaterThan(0)
    expect(plan.messages[0]?.content).toContain('CoScribe 本地压缩的早期会话')
    expect(plan.messages.at(-1)).toEqual(messages.at(-1))
    expect(messages).toEqual(snapshot)
  })

  it('supports an explicit full-history compression pass without deleting recent messages', () => {
    const messages = Array.from({ length: 8 }, (_, index) => ({
      role: (index % 2 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `message-${index}`
    }))
    const plan = planContextWindow({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      messages,
      forceCompact: true
    })

    expect(plan.usage.forced).toBe(true)
    expect(plan.usage.compactedMessageCount).toBe(6)
    expect(plan.messages).toHaveLength(3)
    expect(plan.messages.slice(-2)).toEqual(messages.slice(-2))
  })

  it('truncates structured text and image input to the request budget', () => {
    const content = [
      { type: 'text', text: '超长图片说明'.repeat(2_000) },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ignored-by-estimator' } }
    ]
    const plan = planContextWindow({
      provider: 'anthropic',
      model: 'small-vision-model',
      windowTokens: 8_192,
      outputReserveTokens: 1_024,
      messages: [{ role: 'user', content }]
    })

    expect(plan.usage.truncated).toBe(true)
    expect(plan.usage.estimatedInputTokens).toBeLessThanOrEqual(plan.usage.maximumInputTokens)
    expect(plan.messages[0]?.content).not.toEqual(content)
    expect(JSON.stringify(plan.messages[0]?.content)).toContain('内容为适配上下文窗口已截断')
  })
})
