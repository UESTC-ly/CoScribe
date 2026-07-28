import { useCallback, useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { langs } from '@uiw/codemirror-extensions-langs'
import {
  acceptCompletion,
  autocompletion,
  completionKeymap,
  type CompletionContext
} from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'
import { keymap } from '@codemirror/view'
import { Check, Code2, Save } from 'lucide-react'

import { codeFileExtension, codeLanguageForPath } from '../../shared/code-files'
import { localCodeCompletionOptions } from '../../lib/local-code-completion'

interface CodeViewerContext {
  selection: string
  visibleText: string
  documentText: string
}

interface CodeViewerProps {
  path: string
  value: string
  modifiedAt: number
  dirty: boolean
  autoSave: boolean
  autoSaveDelayMs: number
  onChange: (content: string) => void
  onSave: (content: string, expectedModifiedAt: number) => Promise<void>
  onContextChange: (context: CodeViewerContext) => void
  onError: (message: string) => void
}

function localCompletionExtension(language: string): Extension {
  return [
    autocompletion({
      activateOnTyping: true,
      override: [(context: CompletionContext) => {
        const word = context.matchBefore(/[\p{L}_$][\p{L}\p{N}_$]*/u)
        if (!word && !context.explicit) return null
        return {
          from: word?.from ?? context.pos,
          options: localCodeCompletionOptions(context.state.doc.toString(), language),
          validFor: /[\p{L}\p{N}_$]*/u
        }
      }]
    }),
    keymap.of([{ key: 'Tab', run: acceptCompletion }, ...completionKeymap])
  ]
}

function languageExtension(path: string): ReturnType<(typeof langs)[keyof typeof langs]>[] {
  const name = path.split(/[\\/]/u).at(-1) ?? ''
  const extension = codeFileExtension(path)
  const key = name === 'Dockerfile' || name === 'Containerfile'
    ? 'sh'
    : name === 'CMakeLists.txt'
      ? 'cmake'
      : extension
  const factory = key && Object.prototype.hasOwnProperty.call(langs, key)
    ? langs[key as keyof typeof langs]
    : undefined
  return factory ? [factory()] : []
}

function currentCodeMirrorTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function useCodeMirrorTheme(): 'light' | 'dark' {
  const [theme, setTheme] = useState(currentCodeMirrorTheme)

  useEffect(() => {
    const root = document.documentElement
    const observer = new MutationObserver(() => setTheme(currentCodeMirrorTheme()))
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])

  return theme
}

export function CodeViewer({
  path,
  value,
  modifiedAt,
  dirty,
  autoSave,
  autoSaveDelayMs,
  onChange,
  onSave,
  onContextChange,
  onError
}: CodeViewerProps): React.JSX.Element {
  const [saving, setSaving] = useState(false)
  const language = codeLanguageForPath(path)
  const codeMirrorTheme = useCodeMirrorTheme()
  const extensions = useMemo<Extension[]>(
    () => [...languageExtension(path), localCompletionExtension(language)],
    [language, path]
  )

  const save = useCallback(async (): Promise<void> => {
    if (saving || !dirty) return
    setSaving(true)
    try {
      await onSave(value, modifiedAt)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '代码文件保存失败。')
    } finally {
      setSaving(false)
    }
  }, [dirty, modifiedAt, onError, onSave, saving, value])

  useEffect(() => {
    if (!autoSave || !dirty || saving) return
    const timeout = window.setTimeout(() => {
      void save()
    }, Math.max(250, autoSaveDelayMs))
    return () => window.clearTimeout(timeout)
  }, [autoSave, autoSaveDelayMs, dirty, save, saving, value])

  return (
    <section
      className="code-viewer"
      aria-label={`${language} 代码编辑器`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          void save()
        }
      }}
    >
      <header className="code-viewer__toolbar">
        <span><Code2 size={14} /><strong>{language}</strong><small>{path}</small></span>
        <div>
          <button type="button" className="primary-button" disabled={!dirty || saving} onClick={() => void save()}>
            {dirty ? <Save size={13} /> : <Check size={13} />}{saving ? '保存中…' : dirty ? '保存' : '已保存'}
          </button>
        </div>
      </header>
      <CodeMirror
        value={value}
        height="100%"
        extensions={extensions}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          foldGutter: true,
          autocompletion: false,
          bracketMatching: true,
          closeBrackets: true
        }}
        theme={codeMirrorTheme}
        onChange={onChange}
        onUpdate={(update) => {
          if (!update.docChanged && !update.selectionSet && !update.viewportChanged) return
          const selection = update.state.selection.main
          onContextChange({
            selection: selection.empty ? '' : update.state.doc.sliceString(selection.from, selection.to),
            visibleText: update.state.doc.sliceString(update.view.viewport.from, update.view.viewport.to),
            documentText: update.state.doc.toString()
          })
        }}
        onCreateEditor={(view) => {
          onContextChange({
            selection: '',
            visibleText: view.state.doc.sliceString(view.viewport.from, view.viewport.to),
            documentText: view.state.doc.toString()
          })
        }}
      />
    </section>
  )
}
