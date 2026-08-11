import type { FileOperationKind, FileOperationProposal, LineEdit } from '../shared/types'
import {
  isAbsolutePortablePath,
  isMarkdownPath,
  isPathInsideProject,
  normalizePortablePath,
  resolveProjectPath,
  samePortablePath,
  toProjectRelativePath
} from './path-utils'

/**
 * Client-side line edit application (same logic as server-side).
 * Used to generate preview content.
 */
function applyLineEditsClient(originalContent: string, edits: LineEdit[]): string {
  if (!edits || edits.length === 0) {
    return originalContent
  }

  const lines = originalContent.split('\n')
  const totalLines = lines.length

  // Validate edits
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i]
    if (edit.startLine < 1 || edit.endLine < edit.startLine || edit.startLine > totalLines || edit.endLine > totalLines) {
      throw new Error(`行号范围无效: ${edit.startLine}-${edit.endLine}`)
    }
    if (i > 0 && edit.startLine < edits[i - 1].startLine) {
      throw new Error('编辑列表必须按起始行号升序排列')
    }
    if (i > 0 && edit.startLine <= edits[i - 1].endLine) {
      throw new Error('编辑范围重叠')
    }
  }

  // Apply from back to front
  const result = [...lines]
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]
    const startIdx = edit.startLine - 1
    const endIdx = edit.endLine
    const newLines = edit.newContent ? edit.newContent.split('\n') : []
    result.splice(startIdx, endIdx - startIdx, ...newLines)
  }

  return result.join('\n')
}


export type FileOperationSafetyCode =
  | 'invalid-project'
  | 'invalid-kind'
  | 'invalid-target'
  | 'outside-project'
  | 'project-root'
  | 'unsupported-extension'
  | 'already-exists'
  | 'missing-target'

export interface FileOperationSafetyResult {
  safe: boolean
  code?: FileOperationSafetyCode
  reason?: string
  absoluteTargetPath?: string
  relativeTargetPath?: string
  warnings: string[]
}

export interface FileOperationIntentDisplay {
  kind: FileOperationKind
  verb: string
  title: string
  summary: string
  targetLabel: string
  requiresConfirmation: true
}

export interface FileOperationPreview extends FileOperationIntentDisplay {
  safe: boolean
  blockedReason?: string
  beforeContent?: string
  proposedContent: string
  afterContent?: string
  contentFormat: 'plain-text'
  warnings: string[]
}

function blocked(code: FileOperationSafetyCode, reason: string): FileOperationSafetyResult {
  return { safe: false, code, reason, warnings: [] }
}

function displayText(value: string): string {
  // Remove terminal/control and bidirectional override characters that could
  // make an untrusted AI target path appear to be a different file.
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '�')
}

function containsPath(paths: readonly string[], candidate: string): boolean {
  return paths.some((path) => samePortablePath(path, candidate))
}

