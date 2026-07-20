import { useEffect, useState } from 'react'
import { Eye, EyeOff, KeyRound } from 'lucide-react'
import { REASONING_EFFORTS, SELECTABLE_AI_MODELS, type AppSettings } from '../../shared/types'
import { Dialog } from './Dialog'

const REASONING_LABELS: Record<AppSettings['reasoningEffort'], string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'More reasoning...'
}

interface SettingsDialogProps {
  open: boolean
  settings: AppSettings
  onSave: (settings: AppSettings) => Promise<void> | void
  onClose: () => void
}

export function SettingsDialog({ open, settings, onSave, onClose }: SettingsDialogProps): React.JSX.Element | null {
  const [draft, setDraft] = useState(settings)
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  useEffect(() => setDraft(settings), [settings, open])
  const patch = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => setDraft((current) => ({ ...current, [key]: value }))
  const save = async (): Promise<void> => { setSaving(true); try { await onSave(draft); onClose() } finally { setSaving(false) } }

  return (
    <Dialog
      open={open}
      title="设置"
      description="AI 配置保存在本机。未配置 AI 时，文件阅读和 Markdown 编辑仍然可用。"
      onClose={onClose}
      width={620}
      footer={<><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving} onClick={() => void save()}>{saving ? '正在保存…' : '保存设置'}</button></>}
    >
      <div className="settings-sections">
        <section>
          <header><KeyRound size={16} /><div><h3>AI 服务</h3><p>支持 OpenAI-compatible 的 Responses 与 Chat Completions 接口。</p></div></header>
          <div className="settings-grid">
            <label className="field-label span-2">服务地址<input className="field" value={draft.baseUrl} onChange={(event) => patch('baseUrl', event.target.value)} placeholder="https://api.openai.com/v1" /></label>
            <label className="field-label">接口协议<select className="field" value={draft.apiProtocol} onChange={(event) => patch('apiProtocol', event.target.value as AppSettings['apiProtocol'])}><option value="auto">自动</option><option value="responses">Responses API</option><option value="chat-completions">Chat Completions</option></select></label>
            <label className="field-label">思考强度<select className="field" value={draft.reasoningEffort} onChange={(event) => patch('reasoningEffort', event.target.value as AppSettings['reasoningEffort'])}>{REASONING_EFFORTS.map((effort) => <option key={effort} value={effort}>{REASONING_LABELS[effort]}</option>)}</select></label>
            <label className="field-label span-2">模型<input className="field" list="ai-model-options" value={draft.model} onChange={(event) => patch('model', event.target.value)} placeholder="gpt-5.6-terra" /><datalist id="ai-model-options">{SELECTABLE_AI_MODELS.map((model) => <option key={model} value={model} />)}</datalist></label>
            <label className="field-label span-2">API Key<div className="field-password"><input className="field" type={showKey ? 'text' : 'password'} value={draft.apiKey ?? ''} onChange={(event) => patch('apiKey', event.target.value)} placeholder={draft.hasApiKey ? '已安全保存；留空则保持不变' : 'sk-…'} /><button type="button" className="icon-button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? '隐藏密钥' : '显示密钥'}>{showKey ? <EyeOff size={15} /> : <Eye size={15} />}</button></div></label>
          </div>
        </section>
        <section>
          <header><div><h3>阅读与外观</h3><p>这些设置只影响工作台，不改变项目文件。</p></div></header>
          <div className="settings-grid">
            <label className="field-label">主题<select className="field" value={draft.theme} onChange={(event) => patch('theme', event.target.value as AppSettings['theme'])}><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label>
            <label className="field-label">字体大小<div className="range-field"><input type="range" min="12" max="20" value={draft.fontSize} onChange={(event) => patch('fontSize', Number(event.target.value))} /><output>{draft.fontSize}px</output></div></label>
            <label className="field-label span-2">默认项目路径<input className="field" value={draft.defaultProjectPath} onChange={(event) => patch('defaultProjectPath', event.target.value)} placeholder="可选" /></label>
            <label className="check-row"><input type="checkbox" checked={draft.autoSave} onChange={(event) => patch('autoSave', event.target.checked)} /><span><strong>自动保存 Markdown</strong><small>停止输入后约 {draft.autoSaveDelay} ms 保存</small></span></label>
            <label className="field-label">自动保存延迟<input className="field" type="number" min="300" max="10000" step="100" value={draft.autoSaveDelay} disabled={!draft.autoSave} onChange={(event) => patch('autoSaveDelay', Number(event.target.value))} /></label>
          </div>
        </section>
        <section>
          <header><div><h3>AI 上下文</h3><p>默认只理解当前可见内容，不会自动扫描整个项目。</p></div></header>
          <div className="settings-grid">
            <label className="field-label">默认范围<select className="field" value={draft.defaultContextScope} onChange={(event) => patch('defaultContextScope', event.target.value as AppSettings['defaultContextScope'])}><option value="visible">自动（当前可见内容）</option><option value="document">当前文档</option><option value="project">当前项目</option><option value="general">仅模型知识</option></select></label>
            <div />
            <label className="check-row"><input type="checkbox" checked={draft.allowGeneralKnowledge} onChange={(event) => patch('allowGeneralKnowledge', event.target.checked)} /><span><strong>允许模型通用知识</strong><small>回答中会明确区分项目来源</small></span></label>
            <label className="check-row"><input type="checkbox" checked={draft.autoTitle} onChange={(event) => patch('autoTitle', event.target.checked)} /><span><strong>自动生成会话标题</strong><small>首轮有效对话后更新</small></span></label>
          </div>
        </section>
      </div>
    </Dialog>
  )
}
