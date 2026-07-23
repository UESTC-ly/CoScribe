import type { AiProvider, ContextWindowUsage } from '../shared/types'

export interface ContextWindowMessage {
  role: 'user' | 'assistant' | 'system'
  content: unknown
}

export interface ContextWindowPlanOptions<T extends ContextWindowMessage> {
  provider: AiProvider
  model: string
  messages: readonly T[]
  systemPrompt?: string
  windowTokens?: number
  outputReserveTokens?: number
  forceCompact?: boolean
  autoCompact?: boolean
  minimumRecentMessages?: number
}

export interface ContextWindowPlan<T extends ContextWindowMessage> {
  messages: T[]
  systemPrompt: string
  usage: ContextWindowUsage
}

const IMAGE_TOKEN_ESTIMATE = 1_200
const MESSAGE_OVERHEAD_TOKENS = 6
const MINIMUM_WINDOW_TOKENS = 8_192
const MAXIMUM_WINDOW_TOKENS = 2_000_000
const DEFAULT_OUTPUT_RESERVE = 8_192
const COMPACTED_SUMMARY_TOKEN_LIMIT = 4_000

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(maximum, Math.max(minimum, numeric))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isImagePart(part: Record<string, unknown>): boolean {
  const type = typeof part.type === 'string' ? part.type : ''
  return (
    type === 'image' ||
    type === 'input_image' ||
    type === 'image_url' ||
    isRecord(part.image_url) ||
    typeof part.image_url === 'string'
  )
}

function isCjkOrWide(character: string): boolean {
  return /[\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff]|[^\u0000-\u00ff]/u.test(character)
}

function characterTokenUnits(character: string): number {
  if (/\s/u.test(character)) return 0.12
  if (isCjkOrWide(character)) return 1
  if (/[A-Za-z0-9_]/u.test(character)) return 0.25
  return 0.5
}

/**
 * Fast, dependency-free token approximation for local budgeting.
 * It deliberately errs slightly high for CJK and mixed technical prose.
 */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  let units = 0
  for (const character of text) units += characterTokenUnits(character)
  return Math.max(1, Math.ceil(units))
}

export function estimateContentTokens(content: unknown): number {
  if (typeof content === 'string') return estimateTextTokens(content)
  if (Array.isArray(content)) {
    return content.reduce((total, part) => {
      if (!isRecord(part)) return total + estimateContentTokens(part)
      if (isImagePart(part)) return total + IMAGE_TOKEN_ESTIMATE
      if (typeof part.text === 'string') return total + estimateTextTokens(part.text)
      if (typeof part.content === 'string') return total + estimateTextTokens(part.content)
      return total + 12
    }, 0)
  }
  if (isRecord(content)) {
    if (typeof content.text === 'string') return estimateTextTokens(content.text)
    return 12
  }
  return 0
}

export function estimateMessageTokens(message: ContextWindowMessage): number {
  return MESSAGE_OVERHEAD_TOKENS + estimateContentTokens(message.content)
}

export function defaultContextWindowTokens(provider: AiProvider, model: string): number {
  const normalized = model.trim().toLowerCase()
  if (provider === 'anthropic' || normalized.startsWith('claude-')) return 200_000
  if (normalized.startsWith('gpt-5.6-')) return 128_000
  return 64_000
}

function truncateText(text: string, maximumTokens: number): string {
  if (estimateTextTokens(text) <= maximumTokens) return text
  if (maximumTokens <= 32) return Array.from(text).slice(0, Math.max(0, maximumTokens)).join('')
  const marker = '\n\n[CoScribe：内容为适配上下文窗口已截断]\n\n'
  const markerTokens = estimateTextTokens(marker)
  const availableUnits = Math.max(1, maximumTokens - markerTokens)
  const headBudget = availableUnits * 0.62
  const tailBudget = availableUnits - headBudget
  const characters = Array.from(text)
  let headUnits = 0
  let headLength = 0
  while (headLength < characters.length) {
    const units = characterTokenUnits(characters[headLength]!)
    if (headUnits + units > headBudget) break
    headUnits += units
    headLength += 1
  }
  let tailUnits = 0
  let tailStart = characters.length
  while (tailStart > headLength) {
    const units = characterTokenUnits(characters[tailStart - 1]!)
    if (tailUnits + units > tailBudget) break
    tailUnits += units
    tailStart -= 1
  }
  return `${characters.slice(0, headLength).join('')}${marker}${characters.slice(tailStart).join('')}`
}

