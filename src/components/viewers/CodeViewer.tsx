import { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { langs } from '@uiw/codemirror-extensions-langs'
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view'
import { Check, Code2, Save, Sparkles } from 'lucide-react'

import { codeFileExtension, codeLanguageForPath } from '../../shared/code-files'
import {
  AUTO_COMPLETION_DELAY_MS,
  canRequestAutoCompletion,
  completionSnapshotMatches,
  normalizeInlineCompletion
} from '../../lib/ai-code-completion'

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

interface InlineCompletion {
  anchor: number
  text: string
}

const setInlineCompletion = StateEffect.define<InlineCompletion | null>()

class InlineCompletionWidget extends WidgetType {
  constructor(private readonly text: string) {
    super()
  }

  eq(other: InlineCompletionWidget): boolean {
    return other.text === this.text
  }

  toDOM(): HTMLElement {
    const element = document.createElement('span')
    element.className = 'cm-ai-inline-completion'
    element.textContent = this.text
    element.setAttribute('aria-hidden', 'true')
    return element
  }

  ignoreEvent(): boolean {
    return true
  }
}

const inlineCompletionField = StateField.define<InlineCompletion | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setInlineCompletion)) return effect.value
    }
    if (
      !value ||
      transaction.docChanged ||
      transaction.selection ||
      !transaction.state.selection.main.empty ||
      transaction.state.selection.main.head !== value.anchor
    ) return null
    return value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => {
    if (!value) return Decoration.none
    return Decoration.set([
      Decoration.widget({
        widget: new InlineCompletionWidget(value.text),
        side: 1
      }).range(value.anchor)
    ])
  })
})

function acceptInlineCompletion(view: EditorView): boolean {
  const suggestion = view.state.field(inlineCompletionField, false)
  if (
    !suggestion ||
    !view.state.selection.main.empty ||
    view.state.selection.main.head !== suggestion.anchor
  ) return false
  view.dispatch({
    changes: { from: suggestion.anchor, insert: suggestion.text },
    selection: { anchor: suggestion.anchor + suggestion.text.length },
    effects: setInlineCompletion.of(null),
    scrollIntoView: true
  })
  return true
}

const inlineCompletionExtension: Extension = [
  inlineCompletionField,
  Prec.high(keymap.of([{ key: 'Tab', run: acceptInlineCompletion }]))
]

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
  const completionTimerRef = useRef<number | null>(null)
  const completionGenerationRef = useRef(0)
  const [saving, setSaving] = useState(false)
  const [completionStatus, setCompletionStatus] = useState<'idle' | 'waiting' | 'requesting' | 'ready'>('idle')
  const language = codeLanguageForPath(path)
  const extensions = useMemo<Extension[]>(() => [...languageExtension(path), inlineCompletionExtension], [path])

  useEffect(() => {
    const view = viewRef.current
    if (view?.state.field(inlineCompletionField, false)) {
      view.dispatch({ effects: setInlineCompletion.of(null) })
    }
    setCompletionStatus('idle')
    return () => {
      completionGenerationRef.current += 1
      if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current)
      completionTimerRef.current = null
    }
  }, [path, aiCompletionEnabled])

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

  const scheduleAutoCompletion = (view: EditorView): void => {
    completionGenerationRef.current += 1
    const generation = completionGenerationRef.current
    if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current)
    completionTimerRef.current = null

    const selection = view.state.selection.main
    const documentText = view.state.doc.toString()
    const cursor = selection.head
    if (!aiCompletionEnabled || !canRequestAutoCompletion(documentText, cursor, selection.empty)) {
      setCompletionStatus('idle')
      return
    }

    setCompletionStatus('waiting')
    completionTimerRef.current = window.setTimeout(() => {
      completionTimerRef.current = null
      const currentView = viewRef.current
      if (!currentView || generation !== completionGenerationRef.current) return
      if (!completionSnapshotMatches(
        currentView.state.doc.toString(),
        currentView.state.selection.main.head,
        documentText,
        cursor
      )) return

      setCompletionStatus('requesting')
      void window.coscribe.ai.completeCode({
        requestId: crypto.randomUUID(),
        path,
        language,
        prefix: documentText.slice(Math.max(0, cursor - 120_000), cursor),
        suffix: documentText.slice(cursor, cursor + 60_000)
      }).then((result) => {
        const latestView = viewRef.current
        if (!latestView || generation !== completionGenerationRef.current) return
        if (!completionSnapshotMatches(
          latestView.state.doc.toString(),
          latestView.state.selection.main.head,
          documentText,
          cursor
        )) return
        const completion = normalizeInlineCompletion(result.completion)
        if (!completion) {
          setCompletionStatus('idle')
          return
        }
        latestView.dispatch({
          effects: setInlineCompletion.of({ anchor: cursor, text: completion })
        })
        setCompletionStatus('ready')
      }).catch(() => {
        if (generation === completionGenerationRef.current) setCompletionStatus('idle')
      })
    }, AUTO_COMPLETION_DELAY_MS)
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
      }}
    >
      <header className="code-viewer__toolbar">
        <span><Code2 size={14} /><strong>{language}</strong><small>{path}</small></span>
        <div>
          <span
            className={`code-viewer__completion-status is-${completionStatus}`}
            title={!aiCompletionEnabled
              ? 'AI 代码补全已在设置中关闭'
              : completionStatus === 'ready'
                ? '按 Tab 接受建议；继续输入会刷新建议'
                : '输入停顿后自动生成代码补全建议'}
          >
            <Sparkles size={13} />
            {!aiCompletionEnabled
              ? 'AI 自动补全已关闭'
              : completionStatus === 'requesting'
                ? '正在生成建议…'
                : completionStatus === 'ready'
                  ? '按 Tab 接受'
                  : 'AI 自动补全'}
          </span>
          <button type="button" className="primary-button" disabled={!dirty || saving} onClick={() => void save()}>
            {dirty ? <Save size={13} /> : <Check size={13} />}{saving ? '保存中…' : dirty ? '保存' : '已保存'}
          </button>
        </div>
      </header>
      <span className="sr-only" aria-live="polite">
        {completionStatus === 'ready' ? 'AI 代码补全建议已就绪，按 Tab 接受，继续输入会刷新建议。' : ''}
      </span>
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
        onChange={onChange}
        onUpdate={(update) => {
          viewRef.current = update.view
          if (update.docChanged) scheduleAutoCompletion(update.view)
          else if (update.selectionSet) {
            completionGenerationRef.current += 1
            if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current)
            completionTimerRef.current = null
            setCompletionStatus('idle')
          }
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
