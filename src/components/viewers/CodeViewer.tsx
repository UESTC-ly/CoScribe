import { useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { langs } from '@uiw/codemirror-extensions-langs'
import type { EditorView } from '@codemirror/view'
import { Check, Code2, Save, Sparkles } from 'lucide-react'

import { codeFileExtension, codeLanguageForPath } from '../../shared/code-files'

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
  aiCompletionEnabled: boolean
  onChange: (content: string) => void
  onSave: (content: string, expectedModifiedAt: number) => Promise<void>
  onContextChange: (context: CodeViewerContext) => void
  onError: (message: string) => void
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

export function CodeViewer({
  path,
  value,
  modifiedAt,
  dirty,
  aiCompletionEnabled,
  onChange,
  onSave,
  onContextChange,
  onError
}: CodeViewerProps): React.JSX.Element {
  const viewRef = useRef<EditorView | null>(null)
  const [saving, setSaving] = useState(false)
  const [completing, setCompleting] = useState(false)
  const language = codeLanguageForPath(path)
  const extensions = useMemo(() => languageExtension(path), [path])

  const save = async (): Promise<void> => {
    if (saving || !dirty) return
    setSaving(true)
    try {
      await onSave(value, modifiedAt)
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : '代码文件保存失败。')
    } finally {
      setSaving(false)
    }
  }

  const complete = async (): Promise<void> => {
    const view = viewRef.current
    if (!view || completing || !aiCompletionEnabled) return
    const cursor = view.state.selection.main.head
    setCompleting(true)
    try {
      const result = await window.coscribe.ai.completeCode({
        requestId: crypto.randomUUID(),
        path,
        language,
        prefix: view.state.doc.sliceString(0, cursor),
        suffix: view.state.doc.sliceString(cursor)
      })
      view.dispatch({
        changes: { from: cursor, insert: result.completion },
        selection: { anchor: cursor + result.completion.length },
        scrollIntoView: true
      })
      view.focus()
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : 'AI 代码补全失败。')
    } finally {
      setCompleting(false)
    }
  }

  return (
    <section
      className="code-viewer"
      aria-label={`${language} 代码编辑器`}
      onKeyDown={(event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
          event.preventDefault()
          void save()
        }
        if ((event.metaKey || event.ctrlKey) && event.key === ' ') {
          event.preventDefault()
          void complete()
        }
      }}
    >
      <header className="code-viewer__toolbar">
        <span><Code2 size={14} /><strong>{language}</strong><small>{path}</small></span>
        <div>
          <button
            type="button"
            className="secondary-button"
            disabled={!aiCompletionEnabled || completing}
            onClick={() => void complete()}
            title={aiCompletionEnabled ? '在光标处生成补全（Cmd/Ctrl+Space）' : 'AI 代码补全已在设置中关闭'}
          >
            <Sparkles size={13} />{completing ? '补全中…' : 'AI 补全'}
          </button>
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
          autocompletion: true,
          bracketMatching: true,
          closeBrackets: true
        }}
        onChange={onChange}
        onUpdate={(update) => {
          viewRef.current = update.view
          if (!update.docChanged && !update.selectionSet && !update.viewportChanged) return
          const selection = update.state.selection.main
          onContextChange({
            selection: selection.empty ? '' : update.state.doc.sliceString(selection.from, selection.to),
            visibleText: update.state.doc.sliceString(update.view.viewport.from, update.view.viewport.to),
            documentText: update.state.doc.toString()
          })
        }}
        onCreateEditor={(view) => {
          viewRef.current = view
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
