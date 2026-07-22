import { describe, expect, it } from 'vitest'

import { dailyNotePath, isValidLocalDateValue, renderNoteTemplate, weeklyNotePath } from '../../src/plugins/daily-notes/daily-utils'

describe('daily note templates', () => {
  it('renders portable project and date variables', () => {
    expect(renderNoteTemplate('# {{project}} {{date}} {{year}}/{{month}}/{{day}} W{{week}} {{weekday}}', '2026-07-23', 'CoScribe')).toMatch(/^# CoScribe 2026-07-23 2026\/07\/23 W30 /u)
    expect(dailyNotePath('2026-07-23')).toBe('每日笔记/2026-07-23.md')
    expect(weeklyNotePath('2026-07-23')).toBe('每周回顾/2026-W30.md')
  })

  it('rejects missing, impossible, and path-like dates', () => {
    expect(isValidLocalDateValue('2026-02-29')).toBe(false)
    expect(isValidLocalDateValue('2026-02-28')).toBe(true)
    expect(() => dailyNotePath('../../outside')).toThrow(/日期无效/u)
    expect(() => weeklyNotePath('')).toThrow(/日期无效/u)
  })
})
