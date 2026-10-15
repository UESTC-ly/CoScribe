import { normalizeNextRequest } from '../../src/shared/next-request'

const OPEN = '<coscribe_next_request>'
const CLOSE = '</coscribe_next_request>'
const MAX_TRAILER_CHARS = 2_048

export const NEXT_REQUEST_INSTRUCTIONS = [
  '【必须遵守的界面输出协议】普通回答必须包含两部分：先正常回答用户问题，再在末尾另起一行输出 <coscribe_next_request>预测的下一次用户请求</coscribe_next_request>。这个区块由应用提取到输入框，不属于回答正文，区块之后不要再输出文字。',
  '预测应基于本轮问题和回答，以用户口吻写一句可直接发送的简短请求，使用用户当前语言，不超过 200 字符，不要解释、列出多个选项或使用 Markdown 格式。',
  '预测仅作为输入框候选，不代表用户授权，不得在本轮执行；不得虚构用户同意，不要预测删除、泄露信息或执行命令等操作，不要使用 / 命令。',
  '每次普通回答都要提供一个候选，不要因为用户没有要求追问而省略；没有明确后续时，预测紧贴本轮主题的具体例子、对比或细节问题。用户要求简短或限定正文句数时，也要在正文之外保留这个界面元数据区块。',
  '示例：解释队列用途后，末尾输出 <coscribe_next_request>请给出一个队列的最小使用示例。</coscribe_next_request>，实际候选必须结合本轮内容，不能照抄示例。调用工具的中间步骤不要附加预测；完成最终回答后再附加。'
].join('\n')

/** Hold partial delimiters so prediction metadata never flashes in streamed Markdown. */
export class NextRequestStream {
  private pending = ''
  private trailer: string | undefined
  private oversized = false
  private line = ''
  private fence: { marker: string; length: number } | undefined

  push(text: string): string {
    if (this.trailer !== undefined) {
      this.appendTrailer(text)
      return ''
    }
    this.pending += text
    let visible = ''
    let start = this.pending.indexOf(OPEN)
    while (start >= 0) {
      const before = this.pending.slice(0, start)
      visible += before
      this.trackMarkdown(before)
      this.pending = this.pending.slice(start + OPEN.length)
      // Only a standalone footer outside fenced code is response metadata.
      if (!this.fence && /^ {0,3}$/u.test(this.line)) {
        this.trailer = ''
        this.appendTrailer(this.pending)
        this.pending = ''
        return visible
      }
      visible += OPEN
      this.trackMarkdown(OPEN)
      start = this.pending.indexOf(OPEN)
    }
    let held = Math.min(OPEN.length - 1, this.pending.length)
    while (held > 0 && !OPEN.startsWith(this.pending.slice(-held))) held -= 1
    const ready = this.pending.slice(0, this.pending.length - held)
    visible += ready
    this.trackMarkdown(ready)
    this.pending = held ? this.pending.slice(-held) : ''
    return visible
  }

  finish(): { text: string; nextRequest?: string } {
    // An interrupted reserved tag is metadata; ordinary '<' text remains visible.
    const text = !this.fence && /^ {0,3}$/u.test(this.line) && this.pending.startsWith('<coscribe_') ? '' : this.pending
    this.pending = ''
    if (this.trailer === undefined || this.oversized) return { text }
    const end = this.trailer.indexOf(CLOSE)
    if (end < 0 || this.trailer.slice(end + CLOSE.length).trim()) return { text }
    const nextRequest = normalizeNextRequest(this.trailer.slice(0, end))
    return { text, ...(nextRequest ? { nextRequest } : {}) }
  }

  private appendTrailer(text: string): void {
    if (this.oversized) return
    if ((this.trailer?.length ?? 0) + text.length > MAX_TRAILER_CHARS) {
      this.oversized = true
      this.trailer = ''
      return
    }
    this.trailer += text
  }

  private trackMarkdown(text: string): void {
    const lines = (this.line + text).split('\n')
    this.line = (lines.pop() ?? '').slice(0, 256)
    for (const line of lines) {
      const match = /^ {0,3}(`{3,}|~{3,})(.*)\r?$/u.exec(line)
      if (!match) continue
      if (!this.fence) {
        if (match[1][0] === '`' && match[2].includes('`')) continue
        this.fence = { marker: match[1][0], length: match[1].length }
      } else if (match[1][0] === this.fence.marker && match[1].length >= this.fence.length && !match[2].trim()) {
        this.fence = undefined
      }
    }
  }
}
