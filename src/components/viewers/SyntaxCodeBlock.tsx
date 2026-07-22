import { useEffect, useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import markdown from 'highlight.js/lib/languages/markdown'
import objectivec from 'highlight.js/lib/languages/objectivec'
import php from 'highlight.js/lib/languages/php'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const registeredLanguages = {
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  objectivec,
  php,
  powershell,
  python,
  ruby,
  rust,
  sql,
  swift,
  typescript,
  xml,
  yaml,
}

for (const [name, definition] of Object.entries(registeredLanguages)) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, definition)
}

const autoDetectLanguages = Object.keys(registeredLanguages)

const languageAliases: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  env: 'ini',
  htm: 'xml',
  html: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  kt: 'kotlin',
  md: 'markdown',
  'objective-c': 'objectivec',
  objc: 'objectivec',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
}

const languageLabels: Record<string, string> = {
  bash: 'Shell',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  dockerfile: 'Dockerfile',
  go: 'Go',
  ini: 'INI',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  kotlin: 'Kotlin',
  markdown: 'Markdown',
  objectivec: 'Objective-C',
  php: 'PHP',
  powershell: 'PowerShell',
  python: 'Python',
  ruby: 'Ruby',
  rust: 'Rust',
  sql: 'SQL',
  swift: 'Swift',
  typescript: 'TypeScript',
  xml: 'HTML / XML',
  yaml: 'YAML',
}

interface HighlightResult {
  html: string | null
  language?: string
  label: string
}

function normalizeLanguage(language?: string): string | undefined {
  const clean = language?.trim().toLowerCase()
  if (!clean) return undefined
  return languageAliases[clean] ?? clean
}

function languageLabel(language: string): string {
  return languageLabels[language] ?? language
}

function highlightCode(code: string, language: string | undefined, autoDetect: boolean): HighlightResult {
  const normalized = normalizeLanguage(language)
  if (normalized) {
    if (!hljs.getLanguage(normalized)) {
      return { html: null, label: language?.trim() || normalized }
    }
    return {
      html: hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value,
      language: normalized,
      label: languageLabel(normalized),
    }
  }

  if (autoDetect && code.trim()) {
    const detected = hljs.highlightAuto(code, autoDetectLanguages)
    if (detected.language && detected.relevance > 0) {
      return {
        html: detected.value,
        language: detected.language,
        label: `${languageLabel(detected.language)} · 自动识别`,
      }
    }
  }

  return { html: null, label: '纯文本' }
}

export interface SyntaxCodeBlockProps {
  code: string
  language?: string
  autoDetect?: boolean
  className?: string
}

export function SyntaxCodeBlock({
  code,
  language,
  autoDetect = false,
  className,
}: SyntaxCodeBlockProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const highlighted = useMemo(
    () => highlightCode(code, language, autoDetect),
    [autoDetect, code, language],
  )

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timeout)
  }, [copied])

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section
      className={['vk-code-block', className].filter(Boolean).join(' ')}
      aria-label={`${highlighted.label} 代码块`}
    >
      <header className="vk-code-block__header">
        <span title={highlighted.label}>{highlighted.label}</span>
        <button
          type="button"
          onClick={() => void copy()}
          title={copied ? '已复制' : '复制代码'}
          aria-label={copied ? '代码已复制' : '复制代码'}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </header>
      <pre>
        {highlighted.html === null ? (
          <code>{code}</code>
        ) : (
          <code
            className={`hljs language-${highlighted.language}`}
            dangerouslySetInnerHTML={{ __html: highlighted.html }}
          />
        )}
      </pre>
    </section>
  )
}
