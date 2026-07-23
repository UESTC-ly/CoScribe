import { memo, useEffect, useState } from 'react'
import { Check, CheckCircle2, Copy, Download, ExternalLink, FileText, Loader2, RotateCcw, Sparkles, Square, XCircle } from 'lucide-react'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import 'katex/dist/katex.min.css'
import { writeClipboardText } from '../../lib/clipboard'
import type { ChatMessage, ContextSnapshot, FileOperationProposal, SourceRef } from '../../shared/types'
import { MermaidDiagram } from '../viewers/MermaidDiagram'
import { AiCodeBlock } from './AiCodeBlock'
import { MarkdownOperationCard } from './MarkdownOperationCard'

export interface MarkdownMessageProps {
  message: ChatMessage
  streaming?: boolean
  operationBusy?: boolean
  onOpenSource: (source: SourceRef) => void
  onOpenContext: (context: ContextSnapshot) => void
  onAcceptOperation: (operation: FileOperationProposal) => void | Promise<void>
  onRejectOperation: (operation: FileOperationProposal) => void | Promise<void>
  onRegenerate?: (message: ChatMessage) => void | Promise<void>
}

function fileName(path?: string): string {
  if (!path) return ''
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
}

function formatContext(snapshot: ContextSnapshot): string {
  const documentName = snapshot.documentName || fileName(snapshot.documentPath)

  if (snapshot.scope === 'selection') {
    return documentName ? `${documentName} · 选中内容` : '发送时的选中内容'
  }
  if (snapshot.scope === 'visible') {
    if (snapshot.pdfPage) return `${documentName || 'PDF'} · 第 ${snapshot.pdfPage} 页`
    if (snapshot.markdownHeading) return `${documentName || 'Markdown'} · ${snapshot.markdownHeading}`
    return documentName ? `${documentName} · 可见内容` : `${snapshot.projectName} · 当前内容`
  }
  if (snapshot.scope === 'document') return documentName || '发送时的完整文档'
  if (snapshot.scope === 'project') return `${snapshot.projectName} · 项目范围`
  return '模型通用知识'
}

function sourceMeta(source: SourceRef): string {
  const bits: string[] = []
  if (source.page) bits.push(`第 ${source.page} 页`)
  if (source.heading) bits.push(source.heading)
  if (source.line) bits.push(`第 ${source.line} 行`)
  return bits.join(' · ')
}

function ProgressTimeline({ message }: { message: ChatMessage }): React.JSX.Element | null {
  if (!message.progress) return null
  return (
    <section className="ai-progress" aria-label={message.progress.kind === 'note-organization' ? '整理笔记进度' : '会话压缩进度'}>
      <header>
        <strong>{message.progress.kind === 'note-organization' ? '整理笔记' : '全量压缩'}</strong>
        <span>{message.progress.status === 'complete' ? '完成' : message.progress.status === 'error' ? '未完成' : '进行中'}</span>
      </header>
      <ol>
        {message.progress.steps.map((step) => (
          <li className={`is-${step.status}`} key={step.stage}>
            {step.status === 'active' ? <Loader2 className="ai-spin" aria-hidden="true" /> : step.status === 'error' ? <XCircle aria-hidden="true" /> : <CheckCircle2 aria-hidden="true" />}
            <span>
              <b>{step.label}</b>
              {step.detail && <small>{step.detail}</small>}
            </span>
          </li>
        ))}
      </ol>
    </section>
  )
}

export function MarkdownContent({ content }: { content: string }): React.JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[rehypeKatex]}
      components={{
        a: ({ children, href, ...props }) => (
          <a href={href} target="_blank" rel="noreferrer noopener" {...props}>
            {children}
            <ExternalLink className="ai-markdown__external" aria-hidden="true" />
          </a>
        ),
        input: ({ type, ...props }) => (
          <input type={type} {...props} disabled={type === 'checkbox' || props.disabled} />
        ),
        pre: ({ node, children, ...props }) => {
          const codeNode = node?.children[0]
          if (codeNode?.type === 'element' && codeNode.tagName === 'code') {
            const classNames = codeNode.properties?.className
            const classes = Array.isArray(classNames) ? classNames.map(String) : [String(classNames ?? '')]
            const languageClass = classes.find((className) => className.startsWith('language-'))
            const language = languageClass?.slice('language-'.length)
            const source = codeNode.children
              .filter((child) => child.type === 'text')
              .map((child) => child.value)
              .join('')
              .replace(/\n$/u, '')

            if (language?.toLowerCase() === 'mermaid') return <MermaidDiagram code={source} />
            return <AiCodeBlock code={source} language={language} />
          }
          return <pre {...props}>{children}</pre>
        }
      }}
    >
      {content}
    </ReactMarkdown>
  )
}

