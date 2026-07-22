import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AiService,
  aiConversationMessages,
  chatEndpoint,
  imageGenerationEndpoint,
  imageGenerationRequestBody,
  imageGenerationResult,
  parseAiJsonResponse,
  reasoningRequestFields,
  resolveAiRequestTarget,
  responsesEndpoint,
  responsesResult
} from './ai'
import type { ChatImageAttachment, ImageGenerationRequest } from '../../src/shared/types'
import type { PdfTextService } from './pdf'
import type { ProjectService } from './project'
import type { ProjectSearchService } from './search'
import type { SettingsStore } from './settings'

afterEach(() => {
  vi.restoreAllMocks()
})

const tinyPng: ChatImageAttachment = {
  id: 'image-1',
  name: 'diagram.png',
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
  size: 8
}

const imageRequest: ImageGenerationRequest = {
  requestId: 'image-request-1',
  prompt: '  一张适合学习笔记的系统架构图  ',
  size: '1536x1024',
  quality: 'high'
}

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

  it('builds the GPT-Image endpoint from a host or versioned third-party base', () => {
    expect(imageGenerationEndpoint('https://images.example.com')).toBe(
      'https://images.example.com/v1/images/generations'
    )
    expect(imageGenerationEndpoint('https://images.example.com/openai/v1')).toBe(
      'https://images.example.com/openai/v1/images/generations'
    )
  })

  it('keeps a complete third-party GPT-Image endpoint unchanged', () => {
    expect(imageGenerationEndpoint('https://images.example.com/custom/v1/images/generations')).toBe(
      'https://images.example.com/custom/v1/images/generations'
    )
  })
})

describe('AI conversation image mapping', () => {
  it('maps user image attachments to Responses API input parts', () => {
    expect(aiConversationMessages('responses', [{
      role: 'user',
      content: '解释这张图',
      attachments: [tinyPng]
    }])).toEqual([{
      role: 'user',
      content: [
        { type: 'input_text', text: '解释这张图' },
        { type: 'input_image', image_url: tinyPng.dataUrl, detail: 'auto' }
      ]
    }])
  })

  it('maps user image attachments to Chat Completions content parts', () => {
    expect(aiConversationMessages('chat-completions', [{
      role: 'user',
      content: '',
      attachments: [tinyPng]
    }])).toEqual([{
      role: 'user',
      content: [
        { type: 'text', text: '请分析我发送的图片。' },
        { type: 'image_url', image_url: { url: tinyPng.dataUrl, detail: 'auto' } }
      ]
    }])
  })

  it('rejects malformed visual input but keeps assistant images out of visual input', () => {
    expect(() => aiConversationMessages('responses', [{
      role: 'user',
      content: 'bad image',
      attachments: [{ ...tinyPng, dataUrl: 'data:image/png;base64,not-base64!' }]
    }])).toThrow('图片附件不是有效的 Base64 data URL')

    expect(aiConversationMessages('chat-completions', [{
      role: 'assistant',
      content: 'generated image',
      attachments: [tinyPng]
    }])).toEqual([{ role: 'assistant', content: 'generated image' }])
  })

  it('adds verified generated-image paths to assistant history as text metadata', () => {
    expect(aiConversationMessages('responses', [{
      role: 'assistant',
      content: '已生成图片。',
      attachments: [{
        ...tinyPng,
        projectRelativePath: 'assets/ai-images/diagram.png',
        absolutePath: '/tmp/project/assets/ai-images/diagram.png'
      }]
    }])).toEqual([{
      role: 'assistant',
      content: [
        '已生成图片。',
        '',
        '[CoScribe 已验证的生成图片路径]',
        '图片：diagram.png',
        '项目相对路径：assets/ai-images/diagram.png',
        'Markdown 可用路径：/assets/ai-images/diagram.png',
        '本机绝对路径：/tmp/project/assets/ai-images/diagram.png'
      ].join('\n')
    }])
  })
})

describe('AI Markdown operation mapping', () => {
  it('passes a multi-file tool proposal to the project safety boundary', async () => {
    const prepareAiOperation = vi.fn().mockResolvedValue(undefined)
    const ai = new AiService(
      {} as SettingsStore,
      { prepareAiOperation } as unknown as ProjectService,
      {} as PdfTextService,
      {} as ProjectSearchService
    )
    const exposed = ai as unknown as {
      operationFromTool(tool: { name: string; arguments: string }): Promise<unknown>
    }
    const operations = [
      { kind: 'create', targetPath: 'notes/index.md', proposedContent: '# Index' },
      { kind: 'create', targetPath: 'notes/topic.md', proposedContent: '# Topic' }
    ]

    await exposed.operationFromTool({
      name: 'propose_markdown_operation',
      arguments: JSON.stringify({ operations, summary: 'Create notes' })
    })

    expect(prepareAiOperation).toHaveBeenCalledWith({
      kind: undefined,
      targetPath: undefined,
      proposedContent: undefined,
      operations,
      summary: 'Create notes'
    })
  })
})

