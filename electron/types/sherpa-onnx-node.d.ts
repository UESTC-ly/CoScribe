declare module 'sherpa-onnx-node' {
  export interface OnlineStream {
    acceptWaveform(value: { samples: Float32Array; sampleRate: number }): void
    inputFinished(): void
  }

  export interface OnlineRecognizerResult {
    text?: string
  }

  export class OnlineRecognizer {
    constructor(config: Record<string, unknown>)
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    decode(stream: OnlineStream): void
    isEndpoint(stream: OnlineStream): boolean
    reset(stream: OnlineStream): void
    getResult(stream: OnlineStream): OnlineRecognizerResult
  }
}
