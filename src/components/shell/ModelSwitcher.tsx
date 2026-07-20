import { useEffect, useRef, useState } from 'react'
import { Bot, Check, ChevronDown } from 'lucide-react'

import {
  SELECTABLE_AI_MODELS,
  type ReasoningEffort,
  type SelectableAiModel
} from '../../shared/types'

interface ModelSwitcherProps {
  model: string
  reasoningEffort: ReasoningEffort
  isConfigured: boolean
  onChange: (patch: { model?: SelectableAiModel; reasoningEffort?: ReasoningEffort }) => Promise<void> | void
}

const REASONING_OPTIONS: Array<{ value: ReasoningEffort; label: string; apiLabel: string }> = [
  { value: 'low', label: 'Low', apiLabel: 'low' },
  { value: 'medium', label: 'Medium', apiLabel: 'medium' },
  { value: 'high', label: 'High', apiLabel: 'high' },
  { value: 'xhigh', label: 'Extra high', apiLabel: 'xhigh' },
  { value: 'max', label: 'More reasoning...', apiLabel: 'max' }
]

const STATUS_LABELS: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max'
}

export function ModelSwitcher({ model, reasoningEffort, isConfigured, onChange }: ModelSwitcherProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent): void => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      setOpen(false)
      triggerRef.current?.focus()
    }
    document.addEventListener('pointerdown', dismiss)
    document.addEventListener('keydown', onKeyDown)
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus({ preventScroll: true })
    })
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('pointerdown', dismiss)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const choose = async (patch: Parameters<ModelSwitcherProps['onChange']>[0]): Promise<void> => {
    setSaving(true)
    try {
      await onChange(patch)
      setOpen(false)
    } finally {
      setSaving(false)
    }
  }

  const moveMenuFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [])]
    if (!items.length) return
    event.preventDefault()
    const current = items.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? items.length - 1
        : event.key === 'ArrowDown'
          ? (current + 1 + items.length) % items.length
          : (current - 1 + items.length) % items.length
    items[next]?.focus()
  }

  return (
    <div className="model-switcher" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className={`status-item model-switcher__trigger ${isConfigured ? 'is-ok' : 'is-warning'}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={isConfigured ? '切换 AI 模型和思考强度' : 'AI 尚未配置；点击选择模型或打开设置'}
        aria-label={`切换 AI 模型和思考强度，当前 ${model}，${STATUS_LABELS[reasoningEffort]}`}
        onClick={() => setOpen((value) => !value)}
      >
        <Bot size={11} />
        <span className="model-switcher__model">{model}</span>
        <span className="model-switcher__effort">{STATUS_LABELS[reasoningEffort]}</span>
        <ChevronDown size={10} aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={menuRef}
          className="model-switcher__menu"
          role="menu"
          aria-label="AI 模型和思考强度"
          onKeyDown={moveMenuFocus}
        >
          <section className="model-switcher__section" role="group" aria-labelledby="model-switcher-models">
            <h3 id="model-switcher-models">模型</h3>
            {SELECTABLE_AI_MODELS.map((option) => (
              <button
                key={option}
                type="button"
                role="menuitemradio"
                aria-checked={model === option}
                disabled={saving}
                onClick={() => void choose({ model: option })}
              >
                <span>{option}</span>
                {model === option && <Check size={13} aria-hidden="true" />}
              </button>
            ))}
          </section>
          <div className="model-switcher__separator" />
          <section className="model-switcher__section" role="group" aria-labelledby="model-switcher-reasoning">
            <h3 id="model-switcher-reasoning">思考强度</h3>
            {REASONING_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={reasoningEffort === option.value}
                disabled={saving}
                onClick={() => void choose({ reasoningEffort: option.value })}
              >
                <span>{option.label}</span>
                <small>{option.apiLabel}</small>
                {reasoningEffort === option.value && <Check size={13} aria-hidden="true" />}
              </button>
            ))}
          </section>
        </div>
      )}
    </div>
  )
}
