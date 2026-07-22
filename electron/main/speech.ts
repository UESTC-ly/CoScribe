import { createRequire } from 'node:module'
import { lstat, realpath } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { app, utilityProcess, type UtilityProcess, type WebContents } from 'electron'

import type { SpeechRecognitionEvent, SpeechRecognitionStatus } from '../../src/shared/types'
import { IPC } from '../ipc-channels'
import {
  normalizedSpeechSamples,
  SPEECH_MODEL_FILES,
  SPEECH_MODEL_ID,
  type SpeechWorkerOutputMessage,
  validSpeechRequestId
} from './speech-contract'

const require = createRequire(import.meta.url)
const currentDirectory = path.dirname(fileURLToPath(import.meta.url))
const EXPECTED_MODEL_BYTES: Record<keyof typeof SPEECH_MODEL_FILES, number> = {
  encoder: 42_980_793,
  decoder: 13_877_276,
  joiner: 3_228_485,
  tokens: 56_317
}

interface ActiveSpeechSession {
  requestId: string
  sender: WebContents
  worker: UtilityProcess
  ready: boolean
  stopping: boolean
  finalReceived: boolean
  timeout: NodeJS.Timeout
  resolveStart: () => void
  rejectStart: (reason: Error) => void
}

export function speechModelDirectory(packaged = app.isPackaged): string {
  return packaged
    ? path.join(process.resourcesPath, 'asr', SPEECH_MODEL_ID)
    : path.join(app.getAppPath(), '.cache', 'asr', SPEECH_MODEL_ID)
}

async function verifiedModelDirectory(): Promise<string | null> {
  const directory = speechModelDirectory()
  try {
    const directoryInfo = await lstat(directory)
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) return null
    const canonical = await realpath(directory)
    for (const [key, name] of Object.entries(SPEECH_MODEL_FILES) as Array<[keyof typeof SPEECH_MODEL_FILES, string]>) {
      const file = path.join(canonical, name)
      const info = await lstat(file)
      if (info.isSymbolicLink() || !info.isFile() || info.size !== EXPECTED_MODEL_BYTES[key]) return null
      if (path.dirname(await realpath(file)) !== canonical) return null
    }
    return canonical
  } catch {
    return null
  }
}

function nativeRuntimeAvailable(): boolean {
  try {
    require.resolve('sherpa-onnx-node')
    require.resolve('sherpa-onnx-darwin-arm64')
    return true
  } catch {
    return false
  }
}

export class SpeechRecognitionService {
  private active: ActiveSpeechSession | null = null

  async status(): Promise<SpeechRecognitionStatus> {
    const supported = process.platform === 'darwin' && process.arch === 'arm64'
    const runtime = supported && nativeRuntimeAvailable()
    const modelInstalled = runtime && Boolean(await verifiedModelDirectory())
    return {
      available: supported && runtime && modelInstalled,
      platform: `${process.platform}-${process.arch}`,
      model: SPEECH_MODEL_ID,
      modelInstalled,
      ...(!supported
        ? { reason: 'v2.0.0 的本地语音输入目前只支持 Apple Silicon macOS。' }
        : !runtime
          ? { reason: '本地语音识别运行时未安装。' }
          : !modelInstalled
            ? { reason: '本地语音模型尚未安装；请重新构建 macOS 应用。' }
            : {})
    }
  }

  private send(sender: WebContents, event: SpeechRecognitionEvent): void {
    if (!sender.isDestroyed()) sender.send(IPC.speechEvent, event)
  }

  async start(sender: WebContents, requestId: string, sampleRate: number): Promise<void> {
    if (this.active) throw new Error('已有一段语音正在识别，请先停止。')
    if (!validSpeechRequestId(requestId)) throw new Error('语音请求 ID 无效。')
    if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 96_000) throw new Error('麦克风采样率无效。')
    const status = await this.status()
    if (!status.available) throw new Error(status.reason ?? '本地语音识别不可用。')
    const modelDirectory = await verifiedModelDirectory()
    if (!modelDirectory) throw new Error('本地语音模型校验失败。')