function MessageActions({
  message,
  onRegenerate
}: {
  message: ChatMessage
  onRegenerate?: (message: ChatMessage) => void | Promise<void>
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timeout)
  }, [copied])

  const copy = async (): Promise<void> => {
    try {
      await writeClipboardText(message.content)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="ai-message__actions" aria-label="消息操作">
      <button type="button" onClick={() => void copy()} title="复制回答" aria-label="复制回答">
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </button>
      {onRegenerate && (
        <button
          type="button"
          onClick={() => void onRegenerate(message)}
          title="重新生成"
          aria-label="重新生成"
        >
          <RotateCcw aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export const MarkdownMessage = memo(function MarkdownMessage({
  message,
  streaming = false,
  operationBusy = false,
  onOpenSource,
  onOpenContext,
  onAcceptOperation,
  onRejectOperation,
  onRegenerate
}: MarkdownMessageProps): React.JSX.Element {
  const isAssistant = message.role === 'assistant'
  const displayName = message.kind === 'session-compaction'
    ? '会话压缩'
    : message.kind === 'note-organization'
      ? '笔记整理'
      : isAssistant ? 'AI 助手' : message.role === 'user' ? '你' : '系统'

  return (
    <article className={`ai-message ai-message--${message.role}`} data-message-id={message.id}>
      <div className="ai-message__rail" aria-hidden="true">
        {isAssistant ? <Sparkles /> : message.role === 'user' ? <span>你</span> : <span>i</span>}
      </div>
      <div className="ai-message__body">
        <div className="ai-message__meta">
          <span>{displayName}</span>
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(message.createdAt)}
          </time>
        </div>

        {message.context && message.role === 'user' && (
          <button
            className="ai-message__context"
            type="button"
            onClick={() => onOpenContext(message.context as ContextSnapshot)}
            title="返回发送这条消息时的内容"
          >
            <FileText aria-hidden="true" />
            <span>
              <strong>基于：{formatContext(message.context)}</strong>
              {message.context.scope === 'selection' && message.context.selection && (
                <small>“{message.context.selection.slice(0, 110)}{message.context.selection.length > 110 ? '…' : ''}”</small>
              )}
            </span>
            <ExternalLink aria-hidden="true" />
          </button>
        )}

        {message.attachments && message.attachments.length > 0 && (
          <div className="ai-message__images" aria-label={message.role === 'user' ? '发送的图片' : '生成的图片'}>
            {message.attachments.map((attachment) => (
              <figure key={attachment.id}>
                <img src={attachment.dataUrl} alt={attachment.name} loading="lazy" />
                <figcaption>
                  <span title={attachment.name}>{attachment.name}</span>
                  <a
                    href={attachment.dataUrl}
                    download={attachment.name}
                    title={`下载 ${attachment.name}`}
                    aria-label={`下载 ${attachment.name}`}
                  >
                    <Download aria-hidden="true" />
                  </a>
                </figcaption>
              </figure>
            ))}
          </div>
        )}

        <ProgressTimeline message={message} />

        <div className="ai-markdown">
          {message.content ? (
            <>
              <MarkdownContent content={message.content} />
              {streaming && <span className="ai-stream-caret" aria-label="正在生成" />}
            </>
          ) : streaming ? (
            <span className="ai-thinking"><i /><i /><i /><span className="sr-only">正在思考</span></span>
          ) : null}
        </div>

        {message.stopped && (
          <div className="ai-message__stopped"><Square aria-hidden="true" /> 已停止生成</div>
        )}
        {message.error && <div className="ai-message__error" role="alert">{message.error}</div>}

        {message.sources && message.sources.length > 0 && (
          <section className="ai-sources" aria-label="回答来源">
            <h4>回答来源</h4>
            <ol>
              {message.sources.map((source, index) => (
                <li key={`${source.path}-${source.page ?? ''}-${source.heading ?? ''}-${index}`}>
                  <button type="button" onClick={() => onOpenSource(source)}>
                    <span className="ai-source__index">{index + 1}</span>
                    <span className="ai-source__content">
                      <strong>{source.label || fileName(source.path)}</strong>
                      {sourceMeta(source) && <small>{sourceMeta(source)}</small>}
                      {source.excerpt && <span>{source.excerpt}</span>}
                    </span>
                    <ExternalLink aria-hidden="true" />
                  </button>
                </li>
              ))}
            </ol>
          </section>
        )}

        {message.operation && (
          <MarkdownOperationCard
            operation={message.operation}
            busy={operationBusy}
            onAccept={onAcceptOperation}
            onReject={onRejectOperation}
          />
        )}

        {isAssistant && message.content && !streaming && !message.kind && (
          <MessageActions message={message} onRegenerate={onRegenerate} />
        )}
      </div>
    </article>
  )
})
