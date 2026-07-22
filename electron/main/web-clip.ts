const VIDEO_HOSTS = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'bilibili.com',
  'twitch.tv',
  'douyin.com'
]

const DIRECT_MEDIA_PATH = /\.(?:mp4|m4v|mov|avi|mkv|webm|flv|mp3|m4a|wav|ogg)(?:$|[?#])/iu

export function validatedHttpUrl(value: string): URL {
  if (!value || value.length > 8_000 || /[\r\n]/u.test(value)) throw new Error('网址为空或过长。')
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error('请输入有效的网址。')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('资料浏览器只允许打开 HTTP 或 HTTPS 网页。')
  }
  if (parsed.username || parsed.password) throw new Error('网址不能包含账号或密码。')
  if (parsed.toString().length > 8_000) throw new Error('网址过长。')
  return parsed
}

export function normalizeBrowserInput(input: string): string {
  const value = input.trim()
  if (!value) throw new Error('请输入网址或搜索内容。')
  if (/^https?:\/\//iu.test(value)) return validatedHttpUrl(value).toString()

  const looksLikeHost = /^(?:localhost|\[?::1\]?|127(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/iu.test(value) ||
    /^[^\s/]+\.[^\s/]+(?::\d+)?(?:\/|$)/u.test(value)
  if (looksLikeHost) {
    const local = /^(?:localhost|\[?::1\]?|127(?:\.\d{1,3}){3})(?::\d+)?(?:\/|$)/iu.test(value)
    return validatedHttpUrl(`${local ? 'http' : 'https'}://${value}`).toString()
  }
  if (/^[a-z][a-z\d+.-]*:/iu.test(value)) return validatedHttpUrl(value).toString()
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}

export function shouldUseSystemBrowser(value: string): boolean {
  const url = validatedHttpUrl(value)
  const hostname = url.hostname.toLocaleLowerCase()
  return DIRECT_MEDIA_PATH.test(`${url.pathname}${url.search}${url.hash}`) ||
    VIDEO_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))
}

export function safeCaptureFileBase(title: string): string {
  const cleaned = title
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .replace(/[. ]+$/gu, '')
    .trim()
    .slice(0, 80)
  if (!cleaned || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(cleaned)) return '网页资料'
  return cleaned
}

function escapeMarkdownText(value: string): string {
  return value
    .replace(/\\/gu, '\\\\')
    .replace(/([`*_[\]<>#|~])/gu, '\\$1')
    .replace(/^(\s{0,3})([-+])(?=\s)/gmu, '$1\\$2')
    .replace(/^(\s{0,3}\d+)([.)])(?=\s)/gmu, '$1\\$2')
}

function markdownUrl(value: string): string {
  return `<${value.replace(/>/gu, '%3E')}>`
}

function cleanText(value: string, maximum = 200_000): string {
  return value.replace(/\r\n?/gu, '\n').replace(/[\t ]+\n/gu, '\n').replace(/\n{4,}/gu, '\n\n\n').trim().slice(0, maximum)
}

export function buildWebClipMarkdown(input: {
  title: string
  url: string
  markdown: string
  text: string
  capturedAt?: Date
}): string {
  const url = validatedHttpUrl(input.url).toString()
  const title = escapeMarkdownText(cleanText(input.title, 500) || new URL(url).hostname)
  const capturedAt = (input.capturedAt ?? new Date()).toISOString()
  const body = cleanText(input.markdown) || escapeMarkdownText(cleanText(input.text))
  return [
    `# ${title}`,
    '',
    `> 来源：[${escapeMarkdownText(url)}](${markdownUrl(url)})`,
    `> 保存时间：${capturedAt}`,
    '',
    body || '_网页没有可提取的正文。_',
    ''
  ].join('\n')
}
