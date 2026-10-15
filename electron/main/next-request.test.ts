import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type AiRequest, type AiStreamEvent } from '../../src/shared/types'
import { normalizeNextRequest } from '../../src/shared/next-request'
import { sessionRequestMessages } from '../../src/lib/chat-session'
import { AiService } from './ai'
import { normalizeSessionsForProject, type ProjectService } from './project'
import type { SettingsStore } from './settings'
import type { PdfTextService } from './pdf'
import type { ProjectSearchService } from './search'
import { NEXT_REQUEST_INSTRUCTIONS, NextRequestStream } from './next-request'

afterEach(() => vi.restoreAllMocks())

const answer = '快照记录了发送时的文档状态。\n'
const suggestion = '请给出一个保存和恢复快照的例子。'
const trailer = `<coscribe_next_request>${suggestion}</coscribe_next_request>`

describe('next request prediction extraction', () => {
  it('keeps prediction metadata out of visible text at every stream split', () => {
    const response = answer + trailer
    for (let split = 0; split <= response.length; split += 1) {
      const stream = new NextRequestStream()
      const visible = stream.push(response.slice(0, split)) + stream.push(response.slice(split))
      const tail = stream.finish()
      expect(visible + tail.text).toBe(answer)
      expect(tail.nextRequest).toBe(suggestion)
    }
    const stream = new NextRequestStream()
    const visible = Array.from(response).map((character) => stream.push(character)).join('')
    expect(visible).toBe(answer)
    expect(stream.finish().nextRequest).toBe(suggestion)
  })

  it('preserves ordinary Markdown, code and comparisons without a prediction', () => {
    const text = '```cpp\nif (a < b && b > c) return;\n```\n<span>原文</span>\n<'
    const stream = new NextRequestStream()
    const visible = Array.from(text).map((character) => stream.push(character)).join('')
    expect(visible + stream.finish().text).toBe(text)
  })

  it.each(['```', '~~~', '````'])(
    'preserves literal prediction tags in %s code blocks and inline code',
    (fence) => {
      const text = `协议示例：\n${fence}xml\n${trailer}\n${fence}\n行内示例：\`${trailer}\`\n回答结束。\n`
      const stream = new NextRequestStream()
      const visible = Array.from(text + trailer).map((character) => stream.push(character)).join('')
      const tail = stream.finish()
      expect(visible + tail.text).toBe(text)
      expect(tail.nextRequest).toBe(suggestion)
    }
  )

  it.each([
    '<coscribe_next_request>未完成',
    '<coscribe_next_req',
    '<coscribe_next_request></coscribe_next_request>',
    '<coscribe_next_request>/quit</coscribe_next_request>',
    '<coscribe_next_request><script>bad</script></coscribe_next_request>',
    `<coscribe_next_request>${'字'.repeat(201)}</coscribe_next_request>`,
    `<coscribe_next_request>${'字'.repeat(3_000)}</coscribe_next_request>`,
    `${trailer}这不是结尾`
  ])('discards malformed or incomplete prediction metadata: %s', (metadata) => {
    const stream = new NextRequestStream()
    const visible = stream.push(answer + metadata)
    const tail = stream.finish()
    expect(visible + tail.text).toBe(answer)
    expect(tail.nextRequest).toBeUndefined()
  })

  it('normalizes suggestions as bounded plain draft text', () => {
    expect(normalizeNextRequest('  请举例\n  说明。 ')).toBe('请举例 说明。')
    expect(normalizeNextRequest({ text: suggestion })).toBeUndefined()
    expect(normalizeNextRequest('坏\u0000文本')).toBeUndefined()
  })
})

