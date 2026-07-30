import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Bot,
  BrainCircuit,
  Eye,
  EyeOff,
  Image as ImageIcon,
  KeyRound,
  MonitorCog,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Trash2
} from 'lucide-react'
import {
  ALL_PRESET_MODELS,
  REASONING_EFFORTS,
  defaultEnabledModels,
  type AiProvider,
  type AiProviderProfile,
  type AppSettings
} from '../../shared/types'
import { Dialog } from './Dialog'

const MAX_AI_PROFILES = 20
const REASONING_LABELS: Record<AppSettings['reasoningEffort'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  ultra: 'Ultra',
  max: 'More reasoning...'
}

export type SettingsPanel = 'general' | 'providers' | 'ai-behavior' | 'image'

interface SettingsDialogProps {
  open: boolean
  initialPanel?: SettingsPanel
  settings: AppSettings
  onSave: (settings: AppSettings) => Promise<void> | void
  onClose: () => void
}

interface ModelDiscoveryState {
  status: 'loading' | 'success' | 'error'
  models: string[]
  message: string
}

function providerDefaults(provider: AiProvider): Pick<AiProviderProfile, 'name' | 'baseUrl' | 'model' | 'apiProtocol'> {
  return provider === 'anthropic'
    ? {
        name: 'Anthropic',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-sonnet-4-6',
        apiProtocol: 'auto'
      }
    : {
        name: 'OpenAI-compatible',
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5.6-terra',
        apiProtocol: 'auto'
      }
}

