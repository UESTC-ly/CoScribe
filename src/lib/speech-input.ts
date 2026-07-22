export const SPEECH_AUDIO_CHUNK_SAMPLES = 3_200

export function composeSpeechDraft(prefix: string, transcript: string): string {
  const live = transcript.trim()
  if (!live) return prefix
  if (!prefix) return live
  return `${prefix}${/\s$/u.test(prefix) ? '' : '\n'}${live}`
}

export class SpeechChunkAccumulator {
  private pending = new Float32Array(0)

  constructor(
    private readonly chunkSamples: number,
    private readonly onChunk: (chunk: Float32Array) => void
  ) {
    if (!Number.isInteger(chunkSamples) || chunkSamples < 1) throw new Error('音频分片大小无效。')
  }

  push(input: Float32Array): void {
    if (!input.length) return
    const combined = new Float32Array(this.pending.length + input.length)
    combined.set(this.pending)
    combined.set(input, this.pending.length)
    let offset = 0
    while (combined.length - offset >= this.chunkSamples) {
      this.onChunk(combined.slice(offset, offset + this.chunkSamples))
      offset += this.chunkSamples
    }
    this.pending = combined.slice(offset)
  }

  flush(): void {
    if (this.pending.length) this.onChunk(this.pending.slice())
    this.pending = new Float32Array(0)
  }
}
