import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { LoaderCircle } from 'lucide-react'
import '../../styles/viewers.css'

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string
  active?: boolean
  compact?: boolean
}

export function IconButton({
  label,
  active,
  compact,
  className,
  children,
  type = 'button',
  ...props
}: IconButtonProps): React.JSX.Element {
  return (
    <button
      {...props}
      type={type}
      className={cx('vk-viewer-icon-button', active && 'is-active', compact && 'is-compact', className)}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      title={label}
    >
      {children}
    </button>
  )
}

export function ToolbarDivider(): React.JSX.Element {
  return <span className="vk-viewer-toolbar-divider" aria-hidden="true" />
}

export function ViewerSpinner({ label = '正在载入…' }: { label?: string }): React.JSX.Element {
  return (
    <div className="vk-viewer-state" role="status">
      <LoaderCircle className="vk-viewer-spinner" size={22} aria-hidden="true" />
      <span>{label}</span>
    </div>
  )
}

interface ViewerNoticeProps {
  icon?: ReactNode
  title: string
  detail?: ReactNode
  actions?: ReactNode
  tone?: 'neutral' | 'warning' | 'danger'
}

export function ViewerNotice({
  icon,
  title,
  detail,
  actions,
  tone = 'neutral',
}: ViewerNoticeProps): React.JSX.Element {
  return (
    <div className={cx('vk-viewer-notice', `is-${tone}`)} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon && <div className="vk-viewer-notice-icon">{icon}</div>}
      <h2>{title}</h2>
      {detail && <div className="vk-viewer-notice-detail">{detail}</div>}
      {actions && <div className="vk-viewer-notice-actions">{actions}</div>}
    </div>
  )
}
