import { describe, expect, it } from 'vitest'

import {
  AUTO_COMPLETION_DELAY_MS,
  canRequestAutoCompletion,
  completionSnapshotMatches,
  normalizeInlineCompletion
} from '../../src/lib/ai-code-completion'

describe('automatic AI code completion', () => {
  it('waits for meaningful code at an empty cursor before requesting a suggestion', () => {
    expect(AUTO_COMPLETION_DELAY_MS).toBeGreaterThanOrEqual(250)
    expect(canRequestAutoCompletion('x', 1, true)).toBe(false)
    expect(canRequestAutoCompletion('result = ', 9, true)).toBe(true)
    expect(canRequestAutoCompletion('result = ', 9, false)).toBe(false)
    expect(canRequestAutoCompletion('result = ', 99, true)).toBe(false)
  })

  it('keeps code whitespace while dropping empty and fenced provider responses', () => {
    expect(normalizeInlineCompletion('  return value\n')).toBe('  return value\n')
    expect(normalizeInlineCompletion('```python\nreturn value\n```')).toBe('return value')
    expect(normalizeInlineCompletion(' \n\t')).toBeNull()
  })

  it('rejects a completion response when typing or cursor movement changed its snapshot', () => {
    expect(completionSnapshotMatches('message = ', 10, 'message = ', 10)).toBe(true)
    expect(completionSnapshotMatches('message = f', 11, 'message = ', 10)).toBe(false)
    expect(completionSnapshotMatches('message = ', 9, 'message = ', 10)).toBe(false)
  })
})