function truncateStructuredContent(content: unknown, maximumTokens: number): unknown {
  if (typeof content === 'string') return truncateText(content, maximumTokens)
  if (!Array.isArray(content) || estimateContentTokens(content) <= maximumTokens) return content

  const textReserve = Math.min(64, maximumTokens)
  const maximumImages = Math.max(0, Math.floor((maximumTokens - textReserve) / IMAGE_TOKEN_ESTIMATE))
  let keptImages = 0
  const parts = content.flatMap((part) => {
    if (!isRecord(part)) return [part]
    if (!isImagePart(part)) return [{ ...part }]
    if (keptImages >= maximumImages) return []
    keptImages += 1
    return [{ ...part }]
  })

  const textFields: Array<{ index: number; key: 'text' | 'content'; value: string }> = []
  parts.forEach((part, index) => {
    if (!isRecord(part)) return
    if (typeof part.text === 'string') textFields.push({ index, key: 'text', value: part.text })
    else if (typeof part.content === 'string') textFields.push({ index, key: 'content', value: part.content })
  })
  const textTokens = textFields.reduce((sum, field) => sum + estimateTextTokens(field.value), 0)
  const nonTextTokens = parts.reduce((sum, part) => {
    if (!isRecord(part)) return sum + estimateContentTokens(part)
    if (typeof part.text === 'string') return sum + estimateContentTokens([{ ...part, text: '' }])
    if (typeof part.content === 'string') return sum + estimateContentTokens([{ ...part, content: '' }])
    return sum + estimateContentTokens([part])
  }, 0)
  let remainingTextBudget = Math.max(0, maximumTokens - nonTextTokens)
  let remainingOriginalTextTokens = textTokens

  for (const field of textFields) {
    const fieldTokens = estimateTextTokens(field.value)
    const allocation = remainingOriginalTextTokens > 0
      ? Math.max(0, Math.floor(remainingTextBudget * (fieldTokens / remainingOriginalTextTokens)))
      : 0
    const part = parts[field.index]
    if (isRecord(part)) {
      part[field.key] = truncateText(field.value, allocation)
      remainingTextBudget = Math.max(0, remainingTextBudget - estimateTextTokens(part[field.key] as string))
      remainingOriginalTextTokens = Math.max(0, remainingOriginalTextTokens - fieldTokens)
    }
  }

  while (estimateContentTokens(parts) > maximumTokens) {
    let imageIndex = -1
    for (let index = parts.length - 1; index >= 0; index -= 1) {
      const part = parts[index]
      if (isRecord(part) && isImagePart(part)) {
        imageIndex = index
        break
      }
    }
    if (imageIndex < 0) break
    parts.splice(imageIndex, 1)
  }
  return parts
}

function summarizeText(content: unknown): string {
  if (typeof content !== 'string') {
    if (Array.isArray(content)) {
      const text = content
        .filter(isRecord)
        .flatMap((part) => typeof part.text === 'string' ? [part.text] : [])
        .join(' ')
      return text || '[包含图片或结构化内容]'
    }
    return '[非文本内容]'
  }
  const normalized = content.replace(/\s+/gu, ' ').trim()
  if (normalized.length <= 360) return normalized
  return `${normalized.slice(0, 240)} … ${normalized.slice(-100)}`
}

function compactedSummary<T extends ContextWindowMessage>(messages: readonly T[]): T {
  const lines = messages.map((message, index) => {
    const label = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : '系统'
    return `${index + 1}. ${label}：${summarizeText(message.content)}`
  })
  const content = truncateText([
    `[CoScribe 本地压缩的早期会话，共 ${messages.length} 条；原始聊天仍保留在界面中]`,
    '以下内容仅用于延续上下文，若与当前项目资料冲突，以当前资料和用户最新请求为准。',
    '',
    ...lines
  ].join('\n'), COMPACTED_SUMMARY_TOKEN_LIMIT)
  return { role: 'user', content } as T
}

