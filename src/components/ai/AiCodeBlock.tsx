import { useEffect, useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
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
  go,
  java,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml
}

for (const [name, language] of Object.entries(registeredLanguages)) {
  if (!hljs.getLanguage(name)) hljs.registerLanguage(name, language)
}

const languageAliases: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  dockerfile: 'bash',
  htm: 'xml',
  html: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  md: 'markdown',
  py: 'python',
  rb: 'ruby',
  sh: 'bash',
  shell: 'bash',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  zsh: 'bash'
}

const languageLabels: Record<string, string> = {
  bash: 'Shell',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  java: 'Java',
  javascript: 'JavaScript',
  json: 'JSON',
  markdown: 'Markdown',
  python: 'Python',
  rust: 'Rust',
  sql: 'SQL',
  typescript: 'TypeScript',
  xml: 'HTML / XML',
  yaml: 'YAML'
}

function normalizedLanguage(language?: string): string | undefined {
  const clean = language?.trim().toLowerCase()
  if (!clean) return undefined
  return languageAliases[clean] ?? clean
}

function displayLanguage(language?: string): string {
  const normalized = normalizedLanguage(language)
  if (!normalized) return '纯文本'
  return languageLabels[normalized] ?? language?.trim() ?? normalized
}

interface AiCodeBlockProps {
  code: string
  language?: string
}

export function AiCodeBlock({ code, language }: AiCodeBlockProps): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const normalized = normalizedLanguage(language)
  const label = displayLanguage(language)
  const highlighted = useMemo(() => {
    if (!normalized || !hljs.getLanguage(normalized)) return null
    return hljs.highlight(code, { language: normalized, ignoreIllegals: true }).value
  }, [code, normalized])

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
    <section className="ai-code-block" aria-label={`${label} 代码块`}>
      <header className="ai-code-block__header">
        <span>{label}</span>
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
        {highlighted === null ? (
          <code>{code}</code>
        ) : (
          <code
            className={`hljs language-${normalized}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        )}
      </pre>
    </section>
  )
}
