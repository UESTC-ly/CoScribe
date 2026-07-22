export const PAGE_CAPTURE_SCRIPT = String.raw`(() => {
  const maximum = 200000
  const maximumNodes = 50000
  const maximumDepth = 80
  const maximumSourceCharacters = 2000000
  const title = String(document.title || location.hostname || '网页资料').trim().slice(0, 500)
  const url = String(location.href)
  const selection = String(window.getSelection ? window.getSelection()?.toString() || '' : '').trim().slice(0, maximum)
  const source = document.querySelector('article, [role="main"], main') || document.body
  if (!source) return { title, url, selection, text: '', markdown: '' }

  let sourceCharacters = 0
  let sourceNodes = 0
  const pending = [{ node: source, depth: 0 }]
  while (pending.length) {
    const current = pending.pop()
    if (!current) break
    sourceNodes += 1
    if (sourceNodes > maximumNodes) throw new Error('网页结构超过 50000 个节点，已停止正文提取；仍可保存完整网页归档。')
    if (current.depth > maximumDepth) throw new Error('网页结构嵌套过深，已停止正文提取；仍可保存完整网页归档。')
    if (current.node.nodeType === Node.TEXT_NODE) {
      sourceCharacters += String(current.node.nodeValue || '').length
      if (sourceCharacters > maximumSourceCharacters) throw new Error('网页原始正文过大，已停止 AI 提取；仍可保存完整网页归档。')
    }
    for (let index = current.node.childNodes.length - 1; index >= 0; index -= 1) {
      pending.push({ node: current.node.childNodes[index], depth: current.depth + 1 })
    }
  }

  const root = source.cloneNode(true)
  root.querySelectorAll('script, style, noscript, template, nav, header, footer, aside, form, dialog, iframe, canvas, svg, video, audio, button, input, select, textarea').forEach((node) => node.remove())

  const normalize = (value) => String(value || '').replace(/\u00a0/g, ' ').replace(/[\t ]+/g, ' ').replace(/\s*\n\s*/g, ' ').trim()
  const escapeMarkdown = (value, preserveOuterWhitespace = false) => {
    const raw = String(value || '').replace(/\u00a0/g, ' ')
    const core = normalize(raw)
    const normalized = preserveOuterWhitespace && core
      ? (/^\s/u.test(raw) ? ' ' : '') + core + (/\s$/u.test(raw) ? ' ' : '')
      : core
    return normalized
      .replace(/\\/g, '\\\\')
      .replace(/([\u0060*_[\]<>#|~])/g, '\\$1')
      .replace(/^(\s{0,3})([-+])(?=\s)/u, '$1\\$2')
      .replace(/^(\s{0,3}\d+)([.)])(?=\s)/u, '$1\\$2')
  }
  const safeHttpUrl = (value) => {
    try {
      const parsed = new URL(String(value || ''), document.baseURI)
      if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.toString().length > 8000) return ''
      return parsed.toString()
    } catch {
      return ''
    }
  }
  const destination = (value) => '<' + value.replace(/>/g, '%3E') + '>'
  const maximumBacktickRun = (value) => {
    const tick = String.fromCharCode(96)
    let maximumRun = 0
    let currentRun = 0
    for (const character of String(value)) {
      if (character === tick) {
        currentRun += 1
        maximumRun = Math.max(maximumRun, currentRun)
      } else currentRun = 0
    }
    return maximumRun
  }
  const writer = () => ({
    chunks: [],
    length: 0,
    append(value) {
      if (this.length >= maximum) return
      const part = String(value || '').slice(0, maximum - this.length)
      if (!part) return
      this.chunks.push(part)
      this.length += part.length
    },
    remaining() { return maximum - this.length },
    output() { return this.chunks.join('') }
  })

  const inline = (node, output, depth = 0) => {
    if (output.remaining() <= 0 || depth > maximumDepth) return
    if (node.nodeType === Node.TEXT_NODE) {
      output.append(escapeMarkdown(node.nodeValue, true))
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node
    const tag = element.tagName
    if (tag === 'BR') { output.append('\n'); return }
    if (tag === 'A') {
      const label = escapeMarkdown(element.textContent)
      const href = safeHttpUrl(element.getAttribute('href') || element.href)
      if (href && label) output.append('[' + label + '](' + destination(href) + ')')
      else output.append(label)
      return
    }
    if (tag === 'IMG') {
      const src = safeHttpUrl(element.getAttribute('src') || element.src)
      if (src) output.append('![' + escapeMarkdown(element.alt) + '](' + destination(src) + ')')
      return
    }
    if (tag === 'STRONG' || tag === 'B') output.append('**')
    else if (tag === 'EM' || tag === 'I') output.append('*')
    else if (tag === 'CODE' && element.parentElement?.tagName !== 'PRE') {
      const code = normalize(element.textContent)
      if (!code) return
      const tick = String.fromCharCode(96)
      const fence = tick.repeat(Math.max(1, maximumBacktickRun(code) + 1))
      const padded = /^\s|\s$/u.test(code) || code.startsWith(tick) || code.endsWith(tick) ? ' ' + code + ' ' : code
      output.append(fence + padded + fence)
      return
    }
    Array.from(element.childNodes).forEach((child) => inline(child, output, depth + 1))
    if (tag === 'STRONG' || tag === 'B') output.append('**')
    else if (tag === 'EM' || tag === 'I') output.append('*')
  }

  const markdownWriter = writer()
  const block = (node, depth = 0) => {
    if (markdownWriter.remaining() <= 0 || depth > maximumDepth) return
    if (node.nodeType === Node.TEXT_NODE) {
      const value = escapeMarkdown(node.nodeValue)
      if (value) markdownWriter.append(value + ' ')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node
    const tag = element.tagName
    if (/^H[1-6]$/.test(tag)) {
      markdownWriter.append('#'.repeat(Number(tag.slice(1))) + ' ')
      Array.from(element.childNodes).forEach((child) => inline(child, markdownWriter, depth + 1))
      markdownWriter.append('\n\n')
      return
    }
    if (tag === 'P') {
      Array.from(element.childNodes).forEach((child) => inline(child, markdownWriter, depth + 1))
      markdownWriter.append('\n\n')
      return
    }
    if (tag === 'PRE') {
      const rawCode = String(element.textContent || '').replace(/^\n+|\n+$/g, '')
      const language = String(element.querySelector('code')?.className || '').match(/(?:language-|lang-)([\w+-]+)/i)?.[1] || ''
      const fence = String.fromCharCode(96).repeat(Math.max(3, maximumBacktickRun(rawCode) + 1))
      const overhead = fence.length * 2 + language.length + 3
      const code = rawCode.slice(0, Math.max(0, markdownWriter.remaining() - overhead))
      markdownWriter.append(fence + language + '\n' + code + '\n' + fence + '\n\n')
      return
    }
    if (tag === 'BLOCKQUOTE') {
      const lines = String(element.textContent || '').replace(/\r\n?/g, '\n').split('\n').slice(0, maximumNodes)
      for (const line of lines) markdownWriter.append('> ' + escapeMarkdown(line) + '\n')
      markdownWriter.append('\n')
      return
    }
    if (tag === 'LI') {
      const ordered = element.parentElement?.tagName === 'OL'
      const index = ordered ? Array.from(element.parentElement?.children || []).indexOf(element) + 1 : 0
      markdownWriter.append('  '.repeat(Math.max(0, depth - 1)) + (ordered ? String(index) + '. ' : '- '))
      Array.from(element.childNodes).forEach((child) => inline(child, markdownWriter, depth + 1))
      markdownWriter.append('\n')
      return
    }
    if (tag === 'UL' || tag === 'OL') {
      Array.from(element.children).forEach((child) => block(child, depth + 1))
      markdownWriter.append('\n')
      return
    }
    if (tag === 'HR') { markdownWriter.append('---\n\n'); return }
    if (tag === 'TABLE') {
      const cells = Array.from(element.querySelectorAll('th, td')).map((cell) => escapeMarkdown(cell.textContent)).filter(Boolean)
      markdownWriter.append(cells.join(' | ') + '\n\n')
      return
    }
    if (/^(?:A|B|CODE|EM|I|IMG|STRONG)$/u.test(tag)) {
      inline(element, markdownWriter, depth + 1)
      markdownWriter.append('\n\n')
      return
    }
    Array.from(element.childNodes).forEach((child) => block(child, depth + 1))
  }
  block(root)

  const textWriter = writer()
  const plain = (node, depth = 0) => {
    if (textWriter.remaining() <= 0 || depth > maximumDepth) return
    if (node.nodeType === Node.TEXT_NODE) {
      const value = normalize(node.nodeValue)
      if (value) textWriter.append(value + ' ')
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node
    const blockElement = /^(?:ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|DIV|DL|FIELDSET|FIGCAPTION|FIGURE|FOOTER|H[1-6]|HEADER|HR|LI|MAIN|NAV|OL|P|PRE|SECTION|TABLE|UL)$/u.test(element.tagName)
    if (blockElement) textWriter.append('\n')
    Array.from(element.childNodes).forEach((child) => plain(child, depth + 1))
    if (blockElement) textWriter.append('\n')
  }
  plain(root)

  const clean = (value) => String(value).replace(/\r\n?/g, '\n').replace(/[\t ]+\n/g, '\n').replace(/\n[\t ]+/g, '\n').replace(/[\t ]{2,}/g, ' ').replace(/\n{4,}/g, '\n\n\n').trim()
  return { title, url, selection, text: clean(textWriter.output()), markdown: clean(markdownWriter.output()) }
})()`

export const PAGE_PRINT_BUDGET_SCRIPT = String.raw`(() => {
  const root = document.documentElement
  const body = document.body
  return {
    nodes: document.getElementsByTagName('*').length,
    width: Math.max(root?.scrollWidth || 0, root?.offsetWidth || 0, body?.scrollWidth || 0, body?.offsetWidth || 0),
    height: Math.max(root?.scrollHeight || 0, root?.offsetHeight || 0, body?.scrollHeight || 0, body?.offsetHeight || 0)
  }
})()`
