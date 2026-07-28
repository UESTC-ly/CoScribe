import { AI_CODE_COMPLETION_LIMITS } from '../shared/types'

export const AUTO_COMPLETION_DELAY_MS = 160
export const MAX_AI_COMPLETION_PREFIX_CHARS = 12_000
export const MAX_AI_COMPLETION_SUFFIX_CHARS = 4_000
export const MAX_AI_COMPLETION_CONTEXT_CHARS = 8_000
export const MAX_INLINE_COMPLETION_CHARS = Math.max(
  ...Object.values(AI_CODE_COMPLETION_LIMITS).map((limits) => limits.maxChars)
)

export interface AiCompletionContext {
  prefix: string
  suffix: string
  context: string
}

export interface LocalCodeCompletionOption {
  label: string
  type: 'class' | 'function' | 'keyword' | 'property' | 'type' | 'variable'
  detail?: string
  boost?: number
}

const COMMON_KEYWORDS = [
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'else',
  'export',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'import',
  'in',
  'let',
  'new',
  'null',
  'return',
  'switch',
  'throw',
  'true',
  'try',
  'undefined',
  'while'
]

const LANGUAGE_KEYWORDS: Record<string, string[]> = {
  Python: ['and', 'as', 'assert', 'def', 'del', 'elif', 'except', 'False', 'from', 'global', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'True', 'with', 'yield'],
  TypeScript: ['abstract', 'any', 'declare', 'enum', 'implements', 'interface', 'keyof', 'namespace', 'never', 'private', 'protected', 'public', 'readonly', 'satisfies', 'type', 'typeof', 'unknown'],
  'TypeScript JSX': ['abstract', 'any', 'declare', 'enum', 'implements', 'interface', 'keyof', 'namespace', 'never', 'private', 'protected', 'public', 'readonly', 'satisfies', 'type', 'typeof', 'unknown'],
  JavaScript: ['debugger', 'delete', 'extends', 'instanceof', 'of', 'super', 'this', 'void', 'yield'],
  'JavaScript JSX': ['debugger', 'delete', 'extends', 'instanceof', 'of', 'super', 'this', 'void', 'yield'],
  'C++': ['auto', 'bool', 'constexpr', 'friend', 'inline', 'namespace', 'nullptr', 'operator', 'private', 'protected', 'public', 'struct', 'template', 'typename', 'using', 'virtual'],
  C: ['auto', 'char', 'double', 'enum', 'extern', 'float', 'inline', 'int', 'long', 'sizeof', 'static', 'struct', 'typedef', 'union', 'unsigned', 'void'],
  Go: ['chan', 'defer', 'fallthrough', 'func', 'go', 'goto', 'map', 'package', 'range', 'select', 'struct', 'var'],
  Rust: ['as', 'crate', 'dyn', 'enum', 'extern', 'fn', 'impl', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'self', 'Self', 'struct', 'trait', 'unsafe', 'use', 'where'],
  Java: ['boolean', 'byte', 'extends', 'final', 'implements', 'instanceof', 'interface', 'long', 'package', 'private', 'protected', 'public', 'static', 'super', 'this', 'void'],
  Shell: ['alias', 'cd', 'do', 'done', 'echo', 'esac', 'export', 'fi', 'function', 'local', 'then', 'until'],
  SQL: ['ALTER', 'CREATE', 'DELETE', 'FROM', 'GROUP', 'INSERT', 'JOIN', 'ORDER', 'SELECT', 'UPDATE', 'WHERE']
}

const DECLARATION_PATTERN = /\b(class|def|enum|fn|function|interface|struct|trait|type)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu
const VARIABLE_PATTERN = /\b(const|let|var|final|mut|val)\s+([\p{L}_$][\p{L}\p{N}_$]*)/gu
const ASSIGNMENT_PATTERN = /^\s*([\p{L}_$][\p{L}\p{N}_$]*)\s*=/gmu
const IDENTIFIER_PATTERN = /[\p{L}_$][\p{L}\p{N}_$]*/gu
const IMPORT_LINE_PATTERN = /^\s*(?:#include\b|from\b|import\b|package\b|require\b|use\b|using\b)/u

function declarationType(kind: string): LocalCodeCompletionOption['type'] {
  if (kind === 'class' || kind === 'struct') return 'class'
  if (kind === 'interface' || kind === 'trait' || kind === 'type' || kind === 'enum') return 'type'
  return 'function'
}

function latestBlockStart(documentText: string, cursor: number): number {
  const before = documentText.slice(0, cursor)
  const pattern = /^\s*(?:export\s+)?(?:async\s+)?(?:class|def|enum|fn|function|interface|struct|trait|type)\b/gmu
  let start = 0
  for (const match of before.matchAll(pattern)) start = match.index ?? start
  return start
}

function fileContext(documentText: string): string {
  const imports = documentText
    .split(/\r?\n/u)
    .slice(0, 300)
    .filter((line) => IMPORT_LINE_PATTERN.test(line))
    .slice(0, 80)
    .join('\n')
    .slice(0, 4_000)

  const symbols: string[] = []
  const seen = new Set<string>()
  for (const match of documentText.matchAll(DECLARATION_PATTERN)) {
    const label = match[2]
    if (label && !seen.has(label)) {
      seen.add(label)
      symbols.push(label)
    }
    if (symbols.length >= 80) break
  }
  for (const match of documentText.matchAll(VARIABLE_PATTERN)) {
    const label = match[2]
    if (label && !seen.has(label)) {
      seen.add(label)
      symbols.push(label)
    }
    if (symbols.length >= 80) break
  }
  for (const match of documentText.matchAll(ASSIGNMENT_PATTERN)) {
    const label = match[1]
    if (label && !seen.has(label)) {
      seen.add(label)
      symbols.push(label)
    }
    if (symbols.length >= 80) break
  }

  return [
    imports ? `Imports:\n${imports}` : '',
    symbols.length ? `Visible symbols: ${symbols.join(', ')}` : ''
  ].filter(Boolean).join('\n\n').slice(0, MAX_AI_COMPLETION_CONTEXT_CHARS)
}

export function buildAiCompletionContext(documentText: string, cursor: number): AiCompletionContext {
  const safeCursor = Math.max(0, Math.min(cursor, documentText.length))
  const blockStart = latestBlockStart(documentText, safeCursor)
  const prefixStart = Math.max(blockStart, safeCursor - MAX_AI_COMPLETION_PREFIX_CHARS)
  return {
    prefix: documentText.slice(prefixStart, safeCursor),
    suffix: documentText.slice(safeCursor, safeCursor + MAX_AI_COMPLETION_SUFFIX_CHARS),
    context: fileContext(documentText)
  }
}

export function canRequestAutoCompletion(documentText: string, cursor: number, selectionEmpty: boolean): boolean {
  if (!selectionEmpty || cursor < 0 || cursor > documentText.length) return false
  const beforeCursor = documentText.slice(0, cursor)
  const lines = beforeCursor.split(/\r?\n/u)
  const line = lines.at(-1)?.trim() ?? ''
  if (line) return /[\p{L}\p{N}_$)\]}"'`.,:=>+\-*/]/u.test(line)

  // Pressing Enter creates an empty current line. The preceding non-empty line
  // is enough context to suggest the next statement, but multiple blank lines
  // still avoid unnecessary model requests.
  const previousLine = lines.at(-2)?.trim() ?? ''
  return Boolean(previousLine) && /[\p{L}\p{N}_$)\]}"'`.,:=>+\-*/]/u.test(previousLine)
}

