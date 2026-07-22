import { describe, expect, it, vi } from 'vitest'

import { composeSpeechDraft, SpeechChunkAccumulator } from '../../src/lib/speech-input'

describe('live speech composer', () => {
  it('keeps the pre-recording draft stable while replacing the live transcript', () => {
    expect(composeSpeechDraft('已有问题', '实时转写')).toBe('已有问题\n实时转写')
    expect(composeSpeechDraft('已有问题\n', '实时转写')).toBe('已有问题\n实时转写')
    expect(composeSpeechDraft('', '  实时转写  ')).toBe('实时转写')
  })

  it('emits fixed-size chunks and flushes only the remainder', () => {
    const onChunk = vi.fn()
    const accumulator = new SpeechChunkAccumulator(4, onChunk)
    accumulator.push(new Float32Array([1, 2, 3]))
    accumulator.push(new Float32Array([4, 5, 6, 7, 8, 9]))
    accumulator.flush()

    expect(onChunk.mock.calls.map(([chunk]) => [...chunk])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
      [9]
    ])
  })
})
