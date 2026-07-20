import type { ChatSession, FileNode, SourceRef } from '../shared/types'
import {
  isPathInsideProject,
  normalizePortablePath,
  resolveProjectPath,
  samePortablePath
} from './path-utils'

export interface SourceValidationOptions {
  projectPath: string
  fileTree: readonly FileNode[]
  sessions?: readonly Pick<ChatSession, 'id' | 'title'>[]
  /** Plain text keyed by either absolute or project-relative path. */
  fileContents?: Readonly<Record<string, string>>
  /** Extracted PDF page text keyed by path and then 1-based page number. */
  pdfPageTexts?: Readonly<Record<string, Readonly<Record<number, string>>>>
  pdfPageCounts?: Readonly<Record<string, number>>
  allowGeneralKnowledge?: boolean
  /** App-owned sources attached to the send-time snapshot. AI output cannot add to this list. */
  allowedSources?: readonly SourceRef[]
}

export interface RejectedSource {
  source: SourceRef
  reason: string
}

export interface SourceValidationResult {
  validSources: SourceRef[]
  rejectedSources: RejectedSource[]
}

function flattenFileTree(nodes: readonly FileNode[]): FileNode[] {
  const result: FileNode[] = []
  const visit = (items: readonly FileNode[]): void => {
    for (const item of items) {
      result.push(item)
      if (item.children) visit(item.children)
    }
  }
  visit(nodes)
  return result
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function lookupByPath<T>(
  values: Readonly<Record<string, T>> | undefined,
  projectPath: string,
  path: string
): T | undefined {
  if (!values) return undefined
  const absolute = resolveProjectPath(projectPath, path)
  for (const [candidate, value] of Object.entries(values)) {
    if (samePortablePath(resolveProjectPath(projectPath, candidate), absolute)) return value
  }
  return undefined
}

function reject(target: RejectedSource[], source: SourceRef, reason: string): void {
  target.push({ source: { ...source }, reason })
}

function sessionIdFromPath(path: string): string {
  return path.startsWith('session:') ? path.slice('session:'.length) : path
}

function hasHeading(content: string, heading: string): boolean {
  const wanted = normalizedText(heading.replace(/^#+\s*/, ''))
  return content.split(/\r?\n/).some((line) => {
    const match = line.match(/^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/)
    return match ? normalizedText(match[1]) === wanted : false
  })
}

function sameLocator(left: SourceRef, right: SourceRef, projectPath: string): boolean {
  const leftPath = left.kind === 'session' ? sessionIdFromPath(left.path) : resolveProjectPath(projectPath, left.path)
  const rightPath = right.kind === 'session' ? sessionIdFromPath(right.path) : resolveProjectPath(projectPath, right.path)
  return left.kind === right.kind &&
    samePortablePath(leftPath, rightPath) &&
    left.page === right.page &&
    left.heading === right.heading &&
    left.line === right.line
}

/**
 * Keeps only citations that can be tied to an existing project file/session.
 * When extracted text is supplied, excerpts and headings are checked too;
 * absent evidence is never invented by this helper.
 */
export function validateSources(
  sources: readonly SourceRef[],
  options: SourceValidationOptions
): SourceValidationResult {
  const validSources: SourceRef[] = []
  const rejectedSources: RejectedSource[] = []
  const files = flattenFileTree(options.fileTree).filter((node) => node.kind !== 'folder')
  const seen = new Set<string>()

  for (const rawSource of sources) {
    const allowedSource = options.allowedSources?.find((allowed) =>
      sameLocator(rawSource, allowed, options.projectPath)
    )
    if (options.allowedSources && !allowedSource) {
      reject(rejectedSources, rawSource, '来源不在本次发送上下文的白名单中。')
      continue
    }
    // Once a locator is allowlisted, use the app-owned copy rather than any
    // AI-supplied label or excerpt attached to the same locator.
    const source = allowedSource ? { ...allowedSource } : rawSource

    if (source.kind === 'general') {
      if (!options.allowGeneralKnowledge) {
        reject(rejectedSources, source, '当前设置不允许把模型通用知识作为来源。')
        continue
      }
      const key = 'general'
      if (!seen.has(key)) {
        seen.add(key)
        validSources.push({ ...source, path: 'general', label: '模型通用知识' })
      }
      continue
    }

    if (source.kind === 'session') {
      const sessionId = sessionIdFromPath(source.path)
      const session = options.sessions?.find((item) => item.id === sessionId)
      if (!session) {
        reject(rejectedSources, source, '引用的 AI 会话不存在。')
        continue
      }
      const key = `session:${session.id}`
      if (!seen.has(key)) {
        seen.add(key)
        validSources.push({ ...source, path: key, label: session.title })
      }
      continue
    }

    if (!isPathInsideProject(options.projectPath, source.path)) {
      reject(rejectedSources, source, '来源路径不在当前项目内。')
      continue
    }
    const absolutePath = resolveProjectPath(options.projectPath, source.path)
    const file = files.find((node) => samePortablePath(
      resolveProjectPath(options.projectPath, node.path),
      absolutePath
    ))
    if (!file) {
      reject(rejectedSources, source, '来源文件不存在。')
      continue
    }
    if (source.kind === 'pdf' && file.kind !== 'pdf') {
      reject(rejectedSources, source, '来源类型与项目文件类型不一致。')
      continue
    }
    if (source.kind === 'markdown' && file.kind !== 'markdown') {
      reject(rejectedSources, source, '来源类型与项目文件类型不一致。')
      continue
    }
    if (source.kind === 'text' && file.kind !== 'text' && file.kind !== 'markdown') {
      reject(rejectedSources, source, '来源类型与项目文件类型不一致。')
      continue
    }

    const content = lookupByPath(options.fileContents, options.projectPath, absolutePath)
    if (source.kind === 'pdf') {
      if (!Number.isInteger(source.page) || (source.page ?? 0) < 1) {
        reject(rejectedSources, source, 'PDF 来源缺少有效页码。')
        continue
      }
      const pageCount = lookupByPath(options.pdfPageCounts, options.projectPath, absolutePath)
      if (pageCount !== undefined && (source.page ?? 0) > pageCount) {
        reject(rejectedSources, source, 'PDF 来源页码超出文档范围。')
        continue
      }
      const pages = lookupByPath(options.pdfPageTexts, options.projectPath, absolutePath)
      const pageText = pages?.[source.page as number]
      if (source.excerpt && pageText !== undefined && !normalizedText(pageText).includes(normalizedText(source.excerpt))) {
        reject(rejectedSources, source, 'PDF 来源摘要与该页提取文本不匹配。')
        continue
      }
    } else {
      if (source.line !== undefined) {
        const lineCount = content?.split(/\r?\n/).length
        if (!Number.isInteger(source.line) || source.line < 1 || (lineCount !== undefined && source.line > lineCount)) {
          reject(rejectedSources, source, '来源行号无效。')
          continue
        }
      }
      if (source.heading && content !== undefined && !hasHeading(content, source.heading)) {
        reject(rejectedSources, source, 'Markdown 来源标题不存在。')
        continue
      }
      if (source.excerpt && content !== undefined && !normalizedText(content).includes(normalizedText(source.excerpt))) {
        reject(rejectedSources, source, '来源摘要与文件内容不匹配。')
        continue
      }
    }

    const key = [
      normalizePortablePath(absolutePath),
      source.kind,
      source.page ?? '',
      source.heading ?? '',
      source.line ?? ''
    ].join('|')
    if (seen.has(key)) continue
    seen.add(key)
    validSources.push({
      ...source,
      path: resolveProjectPath(options.projectPath, file.path),
      label: file.name
    })
  }

  return { validSources, rejectedSources }
}

export function isValidSource(source: SourceRef, options: SourceValidationOptions): boolean {
  return validateSources([source], options).validSources.length === 1
}

export const validateSourceRefs = validateSources
