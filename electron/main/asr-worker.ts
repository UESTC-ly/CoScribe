import path from 'node:path'

import { OnlineRecognizer, type OnlineStream } from 'sherpa-onnx-node'

import {
  joinSpeechSegments,
  normalizedSpeechSamples,
  SPEECH_MODEL_FILES,
  type SpeechWorkerInputMessage,
  type SpeechWorkerOutputMessage,
  validSpeechRequestId
} from './speech-contract'

const parentPort = process.parentPort
if (!parentPort) throw new Error('本地语音识别进程缺少父进程通信端口。')

let requestId = ''
let sampleRate = 16_000
let recognizer: OnlineRecognizer | null = null
let stream: OnlineStream | null = null
const committed: string[] = []

function post(message: SpeechWorkerOutputMessage): void {
  parentPort.postMessage(message)
}

function fail(reason: unknown): void {
  const message = reason instanceof Error ? reason.message : String(reason)
  post({ type: 'error', requestId, message: `本地语音识别失败：${message}` })
}

function decodeReady(): void {
  if (!recognizer || !stream) return
  while (recognizer.isReady(stream)) recognizer.decode(stream)
}

function currentText(): string {
  if (!recognizer || !stream) return joinSpeechSegments(committed)
  return joinSpeechSegments(committed, recognizer.getResult(stream).text ?? '')
}

function accept(samples: Float32Array): void {
  if (!recognizer || !stream) throw new Error('语音模型尚未初始化。')
  stream.acceptWaveform({ samples, sampleRate })
  decodeReady()
  const partial = recognizer.getResult(stream).text?.trim() ?? ''
  post({ type: 'transcript', requestId, text: joinSpeechSegments(committed, partial), final: false })
  if (recognizer.isEndpoint(stream)) {
    if (partial) committed.push(partial)
    recognizer.reset(stream)
    post({ type: 'transcript', requestId, text: joinSpeechSegments(committed), final: false })
  }
}

function finish(): void {
  if (!recognizer || !stream) return
  // Streaming transducers need a short tail of silence to emit the final
  // tokens that are still buffered in the encoder. `inputFinished()` alone
  // does not flush this family of Zipformer models.
  stream.acceptWaveform({ samples: new Float32Array(Math.round(sampleRate * 0.5)), sampleRate })
  stream.inputFinished()
  decodeReady()
  const partial = recognizer.getResult(stream).text?.trim() ?? ''
  if (partial) committed.push(partial)
  post({ type: 'transcript', requestId, text: joinSpeechSegments(committed), final: true })
  setTimeout(() => process.exit(0), 20)
}

function initialize(message: Extract<SpeechWorkerInputMessage, { type: 'init' }>): void {
  if (recognizer) throw new Error('语音模型已经初始化。')
  if (!validSpeechRequestId(message.requestId)) throw new Error('语音请求 ID 无效。')
  if (!Number.isFinite(message.sampleRate) || message.sampleRate < 8_000 || message.sampleRate > 96_000) {
    throw new Error('麦克风采样率无效。')
  }
  requestId = message.requestId
  sampleRate = Math.round(message.sampleRate)
  const model = (name: keyof typeof SPEECH_MODEL_FILES): string => path.join(message.modelDirectory, SPEECH_MODEL_FILES[name])
  recognizer = new OnlineRecognizer({
    featConfig: { sampleRate: 16_000, featureDim: 80 },
    modelConfig: {
      transducer: { encoder: model('encoder'), decoder: model('decoder'), joiner: model('joiner') },
      tokens: model('tokens'),
      numThreads: 2,
      debug: false,
      provider: 'cpu'
    },
    decodingMethod: 'greedy_search',
    maxActivePaths: 4,
    enableEndpoint: true,
    rule1MinTrailingSilence: 2.4,
    rule2MinTrailingSilence: 1.0,
    rule3MinUtteranceLength: 20
  })
  stream = recognizer.createStream()
  post({ type: 'ready', requestId })
}

parentPort.on('message', (event) => {
  const message = event.data as SpeechWorkerInputMessage
  try {
    if (!message || typeof message !== 'object') throw new Error('语音进程收到无效消息。')
    if (message.type === 'init') initialize(message)
    else if (message.requestId !== requestId) throw new Error('语音请求已经失效。')
    else if (message.type === 'audio') {
      const samples = normalizedSpeechSamples(message.samples)
      if (!samples) throw new Error('音频分片无效。')
      accept(samples)
    } else if (message.type === 'stop') finish()
  } catch (error) {
    fail(error)
    setTimeout(() => process.exit(1), 20)
  }
})
