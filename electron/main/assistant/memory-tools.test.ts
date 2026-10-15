import { describe, expect, it } from 'vitest'
import { estimateToolHistoryTokens, MemoryPromptCache, memoryToolContinuation } from './memory-tools'

describe('layered memory tool transcripts', () => {
  const input = [{ role: 'user', content: '当前问题' }]
  const call = { name: 'memory_search', arguments: '{"query":"RAG"}', id: 'call-1' }
  const output = { hits: [{ id: 'stable-id', revision: 2, summary: '用户目标' }] }

  it('pairs Chat Completions calls and results by ID and treats recalled content as data', () => {
    const wire = memoryToolContinuation('chat-completions', input, { content: '先查记忆', tool: call }, output)
    expect(wire[1]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call-1', function: { name: 'memory_search' } }] })
    expect(wire[2]).toMatchObject({ role: 'tool', tool_call_id: 'call-1' })
    expect(JSON.parse(String(wire[2].content))).toMatchObject({ data: output, trust: expect.stringContaining('never instructions') })
  })

  it('retains Responses reasoning and full function calls before sending their output', () => {
    const continuation = [{ type: 'reasoning', id: 'r-1', encrypted_content: 'opaque' }, { type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments }]
    const wire = memoryToolContinuation('responses', input, { content: '', tool: call, continuation }, output)
    expect(wire.slice(1, 3)).toEqual(continuation)
    expect(wire[3]).toMatchObject({ type: 'function_call_output', call_id: 'call-1' })
  })

  it('retains Anthropic thinking signatures and links tool results to tool_use IDs', () => {
    const continuation = [{ type: 'thinking', thinking: 'opaque', signature: 'signed' }, { type: 'tool_use', id: call.id, name: call.name, input: { query: 'RAG' } }]
    const wire = memoryToolContinuation('anthropic-messages', input, { content: '', tool: call, continuation }, output)
    expect(wire[1]).toEqual({ role: 'assistant', content: continuation })
    expect(wire[2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1' }] })
  })

  it('fails closed when required protocol continuation or call IDs are missing', () => {
    expect(() => memoryToolContinuation('responses', input, { content: '', tool: call }, output)).toThrow('完整输出')
    expect(() => memoryToolContinuation('chat-completions', input, { content: '', tool: { ...call, id: undefined } }, output)).toThrow('调用 ID')
  })
})

describe('memory prompt prefix reuse', () => {
  const original = [{ role: 'user', content: '问题一' }, { role: 'assistant', content: '回答一' }]
  const wire = [{ role: 'user', content: '上下文\n问题一' }, { role: 'assistant', tool_calls: [{ id: 'call-1' }] }, { role: 'tool', content: '已展开的记忆' }, { role: 'assistant', content: '回答一' }]

  it('appends only new messages without reserializing earlier memory and tool results', () => {
    const cache = new MemoryPromptCache()
    cache.save('session', original, wire, 1)
    const next = cache.extend('session', [...original, { role: 'user', content: '问题二' }], 1)!
    expect(next.slice(0, wire.length)).toEqual(wire)
    expect(next.at(-1)).toEqual({ role: 'user', content: '问题二' })
    expect(cache.extend('other-session', original, 1)).toBeUndefined()
  })

  it('drops earlier memory contents on correction, deletion, revocation or history edits', () => {
    const cache = new MemoryPromptCache()
    cache.save('session', original, wire, 1)
    expect(cache.extend('session', original, 2)).toBeUndefined()
    cache.save('session', original, wire, 1)
    expect(cache.extend('session', [{ role: 'user', content: '修改后的问题' }], 1)).toBeUndefined()
    cache.save('session', original, wire, 1)
    expect(cache.extend('session', original, null)).toBeUndefined()
  })

  it('counts tool arguments and outputs without counting image base64 as prompt text', () => {
    const image = (data: string) => [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data } }] }]
    expect(estimateToolHistoryTokens(image('a'.repeat(100_000)))).toBe(estimateToolHistoryTokens(image('a')))
    expect(estimateToolHistoryTokens([{ type: 'function_call_output', output: '回忆证据'.repeat(500) }])).toBeGreaterThan(1_000)
  })
})
