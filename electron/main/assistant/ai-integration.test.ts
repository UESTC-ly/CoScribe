import path from 'node:path'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_SETTINGS, type AiRequest } from '../../../src/shared/types'
import { AiService } from '../ai'
import type { PdfTextService } from '../pdf'
import type { ProjectService } from '../project'
import type { ProjectSearchService } from '../search'
import type { SettingsStore } from '../settings'
import type { AssistantService } from './service'
import type { PersonalMemoryContext } from '../../../src/shared/assistant'
import { fingerprint } from './automatic-memory'

afterEach(() => vi.restoreAllMocks())

function harness(options: { remote?: boolean; protocol?: 'responses' | 'chat-completions' | 'anthropic-messages'; stale?: boolean; unavailable?: boolean; layered?: boolean } = {}) {
  const protocol = options.protocol ?? 'chat-completions'
  const memory: PersonalMemoryContext = options.unavailable
    ? { prompt: '', revision: null, status: 'unavailable' }
    : options.remote
      ? { prompt: '', revision: 1, status: 'remote-blocked' }
      : { prompt: 'PERSONAL_MEMORY_SENTINEL', revision: 1, status: 'used' }
  const assistant = {
    observationGrant: vi.fn(async () => ({ automaticRevision: 0, workspaceRevision: 0, occurredAt: Date.now() })),
    observeChat: vi.fn(async () => undefined),
    context: vi.fn(async () => memory),
    assertCurrent: vi.fn(async () => { if (options.stale) throw new Error('个人记忆或授权已变化，请重新发送请求。') }),
    ...(options.layered ? {
      bootstrap: vi.fn(async (_query: string, _remote: boolean) => memory),
      search: vi.fn(async () => ({ revision: 1, status: 'used', hits: [{ kind: 'memory', id: '11111111-1111-4111-8111-111111111111', revision: 2, summary: '目标摘要' }] })),
      read: vi.fn(async () => ({ revision: 1, status: 'used', items: [{ text: 'FULL_MEMORY_SENTINEL', revision: 2 }] })),
      staleAnswers: vi.fn(async (_sessionId: string, _revision: number, _all = false) => [] as string[]),
      historyAccess: vi.fn(async (_remote: boolean) => ({ ...memory, prompt: '' })),
      beginAnswer: vi.fn(async () => undefined),
      recordAnswer: vi.fn(async () => undefined)
    } : {})
  }
  const projectPath = path.resolve('/tmp/assistant-ai-test')
  const project = { info: { path: projectPath, name: 'test' }, captureWriteScope: () => ({ root: projectPath, revision: 1 }) } as ProjectService
  const baseUrl = options.remote ? 'https://example.com/v1' : 'http://127.0.0.1:9876/v1'
  const service = new AiService({
    get: async () => ({ ...DEFAULT_SETTINGS, baseUrl, aiProvider: protocol === 'anthropic-messages' ? 'anthropic' : 'openai', anthropicBaseUrl: baseUrl, apiProtocol: protocol === 'responses' ? 'responses' : 'chat-completions', projectMemoryEnabled: false }),
    apiKey: async () => 'test-key',
    anthropicApiKey: async () => 'test-key'
  } as unknown as SettingsStore, project, {} as PdfTextService, {} as ProjectSearchService, undefined, assistant as unknown as AssistantService)
  const exposed = service as unknown as {
    validatedContext: () => Promise<{ text: string; sources: unknown[] }>
    run: (sender: WebContents, request: AiRequest, controller: AbortController) => Promise<void>
  }
  vi.spyOn(exposed, 'validatedContext').mockResolvedValue({ text: 'SELECTION_ONLY_SENTINEL', sources: [] })
  const response = protocol === 'responses'
    ? { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'test answer' }] }] }
    : protocol === 'anthropic-messages'
      ? { content: [{ type: 'text', text: 'test answer' }] }
      : { choices: [{ message: { role: 'assistant', content: 'test answer' } }] }
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } }))
  const send = vi.fn()
  const sender = { send, isDestroyed: () => false } as unknown as WebContents
  const request: AiRequest = {
    requestId: 'memory-test', sessionId: 'session', messages: [{ role: 'user', content: '帮我理解图论' }],
    context: { projectPath, projectName: 'test', pane: 'primary', scope: 'selection', kind: 'markdown', selection: 'SELECTED', referencedFiles: [], capturedAt: Date.now() }
  }
  return { assistant, fetchMock, send, run: (overrides: Partial<AiRequest> = {}, controller = new AbortController()) => exposed.run(sender, { ...request, ...overrides }, controller) }
}

