import { constants, realpathSync } from 'node:fs'
import { lstat, open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const UNC_PATH = /^(?:\\\\|\/\/)/

export class PathSecurityError extends Error {
  constructor(message = '路径不在当前项目内，操作已拒绝。') {
    super(message)
    this.name = 'PathSecurityError'
  }
}

export interface PathIdentity {
  path: string
  dev: number
  ino: number
  kind: 'file' | 'directory'
}

function hasTraversalSegment(value: string): boolean {
  return value.split(/[\\/]+/u).some((segment) => segment === '..')
}

function assertPlainPath(value: string): void {
  if (!value || value.includes('\0')) {
    throw new PathSecurityError('文件路径为空或包含非法字符。')
  }
  if (hasTraversalSegment(value)) {
    throw new PathSecurityError('路径包含越级目录，操作已拒绝。')
  }
  if (process.platform !== 'win32' && (WINDOWS_ABSOLUTE.test(value) || UNC_PATH.test(value))) {
    throw new PathSecurityError('不接受其他平台的绝对路径。')
  }
}

export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export async function canonicalDirectory(input: string): Promise<string> {
  assertPlainPath(input)
  const resolved = await realpath(path.resolve(input))
  const info = await stat(resolved)
  if (!info.isDirectory()) {
    throw new PathSecurityError('所选路径不是文件夹。')
  }
  return resolved
}

export class ProjectPathGuard {
  readonly root: string

  constructor(canonicalRoot: string) {
    this.root = realpathSync(path.resolve(canonicalRoot))
  }

  private lexical(input: string): string {
    assertPlainPath(input)
    const candidate = path.resolve(this.root, input)
    if (!isInside(this.root, candidate)) {
      throw new PathSecurityError()
    }
    return candidate
  }

  private async rejectSymlinkSegments(candidate: string, allowMissingTail: boolean): Promise<void> {
    const relative = path.relative(this.root, candidate)
    if (!relative) return

    let cursor = this.root
    const parts = relative.split(path.sep).filter(Boolean)
    for (let index = 0; index < parts.length; index += 1) {
      cursor = path.join(cursor, parts[index])
      try {
        const info = await lstat(cursor)
        if (info.isSymbolicLink()) {
          throw new PathSecurityError('路径包含符号链接，操作已拒绝。')
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && allowMissingTail) return
        throw error
      }
    }
  }

  async existing(input: string, kind: 'any' | 'file' | 'directory' = 'any'): Promise<string> {
    const candidate = this.lexical(input)
    await this.rejectSymlinkSegments(candidate, false)
    const canonical = await realpath(candidate)
    if (!isInside(this.root, canonical)) throw new PathSecurityError()

    const info = await stat(canonical)
    if (kind === 'file' && !info.isFile()) throw new PathSecurityError('目标不是普通文件。')
    if (kind === 'directory' && !info.isDirectory()) throw new PathSecurityError('目标不是文件夹。')
    return canonical
  }

  async target(input: string): Promise<string> {
    const candidate = this.lexical(input)
    if (candidate === this.root) throw new PathSecurityError('不能把项目根目录作为写入目标。')
    await this.rejectSymlinkSegments(candidate, true)

    const parent = path.dirname(candidate)
    await this.rejectSymlinkSegments(parent, false)
    const canonicalParent = await realpath(parent)
    if (!isInside(this.root, canonicalParent)) throw new PathSecurityError()
    const parentInfo = await stat(canonicalParent)
    if (!parentInfo.isDirectory()) throw new PathSecurityError('目标父路径不是文件夹。')

    return path.join(canonicalParent, path.basename(candidate))
  }

  async assertMarkdown(input: string, mustExist: boolean): Promise<string> {
    const candidate = mustExist ? await this.existing(input, 'file') : await this.target(input)
    if (!/\.(?:md|markdown)$/iu.test(candidate)) {
      throw new PathSecurityError('AI 和 Markdown 编辑器只能写入 .md 或 .markdown 文件。')
    }
    return candidate
  }

  async identity(input: string, kind: 'file' | 'directory'): Promise<PathIdentity> {
    const canonical = await this.existing(input, kind)
    const info = await lstat(canonical)
    if (info.isSymbolicLink()) throw new PathSecurityError('路径包含符号链接，操作已拒绝。')
    return { path: canonical, dev: info.dev, ino: info.ino, kind }
  }

  async verifyIdentity(identity: PathIdentity): Promise<void> {
    const current = await this.identity(identity.path, identity.kind)
    if (current.path !== identity.path || current.dev !== identity.dev || current.ino !== identity.ino) {
      throw new PathSecurityError('路径在校验后被替换，操作已拒绝。')
    }
  }

  async openReadOnly(input: string) {
    const candidate = await this.existing(input, 'file')
    const descriptor = await open(candidate, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await descriptor.stat()
      if (!info.isFile()) throw new PathSecurityError('目标不是普通文件。')
      return descriptor
    } catch (error) {
      await descriptor.close()
      throw error
    }
  }
}

export function assertSafeName(name: string, label = '名称'): string {
  const trimmed = name.trim()
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.includes('\0') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    path.basename(trimmed) !== trimmed
  ) {
    throw new PathSecurityError(`${label}包含非法字符。`)
  }
  return trimmed
}

export function assertNotMetadataPath(root: string, candidate: string): void {
  const metadata = path.join(root, '.vibeknowledge')
  if (isInside(metadata, candidate)) {
    throw new PathSecurityError('项目元数据由应用管理，不能通过文件操作修改。')
  }
}
