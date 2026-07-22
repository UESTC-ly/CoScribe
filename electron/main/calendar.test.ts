import { describe, expect, it, vi } from 'vitest'

import { CalendarService, normalizeCalendarRequest } from './calendar'

describe('macOS calendar bridge', () => {
  it('normalizes bounded event fields without interpolating them into AppleScript', () => {
    expect(normalizeCalendarRequest({
      kind: 'event', title: '  Review  ', date: '2026-07-23', time: '14:30', durationMinutes: 45
    })).toEqual({
      kind: 'event', title: 'Review', date: '2026-07-23', time: '14:30', durationMinutes: 45, notes: ''
    })
    expect(() => normalizeCalendarRequest({ kind: 'event', title: 'Bad', date: '2026-02-30' })).toThrow(/日期不存在/u)
    expect(() => normalizeCalendarRequest({ kind: 'reminder', title: '', date: '2026-07-23' })).toThrow(/标题/u)
    expect(normalizeCalendarRequest({ kind: 'event', title: 'Default duration', date: '2026-07-23', durationMinutes: Number.NaN }).durationMinutes).toBe(60)
  })

  it.runIf(process.platform === 'darwin')('passes user content as osascript argv', async () => {
    const runner = vi.fn(async () => undefined)
    const service = new CalendarService(runner)
    await expect(service.sync({
      kind: 'reminder', title: 'Quote " safe', date: '2026-07-23', notes: 'line one\nline two'
    })).resolves.toMatchObject({ target: 'Reminders', title: 'Quote " safe' })
    expect(runner).toHaveBeenCalledWith([
      'reminder', 'Quote " safe', '2026', '07', '23', '09', '00', '60', 'line one\nline two'
    ])
  })
})
