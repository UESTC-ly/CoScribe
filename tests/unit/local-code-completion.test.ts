import { describe, expect, it } from 'vitest'

import { localCodeCompletionOptions } from '../../src/lib/local-code-completion'

describe('local code completion', () => {
  it('provides immediate language keywords and current-file symbols without an AI request', () => {
    const options = localCodeCompletionOptions(
      'def calculate_total(items):\n  result = 0\n  return result\n',
      'Python'
    )

    expect(options).toContainEqual(expect.objectContaining({ label: 'calculate_total', type: 'function' }))
    expect(options).toContainEqual(expect.objectContaining({ label: 'result', type: 'variable' }))
    expect(options).toContainEqual(expect.objectContaining({ label: 'def', type: 'keyword' }))
    expect(options.filter(({ label }) => label === 'result')).toHaveLength(1)
  })
})
