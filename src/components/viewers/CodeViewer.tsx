import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { langs } from '@uiw/codemirror-extensions-langs'
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionKeymap,
  type CompletionContext
} from '@codemirror/autocomplete'
import { Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, keymap, WidgetType } from '@codemirror/view'
import { Check, Code2, Save, Sparkles } from 'lucide-react'

import { codeFileExtension, codeLanguageForPath } from '../../shared/code-files'
import {
  AUTO_COMPLETION_DELAY_MS,
  buildAiCompletionContext,
  canRequestAutoCompletion,
  completionSnapshotMatches,
  localCodeCompletionOptions,
  normalizeInlineCompletionForInsertion,
  normalizeInlineCompletionFragment
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
  autoSave: boolean
  autoSaveDelayMs: number
  onChange: (content: string) => void
  onSave: (content: string, expectedModifiedAt: number) => Promise<void>
  onContextChange: (context: CodeViewerContext) => void
  onError: (message: string) => void
}

interface InlineCompletion {
  anchor: number
  text: string
}

interface ActiveCompletionRequest {
  requestId: string
  documentText: string
  cursor: number
  generation: number
  streamedCompletion: string
  prefix: string
  suffix: string
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
  Prec.high(keymap.of([{ key: 'Tab', run: acceptInlineCompletion }])),
  keymap.of([{ key: 'Tab', run: acceptCompletion }, ...completionKeymap])
]

function localCompletionExtension(language: string): Extension {
  return autocompletion({
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
  })
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
  aiCompletionEnabled,
  autoSave,
  autoSaveDelayMs,
  onChange,
  onSave,
  onContextChange,
  onError
}: CodeViewerProps): React.JSX.Element {
  const viewRef = useRef<EditorView | null>(null)
  const completionTimerRef = useRef<number | null>(null)
  const completionGenerationRef = useRef(0)
  const activeCompletionRef = useRef<ActiveCompletionRequest | null>(null)
  const [saving, setSaving] = useState(false)
  const [completionStatus, setCompletionStatus] = useState<'idle' | 'waiting' | 'requesting' | 'ready'>('idle')
  const language = codeLanguageForPath(path)
  const codeMirrorTheme = useCodeMirrorTheme()
  const extensions = useMemo<Extension[]>(
    () => [...languageExtension(path), inlineCompletionExtension, localCompletionExtension(language)],
    [language, path]
  )

  const invalidateAutoCompletion = (view = viewRef.current): void => {
    completionGenerationRef.current += 1
    if (completionTimerRef.current !== null) window.clearTimeout(completionTimerRef.current)
    completionTimerRef.current = null
    const active = activeCompletionRef.current
    activeCompletionRef.current = null
    if (active) void window.coscribe.ai.cancelCodeCompletion(active.requestId).catch(() => undefined)
    if (view?.state.field(inlineCompletionField, false)) {
      view.dispatch({ effects: setInlineCompletion.of(null) })
    }
    setCompletionStatus('idle')
  }

  useEffect(() => {
    invalidateAutoCompletion()
    return () => {
      invalidateAutoCompletion()
    }
  }, [path, aiCompletionEnabled])

  useEffect(() => window.coscribe.ai.onCodeCompletionStream((event) => {
    const active = activeCompletionRef.current
    if (!active || event.requestId !== active.requestId) return
    const view = viewRef.current
    if (
      !view ||
      active.generation !== completionGenerationRef.current ||
      !completionSnapshotMatches(view.state.doc.toString(), view.state.selection.main.head, active.documentText, active.cursor)
    ) {
      invalidateAutoCompletion(view)
      return
    }
    if (event.type === 'delta') {
      active.streamedCompletion += event.text
      const completion = normalizeInlineCompletionFragment(
        active.streamedCompletion,
        active.prefix,
        active.suffix
      )
      if (!completion) return
      closeCompletion(view)
      view.dispatch({ effects: setInlineCompletion.of({ anchor: active.cursor, text: completion }) })
      setCompletionStatus('ready')
      return
    }
    if (event.type === 'error') {
      activeCompletionRef.current = null
      setCompletionStatus('idle')
      onError(event.message)
    }
  }), [onError])

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

  const scheduleAutoCompletion = (view: EditorView): void => {
    invalidateAutoCompletion(view)
    const generation = completionGenerationRef.current

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
      const requestId = crypto.randomUUID()
      const context = buildAiCompletionContext(documentText, cursor)
      activeCompletionRef.current = {
        requestId,
        documentText,
        cursor,
        generation,
        streamedCompletion: '',
        prefix: context.prefix,
        suffix: context.suffix
      }
      void window.coscribe.ai.completeCode({
        requestId,
        path,
        language,
        ...context
      }).then((result) => {
        const latestView = viewRef.current
        const active = activeCompletionRef.current
        if (!latestView || !active || active.requestId !== result.requestId || generation !== completionGenerationRef.current) return
        if (!completionSnapshotMatches(
          latestView.state.doc.toString(),
          latestView.state.selection.main.head,
          documentText,
          cursor
        )) return
        const completion = normalizeInlineCompletionForInsertion(
          result.completion,
          active.prefix,
          active.suffix
        )
        if (!completion) {
          activeCompletionRef.current = null
          setCompletionStatus('idle')
          return
        }
        if (
          normalizeInlineCompletionForInsertion(
            active.streamedCompletion,
            active.prefix,
            active.suffix
          ) !== completion
        ) {
          closeCompletion(latestView)
          latestView.dispatch({
            effects: setInlineCompletion.of({ anchor: cursor, text: completion })
          })
        }
        activeCompletionRef.current = null
        setCompletionStatus('ready')
      }).catch((reason: unknown) => {
        const active = activeCompletionRef.current
        if (!active || active.requestId !== requestId) return
        activeCompletionRef.current = null
        if (generation === completionGenerationRef.current) {
          setCompletionStatus('idle')
          const message = reason instanceof Error ? reason.message : String(reason)
          if (message !== 'AI 代码补全已取消。') onError(message)
        }
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
                : autoSave && dirty
                  ? `本地补全即时显示；代码将在停止输入后约 ${autoSaveDelayMs} ms 自动保存`
                  : '本地补全即时显示；输入停顿后自动生成 AI 内联建议'}
          >
            <Sparkles size={13} />
            {!aiCompletionEnabled
              ? 'AI 自动补全已关闭'
              : completionStatus === 'requesting'
                ? '正在生成建议…'
                : completionStatus === 'ready'
                  ? '按 Tab 接受'
                  : autoSave && dirty
                    ? '等待自动保存'
                    : '本地补全 + AI'}
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
        theme={codeMirrorTheme}
        onChange={onChange}
        onUpdate={(update) => {
          viewRef.current = update.view
          if (update.docChanged) scheduleAutoCompletion(update.view)
          else if (update.selectionSet) {
            invalidateAutoCompletion(update.view)
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
