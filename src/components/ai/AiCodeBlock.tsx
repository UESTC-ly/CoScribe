import { lazy, Suspense } from 'react'

const SyntaxCodeBlock = lazy(async () => {
  const module = await import('../viewers/SyntaxCodeBlock')
  return { default: module.SyntaxCodeBlock }
})

interface AiCodeBlockProps {
  code: string
  language?: string
}

export function AiCodeBlock({ code, language }: AiCodeBlockProps): React.JSX.Element {
  return (
    <Suspense fallback={(
      <section className="vk-code-block ai-code-block" aria-label={`${language?.trim() || '纯文本'} 代码块`}>
        <header className="vk-code-block__header"><span>{language?.trim() || '纯文本'}</span></header>
        <pre><code>{code}</code></pre>
      </section>
    )}>
      <SyntaxCodeBlock
        code={code}
        language={language}
        autoDetect
        className="ai-code-block"
      />
    </Suspense>
  )
}
