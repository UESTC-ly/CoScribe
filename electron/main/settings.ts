import { app, safeStorage } from 'electron'
import path from 'node:path'

import {
  DEFAULT_SETTINGS,
  REASONING_EFFORTS,
  defaultEnabledModels,
  type AiProtocol,
  type AiProvider,
  type AiProviderProfile,
  type AppSettings,
  type ContextScope,
  type PluginPermission,
  type ReasoningEffort
} from '../../src/shared/types'
import { TRUSTED_PLUGIN_REGISTRY } from '../../src/plugins/registry'
import { atomicWriteJson, readJson } from './storage'

type SanitizedSettings = Omit<
  AppSettings,
  'apiKey' | 'hasApiKey' | 'anthropicApiKey' | 'hasAnthropicApiKey' | 'imageApiKey' | 'hasImageApiKey'
>

interface StoredSettings {
  version?: number
  settings: Partial<AppSettings>
  encryptedApiKeys?: Record<string, string>
  encryptedApiKey?: string
  encryptedAnthropicApiKey?: string
  encryptedImageApiKey?: string
}

interface NormalizedStoredSettings {
  settings: SanitizedSettings
  encryptedApiKeys: Record<string, string>
  encryptedImageApiKey?: string
}

const CONTEXT_SCOPES = new Set<ContextScope>(['selection', 'visible', 'document', 'project', 'general'])
const AI_PROTOCOLS = new Set<AiProtocol>(['auto', 'responses', 'chat-completions'])
const SUPPORTED_REASONING_EFFORTS = new Set<ReasoningEffort>(REASONING_EFFORTS)
const TRUSTED_PLUGIN_IDS = new Set(TRUSTED_PLUGIN_REGISTRY.map((plugin) => plugin.id))
const TRUSTED_PLUGIN_PERMISSIONS = new Map(
  TRUSTED_PLUGIN_REGISTRY.map((plugin) => [plugin.id, new Set<PluginPermission>([...plugin.permissions, ...(plugin.optionalPermissions ?? [])])])
)
export const MAX_CUSTOM_SYSTEM_PROMPT_CHARS = 20_000
export const MAX_AI_PROFILES = 20
const MAX_ENABLED_MODELS = 60

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

export function sanitizeBaseUrl(value: unknown, fallback: string, label: string): string {
  const candidate = typeof value === 'string' ? value.trim() : fallback
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new Error(`${label}不是有效 URL。`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${label}只支持 http:// 或 https://。`)
  }
  const loopback = isLoopbackHost(parsed.hostname)
  if (parsed.protocol === 'http:' && !loopback) {
    throw new Error('为避免 API Key 被明文传输，http:// 仅允许 localhost、127.0.0.0/8 或 ::1；远程服务请使用 HTTPS。')
  }
  parsed.hash = ''
  parsed.search = ''
  return parsed.toString().replace(/\/$/u, '')
}

function profileDefaults(provider: AiProvider): AiProviderProfile {
  const fallback = DEFAULT_SETTINGS.aiProfiles.find((profile) => profile.provider === provider)
  if (!fallback) throw new Error(`缺少 ${provider} 默认配置。`)
  return { ...fallback }
}

function legacyProfiles(input: Partial<AppSettings>): AiProviderProfile[] {
  const openai = profileDefaults('openai')
  const anthropic = profileDefaults('anthropic')
  const openaiBaseUrl = typeof input.baseUrl === 'string' ? input.baseUrl : openai.baseUrl
  const openaiModel = typeof input.model === 'string' ? input.model : openai.model
  const anthropicBaseUrl = typeof input.anthropicBaseUrl === 'string' ? input.anthropicBaseUrl : anthropic.baseUrl
  const anthropicModel = typeof input.anthropicModel === 'string' ? input.anthropicModel : anthropic.model
  return [
    {
      ...openai,
      baseUrl: openaiBaseUrl,
      model: openaiModel,
      enabledModels: defaultEnabledModels('openai', openaiBaseUrl, openaiModel),
      apiProtocol: AI_PROTOCOLS.has(input.apiProtocol as AiProtocol) ? input.apiProtocol as AiProtocol : openai.apiProtocol,
      hasApiKey: Boolean(input.hasApiKey)
    },
    {
      ...anthropic,
      baseUrl: anthropicBaseUrl,
      model: anthropicModel,
      enabledModels: defaultEnabledModels('anthropic', anthropicBaseUrl, anthropicModel),
      hasApiKey: Boolean(input.hasAnthropicApiKey)
    }
  ]
}

