import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

interface DialogProps {
  open: boolean
  title: string
  description?: string
  children: React.ReactNode
  footer?: React.ReactNode
  onClose: () => void
  width?: number
}

export function Dialog({ open, title, description, children, footer, onClose, width = 480 }: DialogProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    window.addEventListener('keydown', onKeyDown)
    const frame = requestAnimationFrame(() => {
      const root = dialogRef.current
      const target = root && [
        '[data-autofocus="true"]',
        '.dialog__body input:not(:disabled)',
        '.dialog__body textarea:not(:disabled)',
        '.dialog__body select:not(:disabled)',
        '.dialog__body button:not(:disabled)',
        '.dialog__footer button:not(:disabled)',
        '.dialog__header button:not(:disabled)'
      ].map((selector) => root.querySelector<HTMLElement>(selector)).find(Boolean)
      target?.focus({ preventScroll: true })
    })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  if (!open) return null
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" style={{ width }}>
        <header className="dialog__header">
          <div>
            <h2 id="dialog-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" type="button" onClick={onClose} aria-label="关闭对话框"><X size={16} /></button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer && <footer className="dialog__footer">{footer}</footer>}
      </div>
    </div>
  )
}

interface ConfirmDialogProps {
  open: boolean
  title: string
  description: string
  confirmLabel?: string
  danger?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmDialog({ open, title, description, confirmLabel = '确认', danger, onConfirm, onClose }: ConfirmDialogProps): React.JSX.Element | null {
  return (
    <Dialog
      open={open}
      title={title}
      description={description}
      onClose={onClose}
      width={420}
      footer={<><button className="secondary-button" onClick={onClose}>取消</button><button className={danger ? 'danger-button' : 'primary-button'} onClick={onConfirm}>{confirmLabel}</button></>}
    >
      <div className="dialog-confirm-spacer" />
    </Dialog>
  )
}