    this.send(sender, { requestId, type: 'loading' })
    const worker = utilityProcess.fork(path.join(currentDirectory, 'asr-worker.js'), [], {
      serviceName: 'CoScribe Local Speech Recognition',
      stdio: 'ignore'
    })

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const active = this.active
        if (active?.requestId === requestId) {
          active.worker.kill()
          this.active = null
        }
        reject(new Error('本地语音模型启动超时。'))
      }, 30_000)
      const session: ActiveSpeechSession = {
        requestId,
        sender,
        worker,
        ready: false,
        stopping: false,
        finalReceived: false,
        timeout,
        resolveStart: resolve,
        rejectStart: reject
      }
      this.active = session

      worker.on('spawn', () => worker.postMessage({
        type: 'init',
        requestId,
        sampleRate: Math.round(sampleRate),
        modelDirectory
      }))
      worker.on('message', (value: unknown) => this.onWorkerMessage(session, value))
      worker.on('exit', (code) => this.onWorkerExit(session, code))
      worker.on('error', (_type, location) => this.fail(session, new Error(`语音识别进程异常：${location}`)))
    })
  }

  private onWorkerMessage(session: ActiveSpeechSession, value: unknown): void {
    if (this.active !== session || !value || typeof value !== 'object') return
    const message = value as SpeechWorkerOutputMessage
    if (message.requestId !== session.requestId) return
    if (message.type === 'ready') {
      session.ready = true
      clearTimeout(session.timeout)
      session.resolveStart()
      this.send(session.sender, { requestId: session.requestId, type: 'listening' })
      return
    }
    if (message.type === 'error') {
      this.fail(session, new Error(message.message))
      return
    }
    if (message.type === 'transcript') {
      session.finalReceived ||= message.final
      this.send(session.sender, {
        requestId: session.requestId,
        type: 'transcript',
        text: typeof message.text === 'string' ? message.text.slice(0, 80_000) : '',
        final: message.final === true
      })
      if (message.final) this.send(session.sender, { requestId: session.requestId, type: 'stopped' })
    }
  }

  private onWorkerExit(session: ActiveSpeechSession, code: number): void {
    if (this.active !== session) return
    clearTimeout(session.timeout)
    this.active = null
    if (!session.ready) session.rejectStart(new Error('本地语音模型无法启动。'))
    if (!session.finalReceived && !session.stopping) {
      this.send(session.sender, {
        requestId: session.requestId,
        type: 'error',
        message: `本地语音识别进程意外退出（代码 ${code}）。`
      })
    } else if (!session.finalReceived) {
      this.send(session.sender, { requestId: session.requestId, type: 'stopped' })
    }
  }

  private fail(session: ActiveSpeechSession, error: Error): void {
    if (this.active !== session) return
    clearTimeout(session.timeout)
    this.active = null
    session.worker.kill()
    if (!session.ready) session.rejectStart(error)
    this.send(session.sender, { requestId: session.requestId, type: 'error', message: error.message })
  }

  audio(sender: WebContents, requestId: string, value: unknown): void {
    const session = this.active
    if (!session || session.sender.id !== sender.id || session.requestId !== requestId || !session.ready || session.stopping) return
    const samples = normalizedSpeechSamples(value)
    if (!samples) {
      this.fail(session, new Error('麦克风返回了无效音频分片。'))
      return
    }
    session.worker.postMessage({ type: 'audio', requestId, samples })
  }

  stop(sender: WebContents, requestId: string): void {
    const session = this.active
    if (!session || session.sender.id !== sender.id || session.requestId !== requestId) return
    if (session.stopping) return
    session.stopping = true
    if (!session.ready) {
      this.fail(session, new Error('语音识别已取消。'))
      return
    }
    session.worker.postMessage({ type: 'stop', requestId })
    session.timeout = setTimeout(() => {
      if (this.active !== session) return
      session.worker.kill()
      this.active = null
      this.send(sender, { requestId, type: 'stopped' })
    }, 5_000)
  }

  stopAll(): void {
    const session = this.active
    if (!session) return
    clearTimeout(session.timeout)
    session.worker.kill()
    this.active = null
    this.send(session.sender, { requestId: session.requestId, type: 'stopped' })
  }
}