export function localCodeCompletionOptions(documentText: string, language: string): LocalCodeCompletionOption[] {
  const options: LocalCodeCompletionOption[] = []
  const seen = new Set<string>()
  const add = (option: LocalCodeCompletionOption): void => {
    if (!option.label || seen.has(option.label)) return
    seen.add(option.label)
    options.push(option)
  }

  for (const match of documentText.matchAll(DECLARATION_PATTERN)) {
    const [kind, label] = [match[1], match[2]]
    if (kind && label) add({ label, type: declarationType(kind), detail: `当前文件 ${kind}`, boost: 80 })
  }
  for (const match of documentText.matchAll(VARIABLE_PATTERN)) {
    const label = match[2]
    if (label) add({ label, type: 'variable', detail: '当前文件变量', boost: 60 })
  }
  for (const match of documentText.matchAll(ASSIGNMENT_PATTERN)) {
    const label = match[1]
    if (label) add({ label, type: 'variable', detail: '当前文件变量', boost: 55 })
  }
  for (const keyword of [...(LANGUAGE_KEYWORDS[language] ?? []), ...COMMON_KEYWORDS]) {
    add({ label: keyword, type: 'keyword', detail: `${language} 关键字`, boost: 20 })
  }
  for (const match of documentText.matchAll(IDENTIFIER_PATTERN)) {
    const label = match[0]
    if (label.length > 1) add({ label, type: 'property', detail: '当前文件标识符', boost: 5 })
    if (options.length >= 250) break
  }
  return options
}

export function normalizeInlineCompletion(value: string): string | null {
  const completion = value
    .replace(/\r\n?/gu, '\n')
    .replace(/^```[^\n]*\n?/u, '')
    .replace(/\n?```$/u, '')
    .slice(0, MAX_INLINE_COMPLETION_CHARS)
  return completion.trim() ? completion : null
}

function stripEchoedPrefix(value: string, prefix: string): string {
  const currentLine = prefix.slice(prefix.lastIndexOf('\n') + 1)
  const candidates = [prefix, currentLine]
    .filter((candidate, index, values) => candidate.trim().length >= 4 && values.indexOf(candidate) === index)

  for (const candidate of candidates) {
    if (value.startsWith(candidate)) return value.slice(candidate.length)
    if (value.length < candidate.length && candidate.startsWith(value)) return ''
  }
  return value
}

function stripSuffixOverlap(value: string, suffix: string): string {
  const maximum = Math.min(value.length, suffix.length)
  for (let length = maximum; length > 0; length -= 1) {
    if (value.endsWith(suffix.slice(0, length))) return value.slice(0, -length)
  }
  return value
}

/**
 * Keeps AI output insertion-only even when a provider repeats the prompt
 * context around the cursor. This is applied to both streamed and final text.
 */
export function normalizeInlineCompletionForInsertion(value: string, prefix: string, suffix: string): string | null {
  const normalized = normalizeInlineCompletion(value)
  if (!normalized) return null
  const withoutPrefix = stripEchoedPrefix(normalized, prefix)
  const withoutSuffix = stripSuffixOverlap(withoutPrefix, suffix)
  return withoutSuffix.trim() ? withoutSuffix : null
}

export function normalizeInlineCompletionFragment(value: string, prefix = '', suffix = ''): string | null {
  const normalized = value.replace(/\r\n?/gu, '\n').slice(0, MAX_INLINE_COMPLETION_CHARS)
  if (/^```[^\n]*$/u.test(normalized)) return null
  return normalizeInlineCompletionForInsertion(normalized, prefix, suffix)
}

export function completionSnapshotMatches(
  documentText: string,
  cursor: number,
  expectedDocumentText: string,
  expectedCursor: number
): boolean {
  return documentText === expectedDocumentText && cursor === expectedCursor
}