function profileId(value: unknown, provider: AiProvider, index: number): string {
  const candidate = typeof value === 'string' ? value.trim().slice(0, 80) : ''
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(candidate) ? candidate : `${provider}-${index + 1}`
}

// The quick switcher only shows this list, so it must be well-formed: deduped,
// length-capped, and always containing the active model. When absent (legacy
// data), fall back to the provider defaults so first-party profiles keep their
// preset menu and third-party ones stay scoped to their own model.
function sanitizeEnabledModels(
  raw: unknown,
  provider: AiProvider,
  baseUrl: string,
  model: string
): string[] {
  if (!Array.isArray(raw)) return defaultEnabledModels(provider, baseUrl, model)
  const models: string[] = []
  const seen = new Set<string>()
  for (const entry of [model, ...raw]) {
    if (typeof entry !== 'string') continue
    const trimmed = entry.trim().slice(0, 200)
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    models.push(trimmed)
    if (models.length >= MAX_ENABLED_MODELS) break
  }
  return models.length ? models : defaultEnabledModels(provider, baseUrl, model)
}

function sanitizeProfiles(input: Partial<AppSettings>): AiProviderProfile[] {
  const hasProfileCollection = Array.isArray(input.aiProfiles) && input.aiProfiles.length > 0
  const candidates = hasProfileCollection
    ? input.aiProfiles ?? []
    : legacyProfiles(input)
  const profiles: AiProviderProfile[] = []
  const ids = new Set<string>()

  for (const [index, raw] of candidates.slice(0, MAX_AI_PROFILES).entries()) {
    if (!raw || typeof raw !== 'object') continue
    const provider: AiProvider = raw.provider === 'anthropic' ? 'anthropic' : 'openai'
    const fallback = profileDefaults(provider)
    const id = profileId(raw.id, provider, index)
    if (ids.has(id)) continue
    ids.add(id)
    const useLegacyOpenAi = !hasProfileCollection && id === 'openai-default'
    const useLegacyAnthropic = !hasProfileCollection && id === 'anthropic-default'
    const baseUrl = useLegacyOpenAi && typeof input.baseUrl === 'string'
      ? input.baseUrl
      : useLegacyAnthropic && typeof input.anthropicBaseUrl === 'string'
        ? input.anthropicBaseUrl
        : raw.baseUrl
    const model = useLegacyOpenAi && typeof input.model === 'string'
      ? input.model
      : useLegacyAnthropic && typeof input.anthropicModel === 'string'
        ? input.anthropicModel
        : raw.model
    const protocol = useLegacyOpenAi && AI_PROTOCOLS.has(input.apiProtocol as AiProtocol)
      ? input.apiProtocol
      : raw.apiProtocol
    const name = typeof raw.name === 'string' && raw.name.trim()
      ? raw.name.trim().slice(0, 60)
      : fallback.name
    const cleanBaseUrl = sanitizeBaseUrl(baseUrl, fallback.baseUrl, `${name} 服务地址`)
    const requestedModel = typeof model === 'string' ? model.trim().slice(0, 200) : ''
    const cleanModel = requestedModel || (
      defaultEnabledModels(provider, cleanBaseUrl, '').length ? fallback.model : ''
    )
    profiles.push({
      id,
      name,
      provider,
      baseUrl: cleanBaseUrl,
      model: cleanModel,
      enabledModels: sanitizeEnabledModels(raw.enabledModels, provider, cleanBaseUrl, cleanModel),
      apiProtocol: AI_PROTOCOLS.has(protocol as AiProtocol) ? protocol as AiProtocol : fallback.apiProtocol,
      hasApiKey: Boolean(raw.hasApiKey)
    })
  }

  return profiles.length ? profiles : legacyProfiles(input)
}