describe('GPT-Image 2 request and response contract', () => {
  it('uses the OpenAI-compatible GPT-Image 2 request body', () => {
    expect(imageGenerationRequestBody(imageRequest)).toEqual({
      model: 'gpt-image-2',
      prompt: '一张适合学习笔记的系统架构图',
      size: '1536x1024',
      quality: 'high',
      output_format: 'jpeg',
      output_compression: 90,
      n: 1
    })
  })

  it('parses a base64 image response into a persistent chat attachment', () => {
    const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64')

    expect(imageGenerationResult({ data: [{ b64_json: jpegBase64 }] }, imageRequest, 1234)).toMatchObject({
      attachment: {
        name: 'gpt-image-2-1234.jpg',
        mimeType: 'image/jpeg',
        dataUrl: `data:image/jpeg;base64,${jpegBase64}`,
        size: 4
      },
      model: 'gpt-image-2',
      size: '1536x1024',
      quality: 'high',
      createdAt: 1234
    })
  })

  it('rejects missing, malformed, and unsupported base64 image results', () => {
    expect(() => imageGenerationResult({ data: [{}] }, imageRequest)).toThrow(
      '图片生成服务没有返回有效的 Base64 图片'
    )
    expect(() => imageGenerationResult({ data: [{ b64_json: 'not-base64!' }] }, imageRequest)).toThrow(
      '图片生成服务没有返回有效的 Base64 图片'
    )
    expect(() => imageGenerationResult({ data: [{ b64_json: Buffer.from('plain text').toString('base64') }] }, imageRequest)).toThrow(
      '图片生成服务返回了不支持的图片格式'
    )
  })

  it('posts to an exact third-party endpoint with the independent image API key', async () => {
    const endpoint = 'https://images.example.com/vendor/v1/images/generations'
    const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0x00]).toString('base64')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      data: [{ b64_json: jpegBase64 }]
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }))
    const settings = {
      get: vi.fn().mockResolvedValue({ imageBaseUrl: endpoint }),
      imageApiKey: vi.fn().mockResolvedValue('third-party-image-key')
    } as unknown as SettingsStore
    const persistGeneratedImage = vi.fn(async (attachment: ChatImageAttachment) => ({
      ...attachment,
      projectRelativePath: `assets/ai-images/${attachment.name}`,
      absolutePath: `/tmp/project/assets/ai-images/${attachment.name}`
    }))
    const ai = new AiService(
      settings,
      { persistGeneratedImage } as unknown as ProjectService,
      {} as PdfTextService,
      {} as ProjectSearchService
    )

    await expect(ai.generateImage(imageRequest)).resolves.toMatchObject({
      model: 'gpt-image-2',
      size: imageRequest.size,
      quality: imageRequest.quality
    })
    expect(settings.imageApiKey).toHaveBeenCalledOnce()
    expect(persistGeneratedImage).toHaveBeenCalledOnce()
    expect(fetchSpy).toHaveBeenCalledWith(endpoint, expect.objectContaining({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: 'Bearer third-party-image-key'
      },
      body: JSON.stringify(imageGenerationRequestBody(imageRequest)),
      redirect: 'error'
    }))
  })

  it('surfaces a third-party image error with the exact endpoint context', async () => {
    const endpoint = 'https://images.example.com/vendor/v1/images/generations'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'Image quota exhausted' }
    }), {
      status: 429,
      headers: { 'content-type': 'application/json' }
    }))
    const settings = {
      get: vi.fn().mockResolvedValue({ imageBaseUrl: endpoint }),
      imageApiKey: vi.fn().mockResolvedValue('third-party-image-key'),
      apiKey: vi.fn()
    } as unknown as SettingsStore
    const ai = new AiService(
      settings,
      {} as ProjectService,
      {} as PdfTextService,
      {} as ProjectSearchService
    )

    await expect(ai.generateImage(imageRequest)).rejects.toThrow(
      `AI 请求失败（HTTP 429，请求地址：${endpoint}）：Image quota exhausted`
    )
    expect(settings.imageApiKey).toHaveBeenCalledOnce()
    expect(settings.apiKey).not.toHaveBeenCalled()
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