function newProfile(index: number): AiProviderProfile {
  const defaults = providerDefaults('openai')
  return {
    id: `profile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: `新服务商 ${index}`,
    provider: 'openai',
    baseUrl: defaults.baseUrl,
    model: defaults.model,
    enabledModels: defaultEnabledModels('openai', defaults.baseUrl, defaults.model),
    apiProtocol: defaults.apiProtocol,
    hasApiKey: false
  }
}

function endpointIdentity(value: string): string | null {
  try {
    const parsed = new URL(value.trim())
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
    parsed.hash = ''
    parsed.search = ''
    return parsed.toString().replace(/\/$/u, '')
  } catch {
    return null
  }
}

export function SettingsDialog({ open, initialPanel = 'general', settings, onSave, onClose }: SettingsDialogProps): React.JSX.Element | null {
  const [draft, setDraft] = useState(settings)
  const [panel, setPanel] = useState<SettingsPanel>('general')
  const [showProfileKey, setShowProfileKey] = useState(false)
  const [showImageKey, setShowImageKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [modelDiscovery, setModelDiscovery] = useState<Record<string, ModelDiscoveryState>>({})
  const [modelFilter, setModelFilter] = useState('')
  const modelDiscoveryRequests = useRef<Record<string, number>>({})

  useEffect(() => {
    setDraft(settings)
    setPanel(initialPanel)
    setShowProfileKey(false)
    setShowImageKey(false)
    setModelDiscovery({})
    setModelFilter('')
    modelDiscoveryRequests.current = {}
  }, [initialPanel, settings, open])

  const activeProfile = useMemo(
    () => draft.aiProfiles.find((profile) => profile.id === draft.activeAiProfileId) ?? draft.aiProfiles[0],
    [draft.activeAiProfileId, draft.aiProfiles]
  )
  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }))
  }
  const activateProfile = (id: string): void => {
    setShowProfileKey(false)
    setDraft((current) => {
      const profile = current.aiProfiles.find((candidate) => candidate.id === id)
      if (!profile) return current
      return {
        ...current,
        activeAiProfileId: profile.id,
        aiProvider: profile.provider,
        ...(profile.provider === 'anthropic' && current.reasoningEffort === 'ultra'
          ? { reasoningEffort: 'max' as const }
          : {})
      }
    })
  }
  const updateProfile = (patch: Partial<AiProviderProfile>): void => {
    if (!activeProfile) return
    if ('provider' in patch || 'baseUrl' in patch || 'apiKey' in patch || patch.hasApiKey === false) {
      modelDiscoveryRequests.current[activeProfile.id] = (modelDiscoveryRequests.current[activeProfile.id] ?? 0) + 1
      setModelDiscovery((current) => {
        const next = { ...current }
        delete next[activeProfile.id]
        return next
      })
    }
    setDraft((current) => ({
      ...current,
      aiProvider: patch.provider ?? activeProfile.provider,
      ...(patch.provider === 'anthropic' && current.reasoningEffort === 'ultra'
        ? { reasoningEffort: 'max' as const }
        : {}),
      aiProfiles: current.aiProfiles.map((profile) => {
        if (profile.id !== activeProfile.id) return profile
        const merged = { ...profile, ...patch }
        let model = merged.model.trim()
        let enabledModels = merged.enabledModels
        // A completed endpoint change invalidates the old endpoint's catalogue.
        // Do not clear while the user is midway through typing an invalid URL.
        if (('baseUrl' in patch || 'provider' in patch) && !('enabledModels' in patch)) {
          const previousEndpoint = endpointIdentity(profile.baseUrl)
          const nextEndpoint = endpointIdentity(merged.baseUrl)
          if (nextEndpoint && (merged.provider !== profile.provider || nextEndpoint !== previousEndpoint)) {
            const nativePresets = defaultEnabledModels(merged.provider, merged.baseUrl, '')
            if (nativePresets.length) {
              const applicable = new Set(nativePresets)
              enabledModels = enabledModels.filter((entry) =>
                applicable.has(entry) || !ALL_PRESET_MODELS.includes(entry)
              )
              enabledModels = [...new Set([...nativePresets, ...enabledModels])]
            } else {
              enabledModels = []
              model = ''
            }
          }
        }
        // The default model must always remain part of the enabled set so the
        // quick switcher can show the current selection.
        if (model && !enabledModels.includes(model)) enabledModels = [...enabledModels, model]
        return { ...merged, model, enabledModels }
      })
    }))
  }
  const changeProfileProvider = (provider: AiProvider): void => {
    const defaults = providerDefaults(provider)
    // Switching provider replaces the endpoint entirely, so reseed the enabled
    // set from the new provider's defaults — never carry the old provider's
    // models into the new one's quick switcher.
    updateProfile({
      provider,
      baseUrl: defaults.baseUrl,
      model: defaults.model,
      enabledModels: defaultEnabledModels(provider, defaults.baseUrl, defaults.model),
      apiProtocol: defaults.apiProtocol,
      apiKey: '',
      hasApiKey: false
    })
    setShowProfileKey(false)
  }
  const toggleEnabledModel = (model: string): void => {
    if (!activeProfile) return
    const trimmed = model.trim()
    if (!trimmed) return
    const isDefault = trimmed === activeProfile.model.trim()
    if (isDefault) return
    const enabledModels = activeProfile.enabledModels.includes(trimmed)
      ? activeProfile.enabledModels.filter((entry) => entry !== trimmed)
      : [...activeProfile.enabledModels, trimmed]
    updateProfile({ enabledModels })
  }
  const addProfile = (): void => {
    setDraft((current) => {
      if (current.aiProfiles.length >= MAX_AI_PROFILES) return current
      const profile = newProfile(current.aiProfiles.length + 1)
      return {
        ...current,
        aiProvider: profile.provider,
        activeAiProfileId: profile.id,
        aiProfiles: [...current.aiProfiles, profile]
      }
    })
    setShowProfileKey(false)
  }
  const removeProfile = (id: string): void => {
    modelDiscoveryRequests.current[id] = (modelDiscoveryRequests.current[id] ?? 0) + 1
    setModelDiscovery((current) => {
      const next = { ...current }
      delete next[id]
      return next
    })
    setDraft((current) => {
      if (current.aiProfiles.length <= 1) return current
      const index = current.aiProfiles.findIndex((profile) => profile.id === id)
      const aiProfiles = current.aiProfiles.filter((profile) => profile.id !== id)
      if (id !== current.activeAiProfileId) return { ...current, aiProfiles }
      const next = aiProfiles[Math.min(Math.max(index, 0), aiProfiles.length - 1)]
      return {
        ...current,
        aiProvider: next.provider,
        activeAiProfileId: next.id,
        aiProfiles,
        ...(next.provider === 'anthropic' && current.reasoningEffort === 'ultra'
          ? { reasoningEffort: 'max' as const }
          : {})
      }
    })
    setShowProfileKey(false)
  }
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await onSave(draft)
      onClose()
    } finally {
      setSaving(false)
    }
  }
  const discoverModels = async (): Promise<void> => {
    if (!activeProfile) return
    const profile = activeProfile
    const requestVersion = (modelDiscoveryRequests.current[profile.id] ?? 0) + 1
    modelDiscoveryRequests.current[profile.id] = requestVersion
    setModelDiscovery((current) => ({
      ...current,
      [profile.id]: { status: 'loading', models: [], message: '正在获取可用模型…' }
    }))
    try {
      const result = await window.coscribe.ai.listModels({
        profileId: profile.id,
        provider: profile.provider,
        baseUrl: profile.baseUrl,
        ...(profile.apiKey?.trim() ? { apiKey: profile.apiKey.trim() } : {}),
        useStoredApiKey: profile.hasApiKey && !profile.apiKey?.trim()
      })
      if (modelDiscoveryRequests.current[profile.id] !== requestVersion) return
      const models = [...new Set(result.models.map((model) => model.trim()).filter(Boolean))]
      setDraft((current) => ({
        ...current,
        aiProfiles: current.aiProfiles.map((candidate) => {
          if (candidate.id !== profile.id) return candidate
          const nativePresets = defaultEnabledModels(candidate.provider, candidate.baseUrl, '')
          if (!models.length) {
            return nativePresets.length
              ? candidate
              : { ...candidate, model: '', enabledModels: [] }
          }
          const model = models.includes(candidate.model.trim())
            ? candidate.model.trim()
            : nativePresets.includes(candidate.model.trim())
              ? candidate.model.trim()
              : models[0]
          const available = new Set([...models, ...nativePresets])
          const enabledModels = [...new Set([
            model,
            ...nativePresets,
            ...candidate.enabledModels.filter((entry) => available.has(entry))
          ].filter(Boolean))]
          return { ...candidate, model, enabledModels }
        })
      }))
      setModelFilter('')
      setModelDiscovery((current) => ({
        ...current,
        [profile.id]: {
          status: 'success',
          models,
          message: models.length
            ? `已获取 ${models.length} 个可用模型；勾选需要在模型菜单中显示的模型。`
            : '服务没有返回可用模型。'
        }
      }))
    } catch (error) {
      if (modelDiscoveryRequests.current[profile.id] !== requestVersion) return
      setModelDiscovery((current) => ({
        ...current,
        [profile.id]: {
          status: 'error',
          models: [],
          message: error instanceof Error ? error.message : '获取模型列表失败。'
        }
      }))
    }
  }
  const reasoningEfforts = activeProfile?.provider === 'anthropic'
    ? REASONING_EFFORTS.filter((effort) => effort !== 'ultra')
    : REASONING_EFFORTS
  const activeModelDiscovery = activeProfile ? modelDiscovery[activeProfile.id] : undefined
  // The default-model datalist offers the profile's own enabled models plus any
  // freshly fetched catalogue — never hardcoded presets from other providers.
  const modelOptions = activeProfile
    ? [...new Set([activeProfile.model, ...activeProfile.enabledModels, ...(activeModelDiscovery?.models ?? [])].filter(Boolean))]
    : []
  // The full catalogue (enabled ∪ fetched) is only browsable here via search, so
  // hundreds-of-model providers stay manageable while the switcher stays minimal.
  const modelCatalog = activeProfile
    ? [...new Set([...activeProfile.enabledModels, ...(activeModelDiscovery?.models ?? [])].filter(Boolean))]
    : []
  const normalizedFilter = modelFilter.trim().toLowerCase()
  const filteredCatalog = normalizedFilter
    ? modelCatalog.filter((model) => model.toLowerCase().includes(normalizedFilter))
    : modelCatalog

  return (
    <Dialog
      open={open}
      title="设置"
      description="系统偏好与 AI 服务独立管理；密钥只保存在本机安全存储中。"
      onClose={onClose}
      width={900}
      footer={(
        <>
          <button className="secondary-button" onClick={onClose}>取消</button>
          <button className="primary-button" disabled={saving} onClick={() => void save()}>
            {saving ? '正在保存…' : '保存设置'}
          </button>
        </>
      )}
    >
      <div className="settings-workbench">
        <nav className="settings-navigation" aria-label="设置分类">
          <button type="button" aria-current={panel === 'general' ? 'page' : undefined} onClick={() => setPanel('general')}>
            <MonitorCog size={16} /><span><strong>通用设置</strong><small>外观、项目与保存</small></span>
          </button>
          <button type="button" aria-current={panel === 'providers' ? 'page' : undefined} onClick={() => setPanel('providers')}>
            <KeyRound size={16} /><span><strong>AI 服务商</strong><small>{draft.aiProfiles.length} 个配置</small></span>
          </button>
          <button type="button" aria-current={panel === 'ai-behavior' ? 'page' : undefined} onClick={() => setPanel('ai-behavior')}>
            <BrainCircuit size={16} /><span><strong>AI 行为</strong><small>提示词、上下文与记忆</small></span>
          </button>
          <button type="button" aria-current={panel === 'image' ? 'page' : undefined} onClick={() => setPanel('image')}>
            <ImageIcon size={16} /><span><strong>图片生成</strong><small>GPT-Image 2</small></span>
          </button>
        </nav>

        <div className="settings-panel">
          {panel === 'general' && (
            <section className="settings-section">
              <header><div><h3>通用设置</h3><p>只影响本地工作台，不会修改项目内容。</p></div></header>
              <div className="settings-grid">
                <label className="field-label">
                  主题
                  <select className="field" value={draft.theme} onChange={(event) => patch('theme', event.target.value as AppSettings['theme'])}>
                    <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
                  </select>
                </label>
                <label className="field-label">
                  字体大小
                  <div className="range-field">
                    <input type="range" min="12" max="20" value={draft.fontSize} onChange={(event) => patch('fontSize', Number(event.target.value))} />
                    <output>{draft.fontSize}px</output>
                  </div>
                </label>
                <label className="field-label span-2">
                  默认项目路径
                  <input className="field" value={draft.defaultProjectPath} onChange={(event) => patch('defaultProjectPath', event.target.value)} placeholder="可选" />
                </label>
                <label className="check-row">
                  <input type="checkbox" checked={draft.autoSave} onChange={(event) => patch('autoSave', event.target.checked)} />
                  <span><strong>自动保存 Markdown 文档</strong><small>停止输入后约 {draft.autoSaveDelay} ms 保存</small></span>
                </label>
                <label className="field-label">
                  Markdown 保存间隔
                  <input className="field" type="number" min="300" max="10000" step="100" value={draft.autoSaveDelay} disabled={!draft.autoSave} onChange={(event) => patch('autoSaveDelay', Number(event.target.value))} />
                </label>
                <label className="check-row">
                  <input type="checkbox" aria-label="自动保存代码文件" checked={draft.codeAutoSave} onChange={(event) => patch('codeAutoSave', event.target.checked)} />
                  <span><strong>自动保存代码文件</strong><small>停止输入后约 {draft.codeAutoSaveDelay} ms 保存</small></span>
                </label>
                <label className="field-label">
                  代码保存间隔
                  <input className="field" type="number" min="300" max="10000" step="100" value={draft.codeAutoSaveDelay} disabled={!draft.codeAutoSave} onChange={(event) => patch('codeAutoSaveDelay', Number(event.target.value))} />
                </label>
              </div>
            </section>
          )}

          {panel === 'providers' && activeProfile && (
            <section className="settings-section settings-provider-section">
              <header>
                <div><h3>AI 服务商</h3><p>保存多组地址、模型和密钥；选中的配置用于新请求。</p></div>
                <button className="secondary-button settings-add-provider" type="button" disabled={draft.aiProfiles.length >= MAX_AI_PROFILES} onClick={addProfile}>
                  <Plus size={14} />添加
                </button>
              </header>
              <div className="settings-provider-workspace">
                <div className="settings-provider-list" role="tablist" aria-label="AI 服务商列表">
                  {draft.aiProfiles.map((profile) => (
                    <div key={profile.id} className={profile.id === activeProfile.id ? 'is-active' : ''}>
                      <button type="button" role="tab" aria-selected={profile.id === activeProfile.id} onClick={() => activateProfile(profile.id)}>
                        <Bot size={15} />
                        <span><strong>{profile.name}</strong><small>{profile.provider === 'anthropic' ? 'Anthropic Messages' : 'OpenAI-compatible'}</small></span>
                        <i className={profile.hasApiKey || profile.apiKey?.trim() ? 'is-ready' : ''} title={profile.hasApiKey || profile.apiKey?.trim() ? '密钥已配置' : '未配置密钥'} />
                      </button>
                      <button className="icon-button" type="button" disabled={draft.aiProfiles.length <= 1} onClick={() => removeProfile(profile.id)} aria-label={`删除服务商：${profile.name}`} title="删除服务商">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>

                <div className="settings-provider-editor">
                  <div className="settings-grid">
                    <label className="field-label">
                      服务商名称
                      <input className="field" value={activeProfile.name} maxLength={60} onChange={(event) => updateProfile({ name: event.target.value })} />
                    </label>
                    <label className="field-label">
                      接口格式
                      <select className="field" value={activeProfile.provider} onChange={(event) => changeProfileProvider(event.target.value as AiProvider)}>
                        <option value="openai">OpenAI-compatible</option>
                        <option value="anthropic">Anthropic Messages</option>
                      </select>
                    </label>
                    <label className="field-label span-2">
                      {activeProfile.provider === 'anthropic' ? 'Anthropic 服务地址' : 'OpenAI-compatible 服务地址'}
                      <input
                        className="field"
                        aria-label={activeProfile.provider === 'anthropic' ? 'Anthropic 服务地址' : '服务地址'}
                        value={activeProfile.baseUrl}
                        onChange={(event) => updateProfile({ baseUrl: event.target.value })}
                        placeholder={providerDefaults(activeProfile.provider).baseUrl}
                      />
                      <small className="field-caption">远程地址必须使用 HTTPS；本机回环服务可使用 HTTP。</small>
                    </label>
                    {activeProfile.provider === 'openai' && (
                      <label className="field-label">
                        接口协议
                        <select className="field" value={activeProfile.apiProtocol} onChange={(event) => updateProfile({ apiProtocol: event.target.value as AppSettings['apiProtocol'] })}>
                          <option value="auto">自动识别</option>
                          <option value="responses">Responses API</option>
                          <option value="chat-completions">Chat Completions</option>
                        </select>
                      </label>
                    )}
                    <label className={`field-label ${activeProfile.provider === 'anthropic' ? 'span-2' : ''}`}>
                      {activeProfile.provider === 'anthropic' ? 'Anthropic 模型' : '模型'}
                      <div className="settings-model-field">
                        <input
                          className="field"
                          aria-label={activeProfile.provider === 'anthropic' ? 'Anthropic 模型' : '模型'}
                          list="active-model-options"
                          value={activeProfile.model}
                          onChange={(event) => updateProfile({ model: event.target.value })}
                        />
                        <button
                          className="secondary-button settings-model-fetch"
                          type="button"
                          disabled={!activeProfile.baseUrl.trim() || activeModelDiscovery?.status === 'loading'}
                          onClick={() => void discoverModels()}
                          aria-label="获取可用模型"
                        >
                          <RefreshCw size={13} className={activeModelDiscovery?.status === 'loading' ? 'is-spinning' : ''} />
                          {activeModelDiscovery?.status === 'loading' ? '获取中' : '获取模型'}
                        </button>
                      </div>
                      <datalist id="active-model-options">{modelOptions.map((model) => <option key={model} value={model} />)}</datalist>
                      {activeModelDiscovery && (
                        <small className={`field-caption model-discovery-${activeModelDiscovery.status}`} role={activeModelDiscovery.status === 'error' ? 'alert' : 'status'}>
                          {activeModelDiscovery.message}
                        </small>
                      )}
                      {!activeModelDiscovery && (
                        <small className="field-caption">默认模型即发送对话时使用的模型；勾选下方模型可加入右下角快捷菜单。可手动输入模型 ID，或填写服务地址和 API Key 后获取列表。</small>
                      )}
                      <div className="settings-model-catalog" role="group" aria-label="启用的模型">
                        {modelCatalog.length > 8 && (
                          <input
                            className="field settings-model-search"
                            type="search"
                            aria-label="搜索模型"
                            placeholder="搜索模型…"
                            value={modelFilter}
                            onChange={(event) => setModelFilter(event.target.value)}
                          />
                        )}
                        {filteredCatalog.length ? (
                          <ul className="settings-model-list">
                            {filteredCatalog.map((model) => {
                              const isDefault = model === activeProfile.model.trim()
                              return (
                                <li key={model}>
                                  <label className="settings-model-option">
                                    <input
                                      type="checkbox"
                                      aria-label={`在模型菜单中显示 ${model}`}
                                      checked={activeProfile.enabledModels.includes(model)}
                                      disabled={isDefault}
                                      onChange={() => toggleEnabledModel(model)}
                                    />
                                    <span>{model}</span>
                                    {isDefault && <small>默认</small>}
                                  </label>
                                </li>
                              )
                            })}
                          </ul>
                        ) : (
                          <small className="field-caption">{modelCatalog.length ? '没有匹配的模型。' : '暂无已启用的模型；获取列表或输入模型 ID 后可在此勾选。'}</small>
                        )}
                      </div>
                    </label>
                    <label className="field-label span-2">
                      {activeProfile.provider === 'anthropic' ? 'Anthropic API Key' : 'API Key'}
                      <div className="field-password">
                        <input
                          className="field"
                          aria-label={activeProfile.provider === 'anthropic' ? 'Anthropic API Key' : 'API Key'}
                          type={showProfileKey ? 'text' : 'password'}
                          value={activeProfile.apiKey ?? ''}
                          onChange={(event) => updateProfile({ apiKey: event.target.value })}
                          placeholder={activeProfile.hasApiKey ? '已安全保存；留空则保持不变' : activeProfile.provider === 'anthropic' ? 'sk-ant-…' : 'sk-…'}
                        />
                        <button type="button" className="icon-button" onClick={() => setShowProfileKey((value) => !value)} aria-label={showProfileKey ? '隐藏密钥' : '显示密钥'}>
                          {showProfileKey ? <EyeOff size={15} /> : <Eye size={15} />}
                        </button>
                      </div>
                      {activeProfile.hasApiKey && (
                        <span className="field-help">
                          <span>密钥已由系统安全存储保护</span>
                          <button type="button" onClick={() => updateProfile({ apiKey: '', hasApiKey: false })}><Trash2 size={12} />清除密钥</button>
                        </span>
                      )}
                    </label>
                  </div>
                </div>
              </div>
            </section>
          )}

          {panel === 'ai-behavior' && (
            <div className="settings-sections">
              <section className="settings-section">
                <header><BrainCircuit size={16} /><div><h3>模型行为</h3><p>当前服务商：{activeProfile?.name ?? '未配置'}。</p></div></header>
                <div className="settings-grid">
                  <label className="field-label">
                    思考强度
                    <select className="field" value={draft.reasoningEffort} onChange={(event) => patch('reasoningEffort', event.target.value as AppSettings['reasoningEffort'])}>
                      {reasoningEfforts.map((effort) => <option key={effort} value={effort}>{REASONING_LABELS[effort]}</option>)}
                    </select>
                    {activeProfile?.provider === 'anthropic' && <small className="field-caption">Anthropic 不提供 ultra，切换时使用 max。</small>}
                  </label>
                  <label className="field-label">
                    默认范围
                    <select className="field" value={draft.defaultContextScope} onChange={(event) => patch('defaultContextScope', event.target.value as AppSettings['defaultContextScope'])}>
                      <option value="visible">当前内容（选区优先）</option>
                      <option value="document">当前文档</option>
                      <option value="project">当前项目</option>
                      <option value="general">仅模型知识</option>
                    </select>
                  </label>
                  <label className="field-label">
                    上下文窗口（tokens）
                    <input className="field" type="number" min="0" max="2000000" step="1024" value={draft.contextWindowTokens} onChange={(event) => patch('contextWindowTokens', Number(event.target.value))} />
                    <small className="field-caption">0 使用模型预设。</small>
                  </label>
                  <label className="field-label">
                    为回答预留（tokens）
                    <input className="field" type="number" min="1024" max="128000" step="1024" value={draft.contextOutputReserveTokens} onChange={(event) => patch('contextOutputReserveTokens', Number(event.target.value))} />
                  </label>
                  <label className="check-row span-2">
                    <input type="checkbox" checked={draft.contextAutoCompact} onChange={(event) => patch('contextAutoCompact', event.target.checked)} />
                    <span><strong>自动压缩早期会话</strong><small>只压缩请求快照，不删除界面中的原始聊天。</small></span>
                  </label>
                  <label className="check-row">
                    <input type="checkbox" checked={draft.allowGeneralKnowledge} onChange={(event) => patch('allowGeneralKnowledge', event.target.checked)} />
                    <span><strong>允许模型通用知识</strong><small>回答中区分项目来源</small></span>
                  </label>
                  <label className="check-row">
                    <input type="checkbox" checked={draft.autoTitle} onChange={(event) => patch('autoTitle', event.target.checked)} />
                    <span><strong>自动生成会话标题</strong><small>首轮有效对话后更新</small></span>
                  </label>
                  <label className="check-row span-2">
                    <input type="checkbox" checked={draft.projectMemoryEnabled} onChange={(event) => patch('projectMemoryEnabled', event.target.checked)} />
                    <span><strong>启用项目级长期记忆</strong><small>只读取当前项目的 .coscribe/COSCRIBE.md。</small></span>
                  </label>
                </div>
              </section>
              <section className="settings-section">
                <header><ShieldAlert size={16} /><div><h3>AI Shell 权限</h3><p>这是高风险能力，与普通内置终端相互独立。</p></div></header>
                <div className="settings-grid">
                  <label className="check-row span-2">
                    <input type="checkbox" checked={draft.aiShellEnabled} onChange={(event) => patch('aiShellEnabled', event.target.checked)} />
                    <span><strong>启用 AI Shell 功能</strong><small>默认关闭。此开关只显示“开启 AI Shell”入口，不会授权 AI 或执行命令；每次开启仍必须经过风险警告和第二次确认，授权不会跨项目或应用重启保留。</small></span>
                  </label>
                  <label className="field-label span-2">
                    命令确认方式
                    <select className="field" value={draft.aiShellApprovalMode} disabled={!draft.aiShellEnabled} onChange={(event) => patch('aiShellApprovalMode', event.target.value as AppSettings['aiShellApprovalMode'])}>
                      <option value="per-command">每条命令单独确认（推荐）</option>
                      <option value="session">当前项目会话内授权</option>
                    </select>
                    <small className="field-caption">命令以当前登录用户权限运行，工作目录在项目内并不等于文件系统沙箱。</small>
                  </label>
                </div>
              </section>
              <section className="settings-section">
                <header><div><h3>系统提示词</h3><p>用于设定回答风格；固定的文件与密钥安全边界始终优先。</p></div></header>
                <label className="field-label">
                  自定义系统提示词
                  <textarea className="field settings-system-prompt" value={draft.customSystemPrompt} maxLength={20_000} rows={7} placeholder="例如：回答时先给结论，再给依据。" onChange={(event) => patch('customSystemPrompt', event.target.value)} />
                  <span className="field-help">
                    <span>{draft.customSystemPrompt.length.toLocaleString('zh-CN')} / 20,000</span>
                    <button type="button" disabled={!draft.customSystemPrompt} onClick={() => patch('customSystemPrompt', '')}><RotateCcw size={12} />清空</button>
                  </span>
                </label>
              </section>
            </div>
          )}

          {panel === 'image' && (
            <section className="settings-section">
              <header><ImageIcon size={16} /><div><h3>GPT-Image 2 图片生成</h3><p>图片服务与聊天服务使用独立地址和密钥。</p></div></header>
              <div className="settings-grid">
                <label className="field-label span-2">
                  图片生成请求地址
                  <input className="field" value={draft.imageBaseUrl} onChange={(event) => patch('imageBaseUrl', event.target.value)} placeholder="https://example.com/v1" />
                </label>
                <label className="field-label span-2">
                  图片 API Key
                  <div className="field-password">
                    <input className="field" type={showImageKey ? 'text' : 'password'} value={draft.imageApiKey ?? ''} onChange={(event) => patch('imageApiKey', event.target.value)} placeholder={draft.hasImageApiKey ? '已安全保存；留空则保持不变' : '图片服务 API Key'} />
                    <button type="button" className="icon-button" onClick={() => setShowImageKey((value) => !value)} aria-label={showImageKey ? '隐藏图片 API Key' : '显示图片 API Key'}>
                      {showImageKey ? <EyeOff size={15} /> : <Eye size={15} />}
                    </button>
                  </div>
                </label>
              </div>
            </section>
          )}
        </div>
      </div>
    </Dialog>
  )
}