export function sanitizeSettings(input: Partial<AppSettings>): SanitizedSettings {
  const theme = input.theme === 'light' || input.theme === 'dark' || input.theme === 'system' ? input.theme : DEFAULT_SETTINGS.theme
  const context = CONTEXT_SCOPES.has(input.defaultContextScope as ContextScope)
    ? (input.defaultContextScope as ContextScope)
    : DEFAULT_SETTINGS.defaultContextScope
  const profiles = sanitizeProfiles(input)
  const requestedProvider: AiProvider = input.aiProvider === 'anthropic' ? 'anthropic' : 'openai'
  const requestedProfile = profiles.find((profile) => profile.id === input.activeAiProfileId)
  const activeProfile = requestedProfile?.provider === requestedProvider
    ? requestedProfile
    : profiles.find((profile) => profile.provider === requestedProvider) ?? requestedProfile ?? profiles[0]
  const openAiProfile = activeProfile.provider === 'openai'
    ? activeProfile
    : profiles.find((profile) => profile.provider === 'openai') ?? profileDefaults('openai')
  const anthropicProfile = activeProfile.provider === 'anthropic'
    ? activeProfile
    : profiles.find((profile) => profile.provider === 'anthropic') ?? profileDefaults('anthropic')
  const reasoningEffortCandidate = SUPPORTED_REASONING_EFFORTS.has(input.reasoningEffort as ReasoningEffort)
    ? (input.reasoningEffort as ReasoningEffort)
    : DEFAULT_SETTINGS.reasoningEffort
  const reasoningEffort = activeProfile.provider === 'anthropic' && reasoningEffortCandidate === 'ultra'
    ? 'max'
    : reasoningEffortCandidate
  const customSystemPrompt = typeof input.customSystemPrompt === 'string'
    ? input.customSystemPrompt.trim().slice(0, MAX_CUSTOM_SYSTEM_PROMPT_CHARS)
    : DEFAULT_SETTINGS.customSystemPrompt
  const enabledPlugins = Array.isArray(input.enabledPlugins)
    ? [...new Set(input.enabledPlugins.filter((id): id is string => typeof id === 'string' && TRUSTED_PLUGIN_IDS.has(id)))]
    : [...DEFAULT_SETTINGS.enabledPlugins]
  const rawGrants = input.pluginGrants && typeof input.pluginGrants === 'object' && !Array.isArray(input.pluginGrants)
    ? input.pluginGrants
    : DEFAULT_SETTINGS.pluginGrants
  const pluginGrants = Object.fromEntries(
    Object.entries(rawGrants).flatMap(([pluginId, permissions]) => {
      const allowed = TRUSTED_PLUGIN_PERMISSIONS.get(pluginId)
      if (!allowed || !Array.isArray(permissions)) return []
      const grants = [...new Set(permissions.filter(
        (permission): permission is PluginPermission => typeof permission === 'string' && allowed.has(permission as PluginPermission)
      ))]
      return [[pluginId, grants]]
    })
  )

  return {
    aiProvider: activeProfile.provider,
    activeAiProfileId: activeProfile.id,
    aiProfiles: profiles,
    baseUrl: openAiProfile.baseUrl,
    model: openAiProfile.model,
    apiProtocol: openAiProfile.apiProtocol,
    reasoningEffort,
    anthropicBaseUrl: anthropicProfile.baseUrl,
    anthropicModel: anthropicProfile.model,
    imageBaseUrl: sanitizeBaseUrl(input.imageBaseUrl, DEFAULT_SETTINGS.imageBaseUrl, '图片生成服务地址'),
    theme,
    fontSize: clampedInteger(input.fontSize, DEFAULT_SETTINGS.fontSize, 11, 28),
    defaultProjectPath: typeof input.defaultProjectPath === 'string' ? input.defaultProjectPath.trim() : '',
    autoSave: typeof input.autoSave === 'boolean' ? input.autoSave : DEFAULT_SETTINGS.autoSave,
    autoSaveDelay: clampedInteger(input.autoSaveDelay, DEFAULT_SETTINGS.autoSaveDelay, 250, 60_000),
    defaultContextScope: context,
    allowGeneralKnowledge:
      typeof input.allowGeneralKnowledge === 'boolean' ? input.allowGeneralKnowledge : DEFAULT_SETTINGS.allowGeneralKnowledge,
    autoTitle: typeof input.autoTitle === 'boolean' ? input.autoTitle : DEFAULT_SETTINGS.autoTitle,
    customSystemPrompt,
    projectMemoryEnabled:
      typeof input.projectMemoryEnabled === 'boolean' ? input.projectMemoryEnabled : DEFAULT_SETTINGS.projectMemoryEnabled,
    enabledPlugins,
    pluginGrants,
    contextWindowTokens: input.contextWindowTokens === 0
      ? 0
      : clampedInteger(input.contextWindowTokens, DEFAULT_SETTINGS.contextWindowTokens, 8_192, 2_000_000),
    contextOutputReserveTokens: clampedInteger(
      input.contextOutputReserveTokens,
      DEFAULT_SETTINGS.contextOutputReserveTokens,
      1_024,
      128_000
    ),
    contextAutoCompact:
      typeof input.contextAutoCompact === 'boolean' ? input.contextAutoCompact : DEFAULT_SETTINGS.contextAutoCompact
  }
}

