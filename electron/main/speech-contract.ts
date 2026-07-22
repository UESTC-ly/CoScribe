export const SPEECH_MODEL_ID = 'sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16'
export const SPEECH_MODEL_FILES = {
  encoder: 'encoder-epoch-99-avg-1.int8.onnx',
  decoder: 'decoder-epoch-99-avg-1.onnx',
  joiner: 'joiner-epoch-99-avg-1.int8.onnx',
  tokens: 'tokens.txt'
} as const

export interface SpeechWorkerInitMessage {
  type: 'init'
  requestId: string
  sampleRate: number
  modelDirectory: string
}

export interface SpeechWorkerAudioMessage {
  type: 'audio'
  requestId: string
  samples: Float32Array
}

export interface SpeechWorkerStopMessage {
  type: 'stop'
  requestId: string
}

export type SpeechWorkerInputMessage = SpeechWorkerInitMessage | SpeechWorkerAudioMessage | SpeechWorkerStopMessage

export type SpeechWorkerOutputMessage =
  | { type: 'ready'; requestId: string }
  | { type: 'transcript'; requestId: string; text: string; final: boolean }
  | { type: 'error'; requestId: string; message: string }

export function validSpeechRequestId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._:-]{0,99}$/iu.test(value)
}

export function normalizedSpeechSamples(value: unknown): Float32Array | null {
  const source = value instanceof Float32Array
    ? value
    : value instanceof ArrayBuffer
      ? new Float32Array(value)
      : null
  if (!source || source.length === 0 || source.length > 96_000) return null
  const result = new Float32Array(source.length)
  for (let index = 0; index < source.length; index += 1) {
    const sample = source[index]
    result[index] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0
  }
  return result
}

export function joinSpeechSegments(segments: readonly string[], partial = ''): string {
  return [...segments, partial]
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join(' ')
}
