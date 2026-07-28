import { describe, expect, it } from 'vitest'

import {
  AUTO_COMPLETION_DELAY_MS,
  MAX_AI_COMPLETION_PREFIX_CHARS,
  MAX_AI_COMPLETION_SUFFIX_CHARS,
  buildAiCompletionContext,
  canRequestAutoCompletion,
  completionSnapshotMatches,
  localCodeCompletionOptions,
  normalizeInlineCompletion,
  normalizeInlineCompletionFragment
} from '../../src/lib/ai-code-completion'

describe('automatic AI code completion', () => {
  it('uses a short delay and requests after meaningful code at an empty cursor', () => {
    expect(AUTO_COMPLETION_DELAY_MS).toBeGreaterThanOrEqual(100)
    expect(AUTO_COMPLETION_DELAY_MS).toBeLessThanOrEqual(200)
    expect(canRequestAutoCompletion('x', 1, true)).toBe(true)
    expect(canRequestAutoCompletion('\n', 1, true)).toBe(false)
    expect(canRequestAutoCompletion('result = ', 9, true)).toBe(true)
    expect(canRequestAutoCompletion('result = ', 9, false)).toBe(false)
    expect(canRequestAutoCompletion('result = ', 99, true)).toBe(false)
  })

  it('keeps code whitespace while dropping empty and fenced provider responses', () => {
    expect(normalizeInlineCompletion('  return value\n')).toBe('  return value\n')
    expect(normalizeInlineCompletion('```python\nreturn value\n```')).toBe('return value')
    expect(normalizeInlineCompletionFragment('```python')).toBeNull()
    expect(normalizeInlineCompletionFragment('```python\nreturn value')).toBe('return value')
    expect(normalizeInlineCompletion(' \n\t')).toBeNull()
  })

  it('builds a bounded fill-in-the-middle context with imports and symbols', () => {
    const source = [
      'import { readFile } from "node:fs/promises"',
      '',
      'export function parseProject(input: string) {',
      '  const result = input.trim()',
      '  return result',
      '}',
      '',
      'export class ProjectIndex {}'
    ].join('\n')
    const cursor = source.indexOf('return result') + 'return '.length
    const context = buildAiCompletionContext(source, cursor)

    expect(context.prefix).toContain('function parseProject')
    expect(context.suffix).toContain('result')
    expect(context.context).toContain('readFile')
    expect(context.context).toContain('parseProject')
    expect(context.prefix.length).toBeLessThanOrEqual(MAX_AI_COMPLETION_PREFIX_CHARS)
    expect(context.suffix.length).toBeLessThanOrEqual(MAX_AI_COMPLETION_SUFFIX_CHARS)
  })

  it('provides immediate local keyword and file-symbol candidates', () => {
    const options = localCodeCompletionOptions('def calculate_total(items):\n  result = 0\n  return result\n', 'Python')
    expect(options).toContainEqual(expect.objectContaining({ label: 'calculate_total', type: 'function' }))
    expect(options).toContainEqual(expect.objectContaining({ label: 'result', type: 'variable' }))
    expect(options).toContainEqual(expect.objectContaining({ label: 'def', type: 'keyword' }))
  })

  it('rejects a completion response when typing or cursor movement changed its snapshot', () => {
    expect(completionSnapshotMatches('message = ', 10, 'message = ', 10)).toBe(true)
    expect(completionSnapshotMatches('message = f', 11, 'message = ', 10)).toBe(false)
    expect(completionSnapshotMatches('message = ', 9, 'message = ', 10)).toBe(false)
  })
})