function decryptSecret(encrypted: string | undefined, label: string): string | null {
  if (!encrypted) return null
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`当前系统的安全存储暂不可用，无法读取${label}。`)
  }
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    throw new Error(`${label}无法解密，请在设置中重新保存。`)
  }
}

function encryptSecret(value: string, label: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(`当前系统的安全存储暂不可用，${label}未保存。`)
  }
  return safeStorage.encryptString(value).toString('base64')
}

export class SettingsStore {
  private get filePath(): string {
    return path.join(app.getPath('userData'), 'settings.json')
  }

  private async stored(): Promise<NormalizedStoredSettings> {
    const fallback: StoredSettings = { version: 2, settings: sanitizeSettings(DEFAULT_SETTINGS) }
    const value = await readJson<StoredSettings>(this.filePath, fallback)
    if (!value || typeof value !== 'object' || !value.settings) {
      return { settings: sanitizeSettings(DEFAULT_SETTINGS), encryptedApiKeys: {} }
    }
    try {
      const settings = sanitizeSettings(value.settings)
      const encryptedApiKeys = value.encryptedApiKeys && typeof value.encryptedApiKeys === 'object'
        ? Object.fromEntries(Object.entries(value.encryptedApiKeys).filter(
            ([id, encrypted]) => settings.aiProfiles.some((profile) => profile.id === id) && typeof encrypted === 'string'
          ))
        : {}
      const openAiProfile = settings.aiProfiles.find((profile) => profile.provider === 'openai')
      const anthropicProfile = settings.aiProfiles.find((profile) => profile.provider === 'anthropic')
      if (value.encryptedApiKey && openAiProfile && !encryptedApiKeys[openAiProfile.id]) {
        encryptedApiKeys[openAiProfile.id] = value.encryptedApiKey
      }
      if (value.encryptedAnthropicApiKey && anthropicProfile && !encryptedApiKeys[anthropicProfile.id]) {
        encryptedApiKeys[anthropicProfile.id] = value.encryptedAnthropicApiKey
      }
      return {
        settings,
        encryptedApiKeys,
        encryptedImageApiKey: typeof value.encryptedImageApiKey === 'string' ? value.encryptedImageApiKey : undefined
      }
    } catch {
      return { settings: sanitizeSettings(DEFAULT_SETTINGS), encryptedApiKeys: {} }
    }
  }

  private publicSettings(stored: NormalizedStoredSettings): AppSettings {
    const aiProfiles = stored.settings.aiProfiles.map((profile) => ({
      ...profile,
      hasApiKey: Boolean(stored.encryptedApiKeys[profile.id])
    }))
    const active = aiProfiles.find((profile) => profile.id === stored.settings.activeAiProfileId) ?? aiProfiles[0]
    const openAi = active.provider === 'openai'
      ? active
      : aiProfiles.find((profile) => profile.provider === 'openai')
    const anthropic = active.provider === 'anthropic'
      ? active
      : aiProfiles.find((profile) => profile.provider === 'anthropic')
    return {
      ...stored.settings,
      aiProfiles,
      hasApiKey: Boolean(openAi?.hasApiKey),
      hasAnthropicApiKey: Boolean(anthropic?.hasApiKey),
      hasImageApiKey: Boolean(stored.encryptedImageApiKey)
    }
  }

