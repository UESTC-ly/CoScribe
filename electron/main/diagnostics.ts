import { app } from 'electron'

import type { DiagnosticsSnapshot, ProcessDiagnostic } from '../../src/shared/types'
import { TRUSTED_PLUGIN_REGISTRY } from '../../src/plugins/registry'
import { KnowledgeIndexService } from './knowledge-index'
import { SettingsStore } from './settings'
import { SpeechRecognitionService } from './speech'

export function processDiagnostic(metric: Electron.ProcessMetric): ProcessDiagnostic {
  return {
    type: metric.type,
    cpuPercent: Math.round(metric.cpu.percentCPUUsage * 10) / 10,
    memoryMb: Math.round(metric.memory.workingSetSize / 1024 * 10) / 10
  }
}

export function bytesToMegabytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes < 0) return 0
  return Math.round(bytes / 1024 / 1024 * 10) / 10
}

export class DiagnosticsService {
  constructor(
    private readonly knowledge: KnowledgeIndexService,
    private readonly settings: SettingsStore,
    private readonly speech: SpeechRecognitionService
  ) {}

  async snapshot(): Promise<DiagnosticsSnapshot> {
    const [settings, speech] = await Promise.all([
      this.settings.get(),
      this.speech.status()
    ])
    return {
      capturedAt: Date.now(),
      uptimeSeconds: Math.round(process.uptime()),
      appMemoryMb: bytesToMegabytes(process.memoryUsage().rss),
      processes: app.getAppMetrics().map(processDiagnostic).sort((left, right) => right.memoryMb - left.memoryMb),
      index: this.knowledge.status(),
      enabledPlugins: settings.enabledPlugins.length,
      totalPlugins: TRUSTED_PLUGIN_REGISTRY.length,
      speechModelInstalled: speech.modelInstalled
    }
  }
}
