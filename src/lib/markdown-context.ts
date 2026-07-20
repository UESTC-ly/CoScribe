export interface MarkdownHeadingBoundary {
  text: string
  level: number
  start: number
  lineEnd: number
  contentStart: number
}

export interface MarkdownSectionBoundary {
  heading?: string
  level?: number
  start: number
  contentStart: number
  end: number
  text: string
  content: string
}

interface MarkdownLine {
  text: string
  start: number
  end: number
  endWithBreak: number
}

function linesWithOffsets(markdown: string): MarkdownLine[] {
  if (markdown.length === 0) return [{ text: '', start: 0, end: 0, endWithBreak: 0 }]

  const lines: MarkdownLine[] = []
  const pattern = /.*(?:\r\n|\n|\r|$)/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(markdown)) !== null) {
    if (match[0] === '') break
    const raw = match[0]
    const breakLength = raw.endsWith('\r\n') ? 2 : raw.endsWith('\n') || raw.endsWith('\r') ? 1 : 0
    const start = match.index
    const end = start + raw.length - breakLength
    lines.push({ text: raw.slice(0, raw.length - breakLength), start, end, endWithBreak: start + raw.length })
  }
  return lines
}

function cleanAtxHeading(raw: string): string {
  return raw.replace(/[ \t]+#+[ \t]*$/, '').trim()
}

/**
 * Extract real Markdown headings while ignoring heading-like text in fenced
 * code blocks. ATX and Setext headings are both supported.
 */
export function getMarkdownHeadings(markdown: string): MarkdownHeadingBoundary[] {
  const lines = linesWithOffsets(markdown)
  const headings: MarkdownHeadingBoundary[] = []
  let fence: { marker: '`' | '~'; length: number } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fenceMatch = line.text.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch) {
      const token = fenceMatch[1]
      const marker = token[0] as '`' | '~'
      if (!fence) {
        fence = { marker, length: token.length }
      } else if (
        marker === fence.marker &&
        token.length >= fence.length &&
        line.text.slice((fenceMatch.index ?? 0) + fenceMatch[0].length).trim().length === 0
      ) {
        fence = null
      }
      continue
    }
    if (fence) continue

    const atx = line.text.match(/^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/)
    if (atx) {
      const text = cleanAtxHeading(atx[2] ?? '')
      headings.push({
        text,
        level: atx[1].length,
        start: line.start,
        lineEnd: line.end,
        contentStart: line.endWithBreak
      })
      continue
    }

    const setext = line.text.match(/^ {0,3}(=+|-+)[ \t]*$/)
    const previous = index > 0 ? lines[index - 1] : undefined
    if (
      setext &&
      previous &&
      previous.text.trim().length > 0 &&
      !/^ {0,3}(?:>|[-+*][ \t]|\d+[.)][ \t])/.test(previous.text)
    ) {
      headings.push({
        text: previous.text.trim(),
        level: setext[1][0] === '=' ? 1 : 2,
        start: previous.start,
        lineEnd: line.end,
        contentStart: line.endWithBreak
      })
    }
  }

  return headings
}

/**
 * Returns the smallest heading section containing the cursor. A section ends
 * at the next heading of the same or a higher level. Text before the first
 * heading is treated as an untitled preamble section.
 */
export function getMarkdownSection(markdown: string, cursor: number): MarkdownSectionBoundary {
  const safeCursor = Math.max(0, Math.min(Number.isFinite(cursor) ? cursor : 0, markdown.length))
  const headings = getMarkdownHeadings(markdown)
  let currentIndex = -1

  for (let index = 0; index < headings.length; index += 1) {
    if (headings[index].start <= safeCursor) currentIndex = index
    else break
  }

  if (currentIndex < 0) {
    const end = headings[0]?.start ?? markdown.length
    return {
      start: 0,
      contentStart: 0,
      end,
      text: markdown.slice(0, end),
      content: markdown.slice(0, end)
    }
  }

  const current = headings[currentIndex]
  let end = markdown.length
  for (let index = currentIndex + 1; index < headings.length; index += 1) {
    if (headings[index].level <= current.level) {
      end = headings[index].start
      break
    }
  }

  return {
    heading: current.text,
    level: current.level,
    start: current.start,
    contentStart: current.contentStart,
    end,
    text: markdown.slice(current.start, end),
    content: markdown.slice(current.contentStart, end)
  }
}

export const findCurrentMarkdownSection = getMarkdownSection
