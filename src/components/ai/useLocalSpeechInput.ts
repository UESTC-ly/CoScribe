import { useEffect, useRef, useState } from 'react'

import type { SpeechRecognitionEvent } from '../../shared/types'
import { composeSpeechDraft, SPEECH_AUDIO_CHUNK_SAMPLES, SpeechChunkAccumulator } from '../../lib/speech-input'

type SpeechPhase = 'idle' | 'checking' | 'permission' | 'loading' | 'listening' | 'stopping'

interface SpeechResources {
  requestId: string
  stream: MediaStream
  context: AudioContext
  source: MediaStreamAudioSourceNode
  worklet: AudioWorkletNode
  moduleUrl: string
  accumulator: SpeechChunkAccumulator
}

interface UseLocalSpeechInputOptions {
  draft: string
  onDraftChange: (value: string) => void
  onError: (message: string) => void
}

interface LocalSpeechInput {
  phase: SpeechPhase
  active: boolean
  start: () => Promise<void>
  stop: () => Promise<void>
}

const WORKLET_SOURCE = `
class CoScribePcmProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel && channel.length) this.port.postMessage(channel.slice())
    return true
  }
}
registerProcessor('coscribe-pcm-input', CoScribePcmProcessor)
`

export function useLocalSpeechInput({ draft, onDraftChange, onError }: UseLocalSpeechInputOptions): LocalSpeechInput {
  const [phase, setPhase] = useState<SpeechPhase>('idle')
  const resources = useRef<SpeechResources | null>(null)
  const requestId = useRef<string | null>(null)
  const prefix = useRef('')
  const draftRef = useRef(draft)
  const onDraftChangeRef = useRef(onDraftChange)
  const onErrorRef = useRef(onError)
  draftRef.current = draft
  onDraftChangeRef.current = onDraftChange
  onErrorRef.current = onError

  const releaseMedia = async (flush: boolean): Promise<void> => {
    const active = resources.current
    resources.current = null
    if (!active) return
    if (flush) active.accumulator.flush()
    active.worklet.port.onmessage = null
    active.worklet.disconnect()
    active.source.disconnect()
    for (const track of active.stream.getTracks()) track.stop()
    URL.revokeObjectURL(active.moduleUrl)
    await active.context.close().catch(() => undefined)
  }

  useEffect(() => window.coscribe.speech.onEvent((event: SpeechRecognitionEvent) => {
    if (event.requestId !== requestId.current) return
    if (event.type === 'loading') setPhase('loading')
    else if (event.type === 'listening') setPhase('listening')
    else if (event.type === 'transcript') {
      onDraftChangeRef.current(composeSpeechDraft(prefix.current, event.text))
      if (event.final) void releaseMedia(false)
    } else if (event.type === 'stopped') {
      void releaseMedia(false)
      requestId.current = null
      setPhase('idle')
    } else if (event.type === 'error') {
      void releaseMedia(false)
      requestId.current = null
      setPhase('idle')
      onErrorRef.current(event.message)
    }
  }), [])

  useEffect(() => () => {
    const current = requestId.current
    void releaseMedia(false)
    if (current) void window.coscribe.speech.stop(current)
  }, [])

  const start = async (): Promise<void> => {
    if (requestId.current) return
    const id = `speech-${crypto.randomUUID()}`
    let pendingStream: MediaStream | null = null
    let pendingContext: AudioContext | null = null
    let pendingModuleUrl: string | null = null
    let serviceStarted = false
    requestId.current = id
    prefix.current = draftRef.current
    setPhase('checking')
    try {
      const status = await window.coscribe.speech.status()
      if (!status.available) throw new Error(status.reason ?? '本地语音识别不可用。')
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前环境无法访问麦克风。')
      setPhase('permission')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false
      })
      pendingStream = stream
      const context = new AudioContext({ sampleRate: 16_000, latencyHint: 'interactive' })
      pendingContext = context
      setPhase('loading')
      await window.coscribe.speech.start(id, context.sampleRate)
      serviceStarted = true

      const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
      pendingModuleUrl = moduleUrl
      await context.audioWorklet.addModule(moduleUrl)
      const source = context.createMediaStreamSource(stream)
      const worklet = new AudioWorkletNode(context, 'coscribe-pcm-input', {
        numberOfInputs: 1,
        numberOfOutputs: 0,
        channelCount: 1
      })
      const chunkSamples = Math.max(SPEECH_AUDIO_CHUNK_SAMPLES, Math.round(context.sampleRate * 0.2))
      const accumulator = new SpeechChunkAccumulator(chunkSamples, (samples) => {
        if (requestId.current === id) window.coscribe.speech.audio(id, samples)
      })
      worklet.port.onmessage = (event: MessageEvent<unknown>) => {
        if (event.data instanceof Float32Array) accumulator.push(event.data)
      }
      source.connect(worklet)
      resources.current = { requestId: id, stream, context, source, worklet, moduleUrl, accumulator }
      pendingStream = null
      pendingContext = null
      pendingModuleUrl = null
      await context.resume()
      setPhase('listening')
    } catch (reason) {
      await releaseMedia(false)
      for (const track of pendingStream?.getTracks() ?? []) track.stop()
      if (pendingContext) await pendingContext.close().catch(() => undefined)
      if (pendingModuleUrl) URL.revokeObjectURL(pendingModuleUrl)
      if (serviceStarted) await window.coscribe.speech.stop(id).catch(() => undefined)
      requestId.current = null
      setPhase('idle')
      onErrorRef.current(reason instanceof Error ? reason.message : '无法启动本地语音输入。')
    }
  }

  const stop = async (): Promise<void> => {
    const current = requestId.current
    if (!current || phase === 'stopping') return
    setPhase('stopping')
    await releaseMedia(true)
    await window.coscribe.speech.stop(current).catch((reason: unknown) => {
      requestId.current = null
      setPhase('idle')
      onErrorRef.current(reason instanceof Error ? reason.message : '无法停止语音输入。')
    })
  }

  return { phase, active: phase !== 'idle', start, stop }
}
