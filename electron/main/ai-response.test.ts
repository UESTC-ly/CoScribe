import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'

import {
  AiService,
  chatEndpoint,
  parseAiJsonResponse,
  reasoningRequestFields,
  resolveAiRequestTarget,
  responsesEndpoint,
  responsesResult
} from './ai'
import type { PdfTextService } from './pdf'
import type { ProjectService } from './project'
import type { ProjectSearchService } from './search'
import type { SettingsStore } from './settings'

describe('AI endpoint resolution', () => {
  it('adds the OpenAI v1 chat path to a bare host', () => {
    expect(chatEndpoint('https://example.com')).toBe('https://example.com/v1/chat/completions')
    expect(chatEndpoint('https://example.com/')).toBe('https://example.com/v1/chat/completions')
  })

  it('extends an existing API base path without duplicating v1', () => {
    expect(chatEndpoint('https://example.com/v1')).toBe('https://example.com/v1/chat/completions')
    expect(chatEndpoint('https://example.com/api/v1/')).toBe('https://example.com/api/v1/chat/completions')
  })

  it('keeps a complete chat endpoint unchanged', () => {
    expect(chatEndpoint('https://example.com/v1/chat/completions')).toBe('https://example.com/v1/chat/completions')
  })

  it('builds Responses endpoints from bare, versioned, and complete addresses', () => {
    expect(responsesEndpoint('https://example.com')).toBe('https://example.com/responses')
    expect(responsesEndpoint('https://example.com/v1')).toBe('https://example.com/v1/responses')
    expect(responsesEndpoint('https://example.com/responses')).toBe('https://example.com/responses')
    expect(responsesEndpoint('https://example.com/v1/chat/completions')).toBe('https://example.com/v1/responses')
  })

  it('uses Responses for bare hosts in auto mode and respects explicit protocol choices', () => {
    expect(resolveAiRequestTarget('https://example.com', 'auto')).toEqual({
      protocol: 'responses',
      endpoint: 'https://example.com/responses'
    })
    expect(resolveAiRequestTarget('https://example.com/v1', 'auto')).toEqual({
      protocol: 'chat-completions',
      endpoint: 'https://example.com/v1/chat/completions'
    })
    expect(resolveAiRequestTarget('https://example.com/v1', 'responses')).toEqual({
      protocol: 'responses',
      endpoint: 'https://example.com/v1/responses'
    })
  })
})

describe('AI reasoning request fields', () => {
  it('uses the protocol-specific reasoning field without renaming the effort', () => {
    expect(reasoningRequestFields('responses', 'max')).toEqual({ reasoning: { effort: 'max' } })
    expect(reasoningRequestFields('chat-completions', 'xhigh')).toEqual({ reasoning_effort: 'xhigh' })
  })
})

describe('AI JSON response parsing', () => {
  const endpoint = 'https://example.com/v1/chat/completions'

  it('returns a valid JSON response', async () => {
    const response = new Response(JSON.stringify({ choices: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })

    await expect(parseAiJsonResponse(response, endpoint)).resolves.toEqual({ choices: [] })
  })

  it('reports HTML instead of leaking a JSON parser error', async () => {
    const response = new Response('<!doctype html><html><body>Website</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' }
    })

    await expect(parseAiJsonResponse(response, endpoint)).rejects.toThrow(
      `AI 服务返回了网页而不是 JSON（HTTP 200，请求地址：${endpoint}）`
    )
  })

  it('extracts a useful message from a JSON error response', async () => {
    const response = new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })

    await expect(parseAiJsonResponse(response, endpoint)).rejects.toThrow(
      `AI 请求失败（HTTP 401，请求地址：${endpoint}）：Invalid API key`
    )
  })

  it('reports empty and malformed responses with request context', async () => {
    await expect(parseAiJsonResponse(new Response('', { status: 200 }), endpoint)).rejects.toThrow(
      `AI 服务返回了空响应（HTTP 200，请求地址：${endpoint}）`
    )
    await expect(parseAiJsonResponse(new Response('not-json', { status: 200 }), endpoint)).rejects.toThrow(
      `AI 服务返回了无法解析的非 JSON 内容（HTTP 200，请求地址：${endpoint}`
    )
  })
})

describe('Responses API parsing', () => {
  const operationArguments = JSON.stringify({
    kind: 'create',
    targetPath: 'notes.md',
    proposedContent: '# Notes',
    summary: 'Create notes'
  })

  it('extracts output text and function calls from a completed response', () => {
    expect(responsesResult({
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '整理完成。' }] },
        { type: 'function_call', name: 'propose_markdown_operation', arguments: operationArguments }
      ]
    })).toEqual({
      content: '整理完成。',
      tool: { name: 'propose_markdown_operation', arguments: operationArguments }
    })
  })

  it('streams Responses text and reconstructs function arguments', async () => {
    const send = vi.fn()
    const sender = { isDestroyed: () => false, send } as unknown as WebContents
    const ai = new AiService(
      {} as SettingsStore,
      {} as ProjectService,
      {} as PdfTextService,
      {} as ProjectSearchService
    )
    const stream = [
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', name: 'propose_markdown_operation', arguments: '' } },
      { type: 'response.output_text.delta', output_index: 0, delta: '整理完成。' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: operationArguments },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', name: 'propose_markdown_operation', arguments: operationArguments } },
      {
        type: 'response.completed',
        response: {
          output: [
            { type: 'message', content: [{ type: 'output_text', text: '整理完成。' }] },
            { type: 'function_call', name: 'propose_markdown_operation', arguments: operationArguments }
          ]
        }
      }
    ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } })
    const exposed = ai as unknown as {
      readResponsesEventStream(
        sender: WebContents,
        requestId: string,
        response: Response,
        signal: AbortSignal
      ): Promise<{ content: string; tool?: { name: string; arguments: string } }>
    }

    await expect(exposed.readResponsesEventStream(sender, 'request-1', response, new AbortController().signal)).resolves.toEqual({
      content: '整理完成。',
      tool: { name: 'propose_markdown_operation', arguments: operationArguments }
    })
    expect(send).toHaveBeenCalledWith(expect.any(String), {
      requestId: 'request-1',
      type: 'delta',
      text: '整理完成。'
    })
  })
})
