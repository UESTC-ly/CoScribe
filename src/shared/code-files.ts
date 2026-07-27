export const CODE_FILE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cxx',
  'h',
  'hh',
  'hpp',
  'hxx',
  'cs',
  'css',
  'go',
  'graphql',
  'gql',
  'hbs',
  'html',
  'htm',
  'java',
  'js',
  'jsx',
  'kt',
  'kts',
  'lua',
  'm',
  'mm',
  'php',
  'pl',
  'py',
  'rb',
  'rs',
  'scala',
  'scss',
  'sh',
  'bash',
  'zsh',
  'sql',
  'svelte',
  'swift',
  'tsx',
  'ts',
  'vue',
  'xml'
])

export const CODE_FILE_NAMES = new Set([
  'CMakeLists.txt',
  'Containerfile',
  'Dockerfile',
  'Gemfile',
  'Justfile',
  'Makefile',
  'Procfile',
  'Rakefile'
])

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: 'C',
  cc: 'C++',
  cpp: 'C++',
  cxx: 'C++',
  h: 'C/C++',
  hh: 'C++',
  hpp: 'C++',
  hxx: 'C++',
  cs: 'C#',
  css: 'CSS',
  go: 'Go',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  hbs: 'Handlebars',
  html: 'HTML',
  htm: 'HTML',
  java: 'Java',
  js: 'JavaScript',
  jsx: 'JavaScript JSX',
  kt: 'Kotlin',
  kts: 'Kotlin',
  lua: 'Lua',
  m: 'Objective-C',
  mm: 'Objective-C++',
  php: 'PHP',
  pl: 'Perl',
  py: 'Python',
  rb: 'Ruby',
  rs: 'Rust',
  scala: 'Scala',
  scss: 'SCSS',
  sh: 'Shell',
  bash: 'Shell',
  zsh: 'Shell',
  sql: 'SQL',
  svelte: 'Svelte',
  swift: 'Swift',
  tsx: 'TypeScript JSX',
  ts: 'TypeScript',
  vue: 'Vue',
  xml: 'XML'
}

function fileName(filePath: string): string {
  return filePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? filePath
}

export function codeFileExtension(filePath: string): string {
  const name = fileName(filePath)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLocaleLowerCase() : ''
}

export function isCodeFilePath(filePath: string): boolean {
  const name = fileName(filePath)
  return CODE_FILE_NAMES.has(name) || CODE_FILE_EXTENSIONS.has(codeFileExtension(name))
}

export function codeLanguageForPath(filePath: string): string {
  const name = fileName(filePath)
  if (name === 'Dockerfile' || name === 'Containerfile') return 'Dockerfile'
  if (name === 'Makefile' || name === 'CMakeLists.txt') return 'Makefile'
  return LANGUAGE_BY_EXTENSION[codeFileExtension(name)] ?? 'Plain Text'
}
