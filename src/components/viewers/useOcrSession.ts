import { useCallback, useEffect, useRef, useState } from 'react'

import { blobToDataUrl, imageDataToBlob, recognizeLocally } from '../../lib/local-ocr'
import type { OcrResult } from '../../shared/types'

export type OcrStatus = 'idle' | 'local' | 'ai'

interface UseOcrSessionOptions {
  path?: string
  page?: number
  sourceModifiedAt?: number
  sourceSize?: number
  getImage: () => Promise<ImageData>
  onResult?: (result: OcrResult | null) => void
}

export function useOcrSession(options: UseOcrSessionOptions) {
  const [result, setResult] = useState<OcrResult | null>(null)
  const [status, setStatus] = useState<OcrStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [panelOpen, setPanelOpen] = useState(false)
  const generation = useRef(0)
  const localController = useRef<AbortController | null>(null)
  const cloudRequestId = useRef<string | null>(null)
  const onResultRef = useRef(options.onResult)
  onResultRef.current = options.onResult

  const publish = useCallback((value: OcrResult | null) => {
    setResult(value)
    onResultRef.current?.(value)
  }, [])

  const stopActive = useCallback(() => {
    generation.current += 1
    localController.current?.abort()
    localController.current = null
    const requestId = cloudRequestId.current
    cloudRequestId.current = null
    if (requestId) void window.coscribe.ocr.stop(requestId).catch(() => undefined)
  }, [])

  useEffect(() => {
    stopActive()
    const current = generation.current
    setStatus('idle')
    setError(null)
    if (!options.path) {
      publish(null)
      return stopActive
    }
    void window.coscribe.ocr.get(options.path, options.page).then((value) => {
      if (generation.current === current) publish(value)
    }).catch(() => {
      if (generation.current === current) publish(null)
    })
    return stopActive
  }, [options.page, options.path, publish, stopActive])

  const runLocal = useCallback(async (): Promise<void> => {
    if (!options.path) return
    setPanelOpen(true)
    if (status !== 'idle') return
    const current = ++generation.current
    const controller = new AbortController()
    localController.current = controller
    setStatus('local')
    setError(null)
    try {
      const output = await recognizeLocally(await options.getImage(), controller.signal)
      if (generation.current !== current) return
      const saved = await window.coscribe.ocr.save({
        path: options.path,
        ...(options.page ? { page: options.page } : {}),
        text: output.text,
        lines: output.lines,
        engine: 'paddleocr-v6',
        model: output.model,
        createdAt: Date.now(),
        sourceModifiedAt: options.sourceModifiedAt ?? 0,
        sourceSize: options.sourceSize ?? 0,
        ...(!output.text ? { warnings: ['没有识别到可用文字。'] } : {})
      })
      if (generation.current === current) publish(saved)
    } catch (reason) {
      if (generation.current === current && (reason as Error).name !== 'AbortError') {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (localController.current === controller) localController.current = null
      if (generation.current === current) setStatus('idle')
    }
  }, [options, publish, status])

  const runAi = useCallback(async (): Promise<void> => {
    if (!options.path) return
    setPanelOpen(true)
    if (status !== 'idle') return
    const current = ++generation.current
    const requestId = `ocr-${crypto.randomUUID()}`
    setStatus('ai')
    setError(null)
    try {
      const imageDataUrl = await blobToDataUrl(await imageDataToBlob(await options.getImage()))
      if (generation.current !== current) return
      cloudRequestId.current = requestId
      const value = await window.coscribe.ocr.enhance({
        requestId,
        path: options.path,
        ...(options.page ? { page: options.page } : {}),
        imageDataUrl
      })
      if (generation.current === current) publish(value)
    } catch (reason) {
      if (generation.current === current && (reason as Error).name !== 'AbortError') {
        setError(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (cloudRequestId.current === requestId) cloudRequestId.current = null
      if (generation.current === current) setStatus('idle')
    }
  }, [options, publish, status])

  const cancel = useCallback(() => {
    stopActive()
    setStatus('idle')
  }, [stopActive])

  return {
    result,
    status,
    error,
    panelOpen,
    setPanelOpen,
    runLocal,
    runAi,
    cancel
  }
}