/** Validate a proposal before it is shown or passed to the main process. */
export function validateFileOperation(
  operation: Pick<FileOperationProposal, 'kind' | 'targetPath' | 'proposedContent' | 'expectedModifiedAt' | 'edits'>,
  projectPath: string,
  knownFilePaths: readonly string[] = []
): FileOperationSafetyResult {
  if (!projectPath || !normalizePortablePath(projectPath) || !isAbsolutePortablePath(projectPath)) {
    return blocked('invalid-project', '当前项目路径无效。')
  }
  if (!['create', 'append', 'replace', 'edit'].includes(operation.kind)) {
    return blocked('invalid-kind', 'AI 提议了不支持的文件操作。')
  }
  if (
    !operation.targetPath ||
    /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(operation.targetPath)
  ) {
    return blocked('invalid-target', '目标文件路径为空或包含非法字符。')
  }
  if (!isPathInsideProject(projectPath, operation.targetPath)) {
    return blocked('outside-project', 'AI 只能操作当前项目内部的文件。')
  }

  const absoluteTargetPath = resolveProjectPath(projectPath, operation.targetPath)
  const relativeTargetPath = toProjectRelativePath(projectPath, absoluteTargetPath)
  if (!relativeTargetPath) return blocked('project-root', '目标必须是项目内的 Markdown 文件。')
  if (!isMarkdownPath(absoluteTargetPath)) {
    return blocked('unsupported-extension', '第一版仅允许 AI 创建或修改 Markdown 文件。')
  }

  const absoluteKnownPaths = knownFilePaths.map((path) => resolveProjectPath(projectPath, path))
  const exists = containsPath(absoluteKnownPaths, absoluteTargetPath)
  if (operation.kind === 'create' && exists) {
    return blocked('already-exists', '创建操作不能覆盖已经存在的文件。')
  }
  if ((operation.kind === 'append' || operation.kind === 'replace') && knownFilePaths.length > 0 && !exists) {
    return blocked('missing-target', '要修改的 Markdown 文件不存在。')
  }

  const warnings: string[] = []
  if (operation.kind === 'edit') {
    if (!operation.edits || operation.edits.length === 0) {
      warnings.push('edit 操作缺少 edits 数组。')
    }
  } else {
    if (!operation.proposedContent?.trim()) warnings.push('建议内容为空。')
  }
  if (
    (operation.kind === 'append' || operation.kind === 'replace' || operation.kind === 'edit') &&
    (operation.expectedModifiedAt === undefined || !Number.isFinite(operation.expectedModifiedAt))
  ) {
    warnings.push('缺少文件版本信息，执行前应重新确认磁盘版本。')
  }

  return { safe: true, absoluteTargetPath, relativeTargetPath, warnings }
}

export function describeFileOperationIntent(
  operation: Pick<FileOperationProposal, 'kind' | 'targetPath' | 'summary'>,
  projectPath?: string
): FileOperationIntentDisplay {
  const copy: Record<FileOperationKind, { verb: string; title: string }> = {
    create: { verb: '创建', title: '创建 Markdown 笔记' },
    append: { verb: '追加', title: '追加到 Markdown 笔记' },
    replace: { verb: '修改', title: '修改 Markdown 内容' },
    edit: { verb: '编辑', title: '编辑 Markdown 行' }
  }
  const labels = copy[operation.kind]
  const relative = projectPath ? toProjectRelativePath(projectPath, operation.targetPath) : null
  return {
    kind: operation.kind,
    verb: labels.verb,
    title: labels.title,
    summary: displayText(operation.summary),
    targetLabel: displayText(relative || normalizePortablePath(operation.targetPath) || '未指定文件'),
    requiresConfirmation: true
  }
}

export function buildFileOperationPreview(
  operation: FileOperationProposal,
  projectPath: string,
  knownFilePaths: readonly string[] = []
): FileOperationPreview {
  const safety = validateFileOperation(operation, projectPath, knownFilePaths)
  const intent = describeFileOperationIntent(operation, projectPath)
  const beforeContent = operation.originalContent
  let afterContent: string | undefined
  if (operation.kind === 'create' || operation.kind === 'replace') {
    afterContent = operation.proposedContent ?? ''
  } else if (operation.kind === 'edit' && beforeContent !== undefined && operation.edits) {
    // Apply line edits to compute afterContent
    try {
      afterContent = applyLineEditsClient(beforeContent, operation.edits)
    } catch (error) {
      // If edit application fails, show error in preview
      afterContent = beforeContent
    }
  } else if (operation.kind === 'append' && beforeContent !== undefined) {
    const separator = beforeContent.length > 0 && !beforeContent.endsWith('\n') ? '\n' : ''
    afterContent = `${beforeContent}${separator}${operation.proposedContent ?? ''}`
  }

  return {
    ...intent,
    safe: safety.safe,
    blockedReason: safety.reason,
    beforeContent,
    proposedContent: operation.proposedContent ?? '',
    afterContent,
    contentFormat: 'plain-text',
    warnings: [...safety.warnings]
  }
}

export const getSafeFileOperationPreview = buildFileOperationPreview