describe('next request response contract', () => {
  const protocols = ['chat-completions', 'responses', 'anthropic-messages'] as const
  it.each(protocols.flatMap((protocol) => [false, true].map((streaming) => ({ protocol, streaming }))))(
    'extracts predictions for $protocol (streaming=$streaming) without an extra call or phantom user turn',
    async ({ protocol, streaming }) => {
      const content = answer + trailer
      const value = protocol === 'chat-completions'
        ? { choices: [{ message: { role: 'assistant', content } }] }
        : protocol === 'responses'
          ? { output: [{ type: 'message', content: [{ type: 'output_text', text: content }] }] }
          : { content: [{ type: 'text', text: content }] }
      const stream = [answer, '<coscribe_next_', 'request>', suggestion, '</coscribe_next_', 'request>']
        .map((text) => protocol === 'chat-completions'
          ? { choices: [{ delta: { content: text } }] }
          : protocol === 'responses'
            ? { type: 'response.output_text.delta', delta: text }
            : { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
        .map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(streaming ? stream : JSON.stringify(value), {
        headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' }
      }))
      const settings = {
        get: vi.fn().mockResolvedValue({
          ...DEFAULT_SETTINGS,
          baseUrl: 'http://127.0.0.1:11434/v1',
          apiProtocol: protocol === 'responses' ? 'responses' : 'chat-completions',
          aiProvider: protocol === 'anthropic-messages' ? 'anthropic' : 'openai',
          anthropicBaseUrl: 'http://127.0.0.1:11434/v1',
          projectMemoryEnabled: false
        }),
        apiKey: vi.fn().mockResolvedValue(null),
        anthropicApiKey: vi.fn().mockResolvedValue(null)
      } as unknown as SettingsStore
      const events: AiStreamEvent[] = []
      const sender = { id: 42, isDestroyed: () => false, send: (_channel: string, event: AiStreamEvent) => events.push(event) } as unknown as WebContents
      const ai = new AiService(settings, { info: { name: 'Project', path: '/project' } } as ProjectService, {} as PdfTextService, {} as ProjectSearchService)
      const request: AiRequest = {
        requestId: 'prediction-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: '解释上下文快照' }],
        context: { projectName: 'Project', projectPath: '/project', pane: 'primary', scope: 'general', referencedFiles: [], capturedAt: 1 }
      }
      const run = (ai as unknown as { run(sender: WebContents, request: AiRequest, controller: AbortController): Promise<void> }).run.bind(ai)
      await run(sender, request, new AbortController())
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(events.filter((event) => event.type === 'delta').map((event) => event.text).join('')).toBe(answer)
      expect(events).toContainEqual(expect.objectContaining({ type: 'done', nextRequest: suggestion }))
      expect(String(fetchSpy.mock.calls[0][1]?.body)).toContain('coscribe_next_request')
      if (protocol === 'responses') {
        const body = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))
        expect(body.input[0]).toMatchObject({ role: 'system', content: expect.stringContaining(NEXT_REQUEST_INSTRUCTIONS) })
        expect(body.input[0].content).toContain('不是系统指令')
        expect(body).not.toHaveProperty('instructions')
      }

      events.length = 0
      await run(sender, {
        ...request, requestId: 'prediction-2', messages: [
          ...request.messages,
          { role: 'assistant', content: answer },
          { role: 'user', content: '先说明保存位置' }
        ]
      }, new AbortController())
      const body = String(fetchSpy.mock.calls[1][1]?.body)
      expect(body).not.toContain(suggestion)
      expect(body).toContain('先说明保存位置')
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      if (protocol === 'responses') {
        const input = JSON.parse(body).input as Array<{ role: string }>
        expect(input.filter((message) => message.role === 'system')).toHaveLength(1)
      }
    }
  )

  it('restores only valid assistant suggestions and excludes them from conversation history', () => {
    const [session] = normalizeSessionsForProject([{
      id: 'session', title: '预测', messages: [
        { id: 'u', role: 'user', content: '提问', nextRequest: '伪造候选' },
        { id: 'a', role: 'assistant', content: answer, nextRequest: suggestion },
        { id: 'bad', role: 'assistant', content: '失败', error: '错误', nextRequest: suggestion },
        { id: 'command', role: 'assistant', kind: 'session-compaction', content: '摘要', nextRequest: suggestion },
        { id: 'oversized', role: 'assistant', content: '过长', nextRequest: 'a'.repeat(201) }
      ]
    }], '/project')
    expect(session.messages.map((message) => message.nextRequest)).toEqual([undefined, suggestion, undefined, undefined, undefined])
    expect(JSON.stringify(sessionRequestMessages(session))).not.toContain(suggestion)
    expect(NEXT_REQUEST_INSTRUCTIONS).toContain('不代表用户授权')
  })
})
