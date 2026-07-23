import type {
  AiMessageProgress,
  AiProgressKind,
  AiProgressStage,
  AiProgressStep
} from '../shared/types'

export interface ProgressUpdate {
  kind: AiProgressKind
  stage: AiProgressStage
  label: string
  detail?: string
  status?: AiProgressStep['status']
  updatedAt?: number
}

export function mergeAiProgress(
  current: AiMessageProgress | undefined,
  update: ProgressUpdate
): AiMessageProgress {
  const updatedAt = update.updatedAt ?? Date.now()
  const status = update.status ?? (update.stage === 'complete' ? 'complete' : 'active')
  const existing = current?.kind === update.kind ? current.steps : []
  const steps = existing.map((step) => step.status === 'active' && step.stage !== update.stage
    ? { ...step, status: 'complete' as const }
    : { ...step })
  const index = steps.findIndex((step) => step.stage === update.stage)
  const nextStep: AiProgressStep = {
    stage: update.stage,
    label: update.label,
    status,
    updatedAt,
    ...(update.detail ? { detail: update.detail } : {})
  }
  if (index >= 0) steps[index] = nextStep
  else steps.push(nextStep)
  return {
    kind: update.kind,
    status: status === 'error' ? 'error' : update.stage === 'complete' ? 'complete' : 'active',
    steps
  }
}