describe('personal memory in AI requests', () => {
  it('observes only the directly submitted last user text, excluding history, attachments and model output', async () => {
    const { assistant, run } = harness()
    await run({ messages: [{ role: 'user', content: 'HISTORY_USER' }, { role: 'assistant', content: 'MODEL_INFERENCE' }, { role: 'user', content: '我正在学习图论' }] })
    expect(assistant.observeChat).toHaveBeenCalledWith(expect.any(String), 'session', '我正在学习图论', expect.objectContaining({ automaticRevision: 0 }))
    expect(JSON.stringify(assistant.observeChat.mock.calls)).not.toContain('HISTORY_USER')
    expect(JSON.stringify(assistant.observeChat.mock.calls)).not.toContain('MODEL_INFERENCE')
    assistant.observeChat.mockClear()
    await run({ messages: [{ role: 'user', content: 'OLD_USER' }, { role: 'assistant', content: 'LAST_ASSISTANT' }] })
    expect(assistant.observeChat).not.toHaveBeenCalled()
  })
  it('never observes organization, compaction or generated plans as current user facts', async () => {
    const { assistant, run } = harness()
    for (const operationMode of ['compact-session', 'organize-project-notes', 'generate-project-plan'] as const) await run({ operationMode })
    expect(assistant.observeChat).not.toHaveBeenCalled()
    expect(assistant.observationGrant).not.toHaveBeenCalled()
  })
  it('keeps the chat available and shows a gap when automatic capture fails', async () => {
    const { assistant, send, run } = harness()
    assistant.observeChat.mockRejectedValueOnce(new Error('storage unavailable'))
    await run()
    expect(send.mock.calls.some((call) => call[1].type === 'activity' && call[1].label.includes('未能记录'))).toBe(true)
    expect(send.mock.calls.some((call) => call[1].type === 'done')).toBe(true)
  })

  it.each(['responses', 'chat-completions', 'anthropic-messages'] as const)('uses the same guarded context for %s', async (protocol) => {
    const { assistant, fetchMock, send, run } = harness({ protocol })
    await run()
    expect(assistant.context).toHaveBeenCalledWith('帮我理解图论', false)
    expect(assistant.assertCurrent).toHaveBeenCalledOnce()
    const body = String(fetchMock.mock.calls[0]?.[1]?.body)
    expect(body).toContain('PERSONAL_MEMORY_SENTINEL')
    expect(body).toContain('SELECTION_ONLY_SENTINEL')
    expect(send.mock.calls.some((call) => call[1].type === 'done')).toBe(true)
  })

  it('does not send personal memory when the selected service is remote and unauthorized', async () => {
    const { assistant, fetchMock, run } = harness({ remote: true })
    await run()
    expect(assistant.context).toHaveBeenCalledWith('帮我理解图论', true)
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain('PERSONAL_MEMORY_SENTINEL')
  })

  it('refuses a stale context before the network call', async () => {
    const { fetchMock, send, run } = harness({ stale: true })
    await run()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(send.mock.calls.some((call) => call[1].type === 'error' && call[1].message.includes('授权已变化'))).toBe(true)
  })

  it('keeps ordinary chat available when memory storage is unavailable', async () => {
    const { fetchMock, send, run } = harness({ unavailable: true })
    await run()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain('PERSONAL_MEMORY_SENTINEL')
    expect(send.mock.calls.some((call) => call[1].type === 'activity' && call[1].label.includes('不可用'))).toBe(true)
  })

  it('does not add personal memories to session compaction', async () => {
    const { assistant, fetchMock, run } = harness()
    await run({ operationMode: 'compact-session' })
    expect(assistant.context).not.toHaveBeenCalled()
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).not.toContain('PERSONAL_MEMORY_SENTINEL')
  })
})

