import { app, safeStorage } from 'electron'
import path from 'node:path'

import {
  DEFAULT_SETTINGS,
  REASONING_EFFORTS,
  type AiProtocol,
  type AppSettings,
  type ContextScope,
  type ReasoningEffort
} from '../../src/shared/types'
import { atomicWriteJson, readJson } from './storage'

interface StoredSettings {
  settings: Omit<AppSettings, 'apiKey' | 'hasApiKey'>
  encryptedApiKey?: string
}

const CONTEXT_SCOPES = new Set<ContextScope>(['selection', 'visible', 'document', 'project', 'general'])
const AI_PROTOCOLS = new Set<AiProtocol>(['auto', 'responses', 'chat-completions'])
const SUPPORTED_REASONING_EFFORTS = new Set<ReasoningEffort>(REASONING_EFFORTS)

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname === '::1' ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  )
}

function clampedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.min(maximum, Math.max(minimum, numeric))
}

function sanitizeBaseUrl(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim() : DEFAULT_SETTINGS.baseUrl
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error('AI 服务地址不是有效 URL。')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('AI 服务地址只支持 http:// 或 https://。')
  }
  const loopback = isLoopbackHost(parsed.hostname)
  if (parsed.protocol === 'http:' && !loopback) {
    throw new Error('为避免 API Key 被明文传输，http:// 仅允许 localhost、127.0.0.0/8 或 ::1；远程服务请使用 HTTPS。')
  }
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/$/u, '')
}

function sanitizeSettings(input: Partial<AppSettings>): Omit<AppSettings, 'apiKey' | 'hasApiKey'> {
  const theme = input.theme === 'light' || input.theme === 'dark' || input.theme === 'system' ? input.theme : DEFAULT_SETTINGS.theme
  const context = CONTEXT_SCOPES.has(input.defaultContextScope as ContextScope)
    ? (input.defaultContextScope as ContextScope)
    : DEFAULT_SETTINGS.defaultContextScope
  const model = typeof input.model === 'string' && input.model.trim() ? input.model.trim().slice(0, 200) : DEFAULT_SETTINGS.model
  const apiProtocol = AI_PROTOCOLS.has(input.apiProtocol as AiProtocol)
    ? (input.apiProtocol as AiProtocol)
    : DEFAULT_SETTINGS.apiProtocol
  const reasoningEffort = SUPPORTED_REASONING_EFFORTS.has(input.reasoningEffort as ReasoningEffort)
    ? (input.reasoningEffort as ReasoningEffort)
    : DEFAULT_SETTINGS.reasoningEffort

  return {
    baseUrl: sanitizeBaseUrl(input.baseUrl),
    model,
    apiProtocol,
    reasoningEffort,
    theme,
    fontSize: clampedInteger(input.fontSize, DEFAULT_SETTINGS.fontSize, 11, 28),
    defaultProjectPath: typeof input.defaultProjectPath === 'string' ? input.defaultProjectPath.trim() : '',
    autoSave: typeof input.autoSave === 'boolean' ? input.autoSave : DEFAULT_SETTINGS.autoSave,
    autoSaveDelay: clampedInteger(input.autoSaveDelay, DEFAULT_SETTINGS.autoSaveDelay, 250, 60_000),
    defaultContextScope: context,
    allowGeneralKnowledge:
      typeof input.allowGeneralKnowledge === 'boolean' ? input.allowGeneralKnowledge : DEFAULT_SETTINGS.allowGeneralKnowledge,
    autoTitle: typeof input.autoTitle === 'boolean' ? input.autoTitle : DEFAULT_SETTINGS.autoTitle
  }
}

export class SettingsStore {
  private get filePath(): string {
    return path.join(app.getPath('userData'), 'settings.json')
  }

  private async stored(): Promise<StoredSettings> {
    const fallback: StoredSettings = { settings: sanitizeSettings(DEFAULT_SETTINGS) }
    const value = await readJson<StoredSettings>(this.filePath, fallback)
    if (!value || typeof value !== 'object' || !value.settings) return fallback
    try {
      return {
        settings: sanitizeSettings(value.settings),
        encryptedApiKey: typeof value.encryptedApiKey === 'string' ? value.encryptedApiKey : undefined
      }
    } catch {
      return fallback
    }
  }

  async get(): Promise<AppSettings> {
    const stored = await this.stored()
    return {
      ...stored.settings,
      hasApiKey: Boolean(stored.encryptedApiKey)
    }
  }

  async apiKey(): Promise<string | null> {
    const stored = await this.stored()
    if (!stored.encryptedApiKey) return null
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('当前系统的安全存储暂不可用，无法读取 API Key。')
    }
    try {
      return safeStorage.decryptString(Buffer.from(stored.encryptedApiKey, 'base64'))
    } catch {
      throw new Error('API Key 无法解密，请在设置中重新保存。')
    }
  }

  async save(input: AppSettings): Promise<AppSettings> {
    const previous = await this.stored()
    let encryptedApiKey = previous.encryptedApiKey
    if (Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
      const nextKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
      if (!nextKey) {
        if (input.hasApiKey === false) encryptedApiKey = undefined
      } else {
        if (!safeStorage.isEncryptionAvailable()) {
          throw new Error('当前系统的安全存储暂不可用，API Key 未保存。')
        }
        encryptedApiKey = safeStorage.encryptString(nextKey).toString('base64')
      }
    }

    const settings = sanitizeSettings(input)
    const value: StoredSettings = { settings, ...(encryptedApiKey ? { encryptedApiKey } : {}) }
    await atomicWriteJson(this.filePath, value)
    return { ...settings, hasApiKey: Boolean(encryptedApiKey) }
  }
}
