/**
 * Browser-safe path helpers. The renderer must not depend on Node's `path`
 * module, but it still needs to reason about POSIX and Windows paths received
 * from Electron.
 */

const WINDOWS_DRIVE = /^[a-zA-Z]:\//

export function hasNullByte(value: string): boolean {
  return value.includes('\0')
}

export function isAbsolutePortablePath(value: string): boolean {
  const path = value.replace(/\\/g, '/')
  return path.startsWith('/') || path.startsWith('//') || WINDOWS_DRIVE.test(path)
}

export function normalizePortablePath(value: string): string {
  if (!value) return ''

  const slashPath = value.replace(/\\/g, '/')
  const drive = slashPath.match(/^([a-zA-Z]:)(?:\/|$)/)?.[1]
  const unc = !drive && slashPath.startsWith('//')
  const absolute = Boolean(drive || unc || slashPath.startsWith('/'))
  const prefixLength = drive ? drive.length : unc ? 2 : slashPath.startsWith('/') ? 1 : 0
  const body = slashPath.slice(prefixLength)
  const segments: string[] = []

  for (const segment of body.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length > 0 && segments[segments.length - 1] !== '..') {
        segments.pop()
      } else if (!absolute) {
        segments.push('..')
      }
      continue
    }
    segments.push(segment)
  }

  const joined = segments.join('/')
  if (drive) return joined ? `${drive}/${joined}` : `${drive}/`
  if (unc) return joined ? `//${joined}` : '//'
  if (slashPath.startsWith('/')) return joined ? `/${joined}` : '/'
  return joined || (slashPath === '.' ? '.' : '')
}

function comparisonPath(value: string): string {
  const normalized = normalizePortablePath(value).replace(/\/$/, '')
  return WINDOWS_DRIVE.test(normalized) || normalized.startsWith('//')
    ? normalized.toLocaleLowerCase('en-US')
    : normalized
}

export function joinPortablePath(base: string, child: string): string {
  if (isAbsolutePortablePath(child)) return normalizePortablePath(child)
  return normalizePortablePath(`${base.replace(/[\\/]$/, '')}/${child}`)
}

export function resolveProjectPath(projectPath: string, candidate: string): string {
  return isAbsolutePortablePath(candidate)
    ? normalizePortablePath(candidate)
    : joinPortablePath(projectPath, candidate)
}

export function isPathInsideProject(projectPath: string, candidate: string): boolean {
  if (!projectPath || !candidate || hasNullByte(projectPath) || hasNullByte(candidate)) return false
  const root = comparisonPath(projectPath)
  const target = comparisonPath(resolveProjectPath(projectPath, candidate))
  return Boolean(root && target && (target === root || target.startsWith(`${root}/`)))
}

export function toProjectRelativePath(projectPath: string, candidate: string): string | null {
  if (!isPathInsideProject(projectPath, candidate)) return null
  const root = normalizePortablePath(projectPath).replace(/\/$/, '')
  const target = resolveProjectPath(projectPath, candidate)
  if (comparisonPath(root) === comparisonPath(target)) return ''
  return target.slice(root.length + 1)
}

export function samePortablePath(left: string, right: string): boolean {
  return comparisonPath(left) === comparisonPath(right)
}

export function portableBasename(value: string): string {
  const normalized = normalizePortablePath(value).replace(/\/$/, '')
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

export function isMarkdownPath(value: string): boolean {
  return /\.(?:md|markdown)$/i.test(normalizePortablePath(value))
}
