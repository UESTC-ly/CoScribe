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

function declarationType(kind: string): LocalCodeCompletionOption['type'] {
  if (kind === 'class' || kind === 'struct') return 'class'
  if (kind === 'interface' || kind === 'trait' || kind === 'type' || kind === 'enum') return 'type'
  return 'function'
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
