import { describe, expect, it } from 'vitest'

import { bytesToMegabytes, processDiagnostic } from './diagnostics'

describe('diagnostics metrics', () => {
  it('converts the Node RSS byte count to a finite megabyte value', () => {
    expect(bytesToMegabytes(256 * 1024 * 1024)).toBe(256)
    expect(bytesToMegabytes(Number.NaN)).toBe(0)
    expect(bytesToMegabytes(-1)).toBe(0)
  })

  it('normalizes Electron working-set metrics reported in kilobytes', () => {
    const metric = {
      type: 'Browser',
      cpu: { percentCPUUsage: 1.24 },
      memory: { workingSetSize: 1536 }
    } as Electron.ProcessMetric

    expect(processDiagnostic(metric)).toEqual({
      type: 'Browser',
      cpuPercent: 1.2,
      memoryMb: 1.5
    })
  })
})
