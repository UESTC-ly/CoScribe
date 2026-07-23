import { useEffect, useId, useMemo, useState } from 'react'
import type { RefObject } from 'react'
import type { ChatMessage } from '../../shared/types'

interface ConversationTurnNavigatorProps {
  messages: readonly ChatMessage[]
  scrollContainerRef: RefObject<HTMLDivElement | null>
}

const ACTIVE_TURN_OFFSET = 56
const NAVIGATION_TOP_OFFSET = 12
const SUMMARY_LENGTH = 42
const REQUEST_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit'
})

function summarizeRequest(message: ChatMessage): string {
  const text = message.content.replace(/\s+/gu, ' ').trim()
  if (!text) {
    const imageCount = message.attachments?.length ?? 0
    return imageCount > 0 ? `图片提问（${imageCount} 张）` : '未填写文字的请求'
  }

  const characters = Array.from(text)
  return characters.length > SUMMARY_LENGTH
    ? `${characters.slice(0, SUMMARY_LENGTH).join('')}…`
    : text
}

function formatRequestTime(createdAt: number): string {
  return REQUEST_TIME_FORMATTER.format(createdAt)
}

function messageElements(container: HTMLElement): Map<string, HTMLElement> {
  return new Map(
    Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]'))
      .map((element) => [element.dataset.messageId, element] as const)
      .filter((entry): entry is [string, HTMLElement] => Boolean(entry[0]))
  )
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function ConversationTurnNavigator({
  messages,
  scrollContainerRef
}: ConversationTurnNavigatorProps): React.JSX.Element | null {
  const turns = useMemo(
    () => messages.filter((message) => message.role === 'user'),
    [messages]
  )
  const turnKey = turns.map((turn) => turn.id).join('\u0000')
  const tooltipPrefix = useId().replaceAll(':', '')
  const [activeMessageId, setActiveMessageId] = useState<string | null>(
    turns.at(-1)?.id ?? null
  )

  useEffect(() => {
    setActiveMessageId((current) => (
      current && turns.some((turn) => turn.id === current)
        ? current
        : turns.at(-1)?.id ?? null
    ))
  // Only reset when request identities change, not for every streamed assistant token.
  }, [turnKey])

  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container || turns.length < 2) return

    let frame: number | null = null

    const updateActiveTurn = (): void => {
      frame = null
      const elements = messageElements(container)
      const threshold = container.scrollTop + ACTIVE_TURN_OFFSET
      let nextActive = turns[0]?.id ?? null

      for (const turn of turns) {
        const element = elements.get(turn.id)
        if (!element) continue
        if (element.offsetTop > threshold) break
        nextActive = turn.id
      }

      setActiveMessageId((current) => current === nextActive ? current : nextActive)
    }

    const scheduleUpdate = (): void => {
      if (frame !== null) return
      frame = typeof window.requestAnimationFrame === 'function'
        ? window.requestAnimationFrame(updateActiveTurn)
        : window.setTimeout(updateActiveTurn, 0)
    }

    container.addEventListener('scroll', scheduleUpdate, { passive: true })
    window.addEventListener('resize', scheduleUpdate)
    scheduleUpdate()

    const resizeObserver = typeof ResizeObserver === 'function'
      ? new ResizeObserver(scheduleUpdate)
      : null
    resizeObserver?.observe(container)

    return () => {
      container.removeEventListener('scroll', scheduleUpdate)
      window.removeEventListener('resize', scheduleUpdate)
      resizeObserver?.disconnect()
      if (frame !== null) {
        if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(frame)
        window.clearTimeout(frame)
      }
    }
  }, [scrollContainerRef, turnKey])

  if (turns.length < 2) return null

  const scrollToTurn = (messageId: string): void => {
    const container = scrollContainerRef.current
    if (!container) return
    const target = messageElements(container).get(messageId)
    if (!target) return

    const top = Math.max(0, target.offsetTop - NAVIGATION_TOP_OFFSET)
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({
        top,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth'
      })
    } else {
      container.scrollTop = top
    }
    setActiveMessageId(messageId)
  }

  return (
    <nav
      className="ai-turn-nav"
      aria-label="对话请求导航"
      style={{ height: `${Math.min(turns.length * 13 + 12, 360)}px` }}
    >
      <span className="ai-turn-nav__spine" aria-hidden="true" />
      <ol>
        {turns.map((turn, index) => {
          const number = index + 1
          const summary = summarizeRequest(turn)
          const tooltipId = `${tooltipPrefix}-turn-${number}`
          const current = turn.id === activeMessageId

          return (
            <li key={turn.id}>
              <button
                type="button"
                className="ai-turn-nav__item"
                aria-label={`跳转到第 ${number} 次请求：${summary}`}
                aria-describedby={tooltipId}
                aria-current={current ? 'step' : undefined}
                onClick={() => scrollToTurn(turn.id)}
              >
                <i className="ai-turn-nav__marker" aria-hidden="true" />
                <span className="ai-turn-nav__tooltip" id={tooltipId} role="tooltip">
                  <span className="ai-turn-nav__tooltip-meta">
                    <b>第 {number} 次请求</b>
                    <time dateTime={new Date(turn.createdAt).toISOString()}>
                      {formatRequestTime(turn.createdAt)}
                    </time>
                  </span>
                  <strong>{summary}</strong>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </nav>
  )
}