function toolResponse(protocol: string, name: string, input: unknown, id = 'call-1'): Response {
  const value = protocol === 'responses'
    ? { output: [{ type: 'reasoning', id: 'r-1', encrypted_content: 'OPAQUE_REASONING' }, { type: 'function_call', call_id: id, name, arguments: JSON.stringify(input) }] }
    : protocol === 'anthropic-messages'
      ? { content: [{ type: 'thinking', thinking: 'opaque', signature: 'SIGNED_THINKING' }, { type: 'tool_use', id, name, input }] }
      : { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(input) } }] } }] }
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
}

describe('memory search and read in the ordinary AI loop', () => {
  it.each(['responses', 'chat-completions', 'anthropic-messages'] as const)('continues a streamed memory call in %s', async (protocol) => {
    const { assistant, fetchMock, run } = harness({ protocol, layered: true })
    const args = JSON.stringify({ query: 'RAG' })
    const events = protocol === 'responses' ? [
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', id: 'reason-1', encrypted_content: 'STREAM_REASONING' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'stream-1', name: 'memory_search', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: args },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'stream-1', name: 'memory_search', arguments: args } }
    ] : protocol === 'anthropic-messages' ? [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'opaque' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'STREAM_SIGNATURE' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'stream-1', name: 'memory_search', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: args } },
      { type: 'content_block_stop', index: 1 }
    ] : [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'stream-1', function: { name: 'memory_search', arguments: '' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args } }] } }] }
    ]
    fetchMock.mockResolvedValueOnce(new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } }))
    await run()
    expect(assistant.search).toHaveBeenCalledWith({ query: 'RAG' }, false, expect.any(Object), expect.any(AbortSignal))
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const body = String(fetchMock.mock.calls[1][1]?.body)
    expect(body).toContain('stream-1')
    expect(body).toContain('目标摘要')
    if (protocol === 'responses') expect(body).toContain('STREAM_REASONING')
    if (protocol === 'anthropic-messages') expect(body).toContain('STREAM_SIGNATURE')
  })

  it.each(['responses', 'chat-completions', 'anthropic-messages'] as const)('progressively loads authorized memory in %s', async (protocol) => {
    const { assistant, fetchMock, send, run } = harness({ protocol, layered: true })
    const selection = { items: [{ kind: 'memory', id: '11111111-1111-4111-8111-111111111111', revision: 2 }] }
    fetchMock.mockResolvedValueOnce(toolResponse(protocol, 'memory_search', { query: 'RAG' }))
      .mockResolvedValueOnce(toolResponse(protocol, 'memory_read', selection, 'call-2'))
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(assistant.search).toHaveBeenCalledWith({ query: 'RAG' }, false, expect.objectContaining({ revision: 1 }), expect.any(AbortSignal))
    expect(assistant.read).toHaveBeenCalledWith(selection, false, expect.objectContaining({ revision: 1 }))
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))
    expect(JSON.stringify(bodies[0])).not.toContain('FULL_MEMORY_SENTINEL')
    expect(JSON.stringify(bodies[1])).toContain('目标摘要')
    expect(JSON.stringify(bodies[1])).not.toContain('FULL_MEMORY_SENTINEL')
    expect(JSON.stringify(bodies[2])).toContain('FULL_MEMORY_SENTINEL')
    if (protocol === 'responses') expect(JSON.stringify(bodies[2])).toContain('OPAQUE_REASONING')
    if (protocol === 'anthropic-messages') expect(JSON.stringify(bodies[2])).toContain('SIGNED_THINKING')
    expect(assistant.recordAnswer).toHaveBeenCalledWith(expect.any(String), 'test answer', 1, 'memory-test')
    expect(send.mock.calls.some((call) => call[1].type === 'done')).toBe(true)
  })

  it('keeps stable instructions and earlier tool results byte for byte on the next message', async () => {
    const { assistant, fetchMock, run } = harness({ layered: true })
    fetchMock.mockResolvedValueOnce(toolResponse('chat-completions', 'memory_search', { query: 'RAG' }))
    await run()
    const first = JSON.parse(String(fetchMock.mock.calls[1][1]?.body))
    assistant.bootstrap!.mockResolvedValueOnce({ prompt: 'NEW_RELEVANT_SUMMARY', revision: 1, status: 'used' })
    await run({ messages: [{ role: 'user', content: '帮我理解图论' }, { role: 'assistant', content: 'test answer' }, { role: 'user', content: '给我举例' }] })
    const next = JSON.parse(String(fetchMock.mock.calls[2][1]?.body))
    expect(next.messages.slice(0, first.messages.length)).toEqual(first.messages)
    expect(next.tools).toEqual(first.tools)
    expect(next.messages.at(-1).content).toContain('NEW_RELEVANT_SUMMARY')
    expect(next.messages.at(-1).content).toContain('给我举例')
  })

  it('filters affected old assistant answers and discards cached tools after a correction', async () => {
    const { assistant, fetchMock, run } = harness({ layered: true })
    fetchMock.mockResolvedValueOnce(toolResponse('chat-completions', 'memory_search', { query: 'RAG' }))
    await run()
    assistant.bootstrap!.mockResolvedValueOnce({ prompt: 'CORRECTED_MEMORY', revision: 2, status: 'used' })
    assistant.staleAnswers!.mockResolvedValue([fingerprint('test answer')])
    await run({ messages: [{ role: 'user', content: '帮我理解图论' }, { role: 'assistant', content: 'test answer' }, { role: 'user', content: '最近的目标呢' }] })
    const body = String(fetchMock.mock.calls[2][1]?.body)
    expect(body).toContain('CORRECTED_MEMORY')
    expect(body).not.toContain('目标摘要')
    expect(body).not.toContain('test answer')
    expect(body).not.toContain('PERSONAL_MEMORY_SENTINEL')
  })

  it('propagates memory provenance from earlier answers when the new question loads no new facts', async () => {
    const { assistant, run } = harness({ layered: true })
    assistant.bootstrap!.mockResolvedValueOnce({ prompt: '', revision: 1, status: 'empty' })
    assistant.staleAnswers!.mockImplementation(async (_session: unknown, _revision: unknown, all?: unknown) => all ? [fingerprint('OLDER_MEMORY_ANSWER')] : [])
    await run({ messages: [{ role: 'assistant', content: 'OLDER_MEMORY_ANSWER' }, { role: 'user', content: '继续解释' }] })
    expect(assistant.beginAnswer).toHaveBeenCalledOnce()
    expect(assistant.recordAnswer).toHaveBeenCalledWith(expect.any(String), 'test answer', 1, 'memory-test')
  })

  it('checks compaction history without injecting new memory and records inherited summary provenance', async () => {
    const { assistant, fetchMock, run } = harness({ layered: true })
    assistant.staleAnswers!.mockImplementation(async (_session: unknown, _revision: unknown, all?: unknown) => all ? [fingerprint('OLDER_MEMORY_ANSWER')] : [])
    await run({ operationMode: 'compact-session', messages: [{ role: 'user', content: '问题' }, { role: 'assistant', content: 'OLDER_MEMORY_ANSWER' }] })
    expect(assistant.bootstrap).not.toHaveBeenCalled()
    expect(assistant.historyAccess).toHaveBeenCalledWith(false)
    const body = String(fetchMock.mock.calls[0][1]?.body)
    expect(body).toContain('OLDER_MEMORY_ANSWER')
    expect(body).not.toContain('PERSONAL_MEMORY_SENTINEL')
    expect(assistant.recordAnswer).toHaveBeenCalledOnce()
  })

  it('omits all assistant history when an old interrupted answer cannot be matched exactly', async () => {
    const { assistant, fetchMock, run } = harness({ layered: true })
    assistant.staleAnswers!.mockResolvedValue(['*'])
    await run({ messages: [{ role: 'assistant', content: 'UNVERIFIED_FRAGMENT' }, { role: 'user', content: '当前提问' }] })
    expect(String(fetchMock.mock.calls[0][1]?.body)).not.toContain('UNVERIFIED_FRAGMENT')
  })

  it('filters revoked memory from application-wrapped conversation summaries without deleting direct user inputs', async () => {
    const { assistant, fetchMock, run } = harness({ layered: true, remote: true })
    assistant.staleAnswers!.mockResolvedValue([fingerprint('PRIVATE_SUMMARY')])
    await run({ messages: [
      { role: 'user', content: '[CoScribe 全量压缩的会话摘要；覆盖此前 4 条消息，原始记录仍保留在本地]\n\nPRIVATE_SUMMARY\n' },
      { role: 'user', content: '我主动提交的个人信息' }
    ] })
    const body = String(fetchMock.mock.calls[0][1]?.body)
    expect(body).not.toContain('PRIVATE_SUMMARY')
    expect(body).toContain('我主动提交的个人信息')
  })

  it('records visible text from an aborted memory-influenced stream', async () => {
    const { assistant, fetchMock, send, run } = harness({ layered: true })
    const controller = new AbortController()
    let reads = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(output) {
        if (reads++ === 0) output.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"PARTIAL_MEMORY_ANSWER"}}]}\n\n'))
        else { controller.abort(); output.close() }
      }
    })
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } }))
    await run({}, controller)
    expect(assistant.beginAnswer).toHaveBeenCalledOnce()
    expect(assistant.recordAnswer).toHaveBeenCalledWith(expect.any(String), 'PARTIAL_MEMORY_ANSWER', 1, 'memory-test')
    expect(send.mock.calls.some((call) => call[1].type === 'stopped')).toBe(true)
  })

  it('uses the current document and recent user topics to resolve an implicit question', async () => {
    const { assistant, run } = harness({ layered: true })
    await run({ messages: [{ role: 'user', content: '我在学检索增强生成' }, { role: 'assistant', content: 'UNTRUSTED_MODEL_TOPIC' }, { role: 'user', content: '我到什么阶段了' }] })
    expect(assistant.bootstrap!.mock.calls[0][0]).toContain('检索增强生成')
    expect(assistant.bootstrap!.mock.calls[0][0]).not.toContain('UNTRUSTED_MODEL_TOPIC')
  })

  it('stops before sending a tool result if memory or authorization changes', async () => {
    const { assistant, fetchMock, send, run } = harness({ layered: true })
    fetchMock.mockResolvedValueOnce(toolResponse('chat-completions', 'memory_search', { query: 'RAG' }))
    assistant.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('个人记忆或授权已变化'))
    await run()
    expect(assistant.search).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(send.mock.calls.some((call) => call[1].type === 'error' && call[1].message.includes('授权已变化'))).toBe(true)
  })

  it('omits memory tools for unauthorized remote services and rejects fabricated calls', async () => {
    const { assistant, fetchMock, send, run } = harness({ layered: true, remote: true })
    fetchMock.mockResolvedValueOnce(toolResponse('chat-completions', 'memory_search', { query: 'RAG' }))
    await run()
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.tools.some((tool: { function: { name: string } }) => tool.function.name.startsWith('memory_'))).toBe(false)
    expect(assistant.search).not.toHaveBeenCalled()
    expect(assistant.staleAnswers).toHaveBeenCalledWith(expect.any(String), 1, true)
    expect(send.mock.calls.some((call) => call[1].type === 'error' && call[1].message.includes('未获得授权'))).toBe(true)
  })

  it('refuses missing IDs and repeated calls without looping indefinitely', async () => {
    const { assistant, fetchMock, send, run } = harness({ layered: true })
    fetchMock.mockResolvedValueOnce(toolResponse('chat-completions', 'memory_search', { query: 'RAG' }, ''))
    await run()
    expect(assistant.search).not.toHaveBeenCalled()
    expect(send.mock.calls.some((call) => call[1].type === 'error' && call[1].message.includes('调用 ID'))).toBe(true)
    fetchMock.mockClear()
    fetchMock.mockResolvedValueOnce(toolResponse('chat-completions', 'memory_search', { query: 'RAG' }))
      .mockResolvedValueOnce(toolResponse('chat-completions', 'memory_search', { query: 'RAG' }, 'call-2'))
    await run()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(assistant.search).toHaveBeenCalledOnce()
    expect(send.mock.calls.some((call) => call[1].type === 'error' && call[1].message.includes('重复请求'))).toBe(true)
  })

  it.each(['responses', 'chat-completions', 'anthropic-messages'] as const)('fails closed on parallel memory calls in %s', async (protocol) => {
    const { assistant, fetchMock, send, run } = harness({ layered: true, protocol })
    const response = await toolResponse(protocol, 'memory_search', { query: 'RAG' }).json()
    const calls = protocol === 'responses' ? response.output : protocol === 'anthropic-messages' ? response.content : response.choices[0].message.tool_calls
    calls.push({ ...calls.at(-1), id: 'parallel', call_id: 'parallel' })
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } }))
    await run()
    expect(assistant.search).not.toHaveBeenCalled()
    expect(send.mock.calls.some((call) => call[1].type === 'error' && call[1].message.includes('多个工具'))).toBe(true)
  })
})
