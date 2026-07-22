import { SyntaxCodeBlock } from '../viewers/SyntaxCodeBlock'

interface AiCodeBlockProps {
  code: string
  language?: string
}

export function AiCodeBlock({ code, language }: AiCodeBlockProps): React.JSX.Element {
  return (
    <SyntaxCodeBlock
      code={code}
      language={language}
      autoDetect
      className="ai-code-block"
    />
  )
}