  async get(): Promise<AppSettings> {
    return this.publicSettings(await this.stored())
  }

  async apiKeyForProfile(profileId: string): Promise<string | null> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(profileId)) return null
    const stored = await this.stored()
    const profile = stored.settings.aiProfiles.find((candidate) => candidate.id === profileId)
    return decryptSecret(profile ? stored.encryptedApiKeys[profile.id] : undefined, `${profile?.name ?? 'AI'} API Key`)
  }

  private async activeApiKey(provider: AiProvider): Promise<string | null> {
    const stored = await this.stored()
    const active = stored.settings.aiProfiles.find((profile) => profile.id === stored.settings.activeAiProfileId)
    const profile = active?.provider === provider
      ? active
      : stored.settings.aiProfiles.find((candidate) => candidate.provider === provider)
    return decryptSecret(profile ? stored.encryptedApiKeys[profile.id] : undefined, `${profile?.name ?? 'AI'} API Key`)
  }

  async apiKey(): Promise<string | null> {
    return this.activeApiKey('openai')
  }

  async imageApiKey(): Promise<string | null> {
    const stored = await this.stored()
    return decryptSecret(stored.encryptedImageApiKey, '图片生成 API Key')
  }

  async anthropicApiKey(): Promise<string | null> {
    return this.activeApiKey('anthropic')
  }

  async save(input: AppSettings): Promise<AppSettings> {
    const previous = await this.stored()
    const settings = sanitizeSettings(input)
    const profileIds = new Set(settings.aiProfiles.map((profile) => profile.id))
    const encryptedApiKeys = Object.fromEntries(
      Object.entries(previous.encryptedApiKeys).filter(([id]) => profileIds.has(id))
    )

    for (const profile of settings.aiProfiles) {
      const raw = input.aiProfiles?.find((candidate) => candidate.id === profile.id)
      if (!raw || !Object.prototype.hasOwnProperty.call(raw, 'apiKey')) continue
      const nextKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : ''
      if (nextKey) encryptedApiKeys[profile.id] = encryptSecret(nextKey, `${profile.name} API Key`)
      else if (raw.hasApiKey === false) delete encryptedApiKeys[profile.id]
    }

    const legacyOpenAi = settings.aiProfiles.find((profile) => profile.provider === 'openai')
    if (legacyOpenAi && Object.prototype.hasOwnProperty.call(input, 'apiKey')) {
      const nextKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
      if (nextKey) encryptedApiKeys[legacyOpenAi.id] = encryptSecret(nextKey, 'API Key')
      else if (input.hasApiKey === false) delete encryptedApiKeys[legacyOpenAi.id]
    }
    const legacyAnthropic = settings.aiProfiles.find((profile) => profile.provider === 'anthropic')
    if (legacyAnthropic && Object.prototype.hasOwnProperty.call(input, 'anthropicApiKey')) {
      const nextKey = typeof input.anthropicApiKey === 'string' ? input.anthropicApiKey.trim() : ''
      if (nextKey) encryptedApiKeys[legacyAnthropic.id] = encryptSecret(nextKey, 'Anthropic API Key')
      else if (input.hasAnthropicApiKey === false) delete encryptedApiKeys[legacyAnthropic.id]
    }

    let encryptedImageApiKey = previous.encryptedImageApiKey
    if (Object.prototype.hasOwnProperty.call(input, 'imageApiKey')) {
      const nextKey = typeof input.imageApiKey === 'string' ? input.imageApiKey.trim() : ''
      if (nextKey) encryptedImageApiKey = encryptSecret(nextKey, '图片生成 API Key')
      else if (input.hasImageApiKey === false) encryptedImageApiKey = undefined
    }

    const persistedSettings: SanitizedSettings = {
      ...settings,
      aiProfiles: settings.aiProfiles.map((profile) => ({ ...profile, hasApiKey: false }))
    }
    const value: StoredSettings = {
      version: 2,
      settings: persistedSettings,
      ...(Object.keys(encryptedApiKeys).length ? { encryptedApiKeys } : {}),
      ...(encryptedImageApiKey ? { encryptedImageApiKey } : {})
    }
    await atomicWriteJson(this.filePath, value)
    return this.publicSettings({ settings, encryptedApiKeys, encryptedImageApiKey })
  }
}
