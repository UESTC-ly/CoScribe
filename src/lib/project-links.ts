const EXTERNAL_SCHEME = /^(?:https?:|mailto:|data:|blob:|coscribe-file:|vibe-file:)/iu

function normalizedSegments(value: string): string[] {
  return value.replace(/\\/gu, '/').split('/').filter(Boolean)
}

function withoutQueryOrHash(value: string): string {
  return value.split(/[?#]/u, 1)[0] ?? value
}

function decodedSegment(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Resolve a Markdown-relative path while refusing to leave the active project. */
export function resolveProjectFilePath(
  projectPath: string,
  documentPath: string,
  rawUrl: string
): string | null {
  const rawPath = withoutQueryOrHash(rawUrl.trim())
  if (!rawPath || rawPath.startsWith('#') || EXTERNAL_SCHEME.test(rawPath)) return null

  const root = normalizedSegments(projectPath)
  const document = normalizedSegments(documentPath)
  if (!root.length || document.length <= root.length) return null
  if (!root.every((segment, index) => segment === document[index])) return null

  const result = rawPath.startsWith('/') ? [...root] : document.slice(0, -1)
  for (const encoded of normalizedSegments(rawPath)) {
    const segment = decodedSegment(encoded)
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (result.length <= root.length) return null
      result.pop()
      continue
    }
    if (segment.includes('\0')) return null
    result.push(segment)
  }
  if (result.length <= root.length || !root.every((segment, index) => segment === result[index])) return null
  return `${projectPath.replace(/[\\/]+$/u, '')}/${result.slice(root.length).join('/')}`
}

/** Convert a safe project-relative image into the read-only custom protocol URL. */
export function resolveProjectAssetUrl(
  projectPath: string,
  documentPath: string,
  rawUrl: string
): string {
  if (!rawUrl || EXTERNAL_SCHEME.test(rawUrl) || rawUrl.startsWith('#')) return rawUrl
  const absolute = resolveProjectFilePath(projectPath, documentPath, rawUrl)
  if (!absolute) return ''
  const rootLength = projectPath.replace(/\\/gu, '/').replace(/\/+$/u, '').length
  const relative = absolute.replace(/\\/gu, '/').slice(rootLength).replace(/^\/+/, '')
  return `coscribe-file://project/${relative.split('/').map(encodeURIComponent).join('/')}`
}