function truncateMessage<T extends ContextWindowMessage>(message: T, maximumTokens: number): T {
  return { ...message, content: truncateStructuredContent(message.content, maximumTokens) }
}

function usageStatus(percent: number): ContextWindowUsage['status'] {
  if (percent >= 90) return 'critical'
  if (percent >= 70) return 'watch'
  return 'comfortable'
}

export function planContextWindow<T extends ContextWindowMessage>(
  options: ContextWindowPlanOptions<T>
): ContextWindowPlan<T> {
  const windowTokens = boundedInteger(
    options.windowTokens,
    defaultContextWindowTokens(options.provider, options.model),
    MINIMUM_WINDOW_TOKENS,
    MAXIMUM_WINDOW_TOKENS
  )
  const outputReserveTokens = boundedInteger(
    options.outputReserveTokens,
    DEFAULT_OUTPUT_RESERVE,
    1_024,
    Math.max(1_024, Math.floor(windowTokens / 2))
  )
  const maximumInputTokens = Math.max(1_024, windowTokens - outputReserveTokens)
  const maximumSystemTokens = Math.max(512, Math.floor(maximumInputTokens * 0.58))
  const originalSystemPrompt = options.systemPrompt ?? ''
  const systemPrompt = truncateText(originalSystemPrompt, maximumSystemTokens)
  const systemTokens = estimateTextTokens(systemPrompt)
  const messageBudget = Math.max(512, maximumInputTokens - systemTokens)
  const originalMessages = options.messages.map((message) => ({ ...message }))
  const originalMessageTokens = originalMessages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  const minimumRecentMessages = boundedInteger(options.minimumRecentMessages, 6, 2, 20)
  const shouldCompact = Boolean(options.forceCompact) ||
    (options.autoCompact !== false && originalMessageTokens > messageBudget)

  let messages = originalMessages
  let compactedMessageCount = 0
  let truncated = systemPrompt !== originalSystemPrompt

  if (shouldCompact && originalMessages.length > 2) {
    const recentCount = options.forceCompact
      ? Math.min(2, originalMessages.length)
      : Math.min(minimumRecentMessages, originalMessages.length)
    const splitAt = Math.max(1, originalMessages.length - recentCount)
    const compacted = originalMessages.slice(0, splitAt)
    compactedMessageCount = compacted.length
    messages = [compactedSummary(compacted), ...originalMessages.slice(splitAt)]
  }

  while (shouldCompact && messages.length > 1 && messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) > messageBudget) {
    const summaryFirst = typeof messages[0]?.content === 'string' &&
      messages[0].content.startsWith('[CoScribe 本地压缩')
    messages.splice(summaryFirst && messages.length > 2 ? 1 : 0, 1)
    compactedMessageCount = Math.max(compactedMessageCount, originalMessages.length - messages.length)
    truncated = true
  }

  let messageTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
  if (shouldCompact && messageTokens > messageBudget && messages.length) {
    const latestIndex = messages.length - 1
    const otherTokens = messages.reduce(
      (sum, message, index) => index === latestIndex ? sum : sum + estimateMessageTokens(message),
      0
    )
    messages[latestIndex] = truncateMessage(
      messages[latestIndex],
      Math.max(64, messageBudget - otherTokens - MESSAGE_OVERHEAD_TOKENS)
    )
    messageTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
    truncated = true
  }

  const estimatedInputTokens = systemTokens + messageTokens
  const percent = Math.min(100, Math.round((estimatedInputTokens / maximumInputTokens) * 100))
  return {
    messages,
    systemPrompt,
    usage: {
      provider: options.provider,
      model: options.model,
      windowTokens,
      maximumInputTokens,
      outputReserveTokens,
      estimatedInputTokens,
      estimatedSystemTokens: systemTokens,
      estimatedMessageTokens: messageTokens,
      percent,
      status: usageStatus(percent),
      compactedMessageCount,
      truncated,
      forced: Boolean(options.forceCompact)
    }
  }
}
