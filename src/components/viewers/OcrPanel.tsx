import { Check, Copy, Loader2, ScanText, Sparkles, X } from 'lucide-react'
import { useState } from 'react'

import { writeClipboardText } from '../../lib/clipboard'
import type { OcrResult } from '../../shared/types'
import type { OcrStatus } from './useOcrSession'

interface OcrPanelProps {
  result: OcrResult | null
  status: OcrStatus
  error: string | null
  onLocal: () => void
  onAi: () => void
  onCancel: () => void
  onClose: () => void
}

export function OcrPanel(props: OcrPanelProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const busy = props.status !== 'idle'
  const average = props.result?.lines.length
    ? props.result.lines.reduce((sum, line) => sum + (line.score ?? 0), 0) / props.result.lines.length
    : null

  return (
    <aside className="vk-ocr-panel" aria-label="OCR 识别结果">
      <header>
        <div>
          <strong>文字识别</strong>
          <span>{props.result?.engine === 'ai-vision' ? 'AI 增强' : 'PP-OCRv6 · 本地'}</span>
        </div>
        <button type="button" className="vk-viewer-icon-button" aria-label="关闭 OCR 结果" onClick={props.onClose}>
          <X size={15} />
        </button>
      </header>

      <div className="vk-ocr-actions">
        <button type="button" className="vk-viewer-text-button" disabled={busy} onClick={props.onLocal}>
          <ScanText size={15} /> 本地识别
        </button>
        <button type="button" className="vk-viewer-text-button is-emphasis" disabled={busy} onClick={props.onAi} title="当前图像会发送到已配置的 AI 服务">
          <Sparkles size={15} /> AI 增强
        </button>
        {props.status === 'ai' ? (
          <button type="button" className="vk-viewer-text-button" onClick={props.onCancel}>取消</button>
        ) : !busy && props.result?.text ? (
          <button
            type="button"
            className="vk-viewer-icon-button"
            aria-label="复制识别文字"
            onClick={() => {
              void writeClipboardText(props.result?.text ?? '').then(() => {
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1_200)
              })
            }}
          >
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </button>
        ) : null}
      </div>

      {busy && (
        <div className="vk-ocr-state"><Loader2 size={18} className="is-spinning" />{props.status === 'local' ? '正在本地识别…' : '正在进行 AI 增强…'}</div>
      )}
      {props.error && <div className="vk-ocr-error" role="alert">{props.error}</div>}
      {!busy && !props.error && props.result && (
        <>
          <div className="vk-ocr-meta">
            <span>{props.result.lines.length ? `${props.result.lines.length} 行` : '结构化转写'}</span>
            {average !== null && <span>平均置信度 {Math.round(average * 100)}%</span>}
            {props.result.page && <span>第 {props.result.page} 页</span>}
          </div>
          <pre className="vk-ocr-text">{props.result.text || '没有识别到可用文字。'}</pre>
          {props.result.warnings?.map((warning) => <p className="vk-ocr-warning" key={warning}>{warning}</p>)}
        </>
      )}
      {!busy && !props.error && !props.result && <div className="vk-ocr-empty">尚未识别当前图像。</div>}
      <footer>AI 增强会将当前图像发送到你配置的服务；结果请对照原文校对。</footer>
    </aside>
  )
}
