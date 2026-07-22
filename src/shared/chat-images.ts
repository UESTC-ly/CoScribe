import type { ChatImageAttachment } from './types'

export const CHAT_IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
] as const

export const MAX_CHAT_IMAGES_PER_MESSAGE = 4
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_CHAT_IMAGE_TOTAL_BYTES = 10 * 1024 * 1024

export function isChatImageMimeType(value: string): value is ChatImageAttachment['mimeType'] {
  return (CHAT_IMAGE_MIME_TYPES as readonly string[]).includes(value)
}

interface NormalizeChatImagesOptions {
  strict?: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function fail(strict: boolean, message: string): null {
  if (strict) throw new Error(message)
  return null
}

export function chatImageDataUrlBytes(dataUrl: string, mimeType: string): number | null {
  const prefix = `data:${mimeType};base64,`
  if (!dataUrl.startsWith(prefix)) return null
  const payload = dataUrl.slice(prefix.length)
  if (!payload || payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload)) return null
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return (payload.length / 4) * 3 - padding
}

export function normalizeChatImageAttachments(
  value: unknown,
  options: NormalizeChatImagesOptions = {}
): ChatImageAttachment[] {
  const strict = options.strict === true
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    fail(strict, '图片附件格式无效。')
    return []
  }
  if (value.length > MAX_CHAT_IMAGES_PER_MESSAGE && strict) {
    throw new Error(`每条消息最多发送 ${MAX_CHAT_IMAGES_PER_MESSAGE} 张图片。`)
  }

  const result: ChatImageAttachment[] = []
  const ids = new Set<string>()
  let totalBytes = 0
  for (const candidate of value.slice(0, MAX_CHAT_IMAGES_PER_MESSAGE)) {
    if (!isRecord(candidate)) {
      fail(strict, '图片附件格式无效。')
      continue
    }
    const id = typeof candidate.id === 'string' ? candidate.id.trim().slice(0, 500) : ''
    const name = typeof candidate.name === 'string' ? candidate.name.trim().slice(0, 255) : ''
    const mimeType = typeof candidate.mimeType === 'string' ? candidate.mimeType : ''
    const dataUrl = typeof candidate.dataUrl === 'string' ? candidate.dataUrl : ''
    if (!id || ids.has(id) || !name || !isChatImageMimeType(mimeType)) {
      fail(strict, '图片附件的名称、类型或标识无效。')
      continue
    }
    const size = chatImageDataUrlBytes(dataUrl, mimeType)
    if (size === null || size <= 0) {
      fail(strict, '图片附件不是有效的 Base64 data URL。')
      continue
    }
    if (size > MAX_CHAT_IMAGE_BYTES) {
      fail(strict, `单张图片不能超过 ${MAX_CHAT_IMAGE_BYTES / 1024 / 1024} MB。`)
      continue
    }
    if (totalBytes + size > MAX_CHAT_IMAGE_TOTAL_BYTES) {
      fail(strict, `每条消息的图片总大小不能超过 ${MAX_CHAT_IMAGE_TOTAL_BYTES / 1024 / 1024} MB。`)
      continue
    }
    ids.add(id)
    totalBytes += size
    result.push({
      id,
      name,
      mimeType,
      dataUrl,
      size
    })
  }
  return result
}
