import { describe, expect, it } from 'vitest'

import { joinSpeechSegments, normalizedSpeechSamples, validSpeechRequestId } from './speech-contract'

describe('local speech IPC boundary', () => {
  it('accepts bounded request IDs and rejects control characters', () => {
    expect(validSpeechRequestId('speech-123:abc')).toBe(true)
    expect(validSpeechRequestId('../speech')).toBe(false)
    expect(validSpeechRequestId('speech\nforged')).toBe(false)
  })

  it('copies, clamps, and repairs samples before they reach the native recognizer', () => {
    const input = new Float32Array([-2, -0.5, Number.NaN, 0.5, 4])
    expect([...normalizedSpeechSamples(input)!]).toEqual([-1, -0.5, 0, 0.5, 1])
    expect(normalizedSpeechSamples(new Float32Array())).toBeNull()
    expect(normalizedSpeechSamples(new Float32Array(96_001))).toBeNull()
  })

  it('keeps endpoint-confirmed text while replacing only the live partial segment', () => {
    expect(joinSpeechSegments(['第一句', 'second sentence'], '正在识别')).toBe('第一句 second sentence 正在识别')
  })
})
