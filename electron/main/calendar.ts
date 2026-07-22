import { execFile } from 'node:child_process'

import type { CalendarSyncRequest, CalendarSyncResult } from '../../src/shared/types'

const APPLE_SCRIPT = `
on run argv
  set itemKind to item 1 of argv
  set itemTitle to item 2 of argv
  set itemYear to (item 3 of argv) as integer
  set itemMonth to (item 4 of argv) as integer
  set itemDay to (item 5 of argv) as integer
  set itemHour to (item 6 of argv) as integer
  set itemMinute to (item 7 of argv) as integer
  set itemDuration to (item 8 of argv) as integer
  set itemNotes to item 9 of argv
  set startDate to current date
  set year of startDate to itemYear
  set month of startDate to itemMonth
  set day of startDate to itemDay
  set hours of startDate to itemHour
  set minutes of startDate to itemMinute
  set seconds of startDate to 0
  if itemKind is "event" then
    tell application "Calendar"
      set targetCalendar to first calendar whose writable is true
      tell targetCalendar
        make new event at end of events with properties {summary:itemTitle, start date:startDate, end date:(startDate + itemDuration * minutes), description:itemNotes}
      end tell
    end tell
  else
    tell application "Reminders"
      set targetList to default list
      tell targetList
        make new reminder at end of reminders with properties {name:itemTitle, body:itemNotes, due date:startDate}
      end tell
    end tell
  end if
end run
`.trim()

type ScriptRunner = (args: string[]) => Promise<void>

function runAppleScript(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', APPLE_SCRIPT, '--', ...args], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true
    }, (error, _stdout, stderr) => {
      if (!error) return resolve()
      const detail = stderr.trim()
      reject(new Error(detail || error.message))
    })
  })
}

export function normalizeCalendarRequest(value: CalendarSyncRequest): Required<Omit<CalendarSyncRequest, 'notes'>> & { notes: string } {
  if (!value || (value.kind !== 'event' && value.kind !== 'reminder')) throw new Error('日历项目类型无效。')
  const title = typeof value.title === 'string' ? value.title.trim().slice(0, 500) : ''
  if (!title) throw new Error('日历项目标题不能为空。')
  if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value.date)) throw new Error('日期必须使用 YYYY-MM-DD。')
  const [year, month, day] = value.date.split('-').map(Number)
  const probe = new Date(Date.UTC(year, month - 1, day))
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) throw new Error('日期不存在。')
  const time = typeof value.time === 'string' && value.time.trim() ? value.time.trim() : '09:00'
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new Error('时间必须使用 HH:mm。')
  const rawDuration = typeof value.durationMinutes === 'number' && Number.isFinite(value.durationMinutes) ? value.durationMinutes : 60
  const durationMinutes = Math.max(5, Math.min(24 * 60, Math.round(rawDuration)))
  const notes = typeof value.notes === 'string' ? value.notes.trim().slice(0, 10_000) : ''
  return { kind: value.kind, title, date: value.date, time, durationMinutes, notes }
}

export class CalendarService {
  constructor(private readonly runner: ScriptRunner = runAppleScript) {}

  async sync(value: CalendarSyncRequest): Promise<CalendarSyncResult> {
    if (process.platform !== 'darwin') throw new Error('系统日历同步目前只支持 macOS。')
    const request = normalizeCalendarRequest(value)
    const [year, month, day] = request.date.split('-')
    const [hour, minute] = request.time.split(':')
    try {
      await this.runner([
        request.kind,
        request.title,
        year,
        month,
        day,
        hour,
        minute,
        String(request.durationMinutes),
        request.notes
      ])
    } catch (error) {
      const message = error instanceof Error ? error.message : 'macOS 拒绝了日历操作。'
      if (/-1743|not authorized|不允许|未获授权/iu.test(message)) {
        throw new Error('CoScribe 尚未获得日历或提醒事项权限。请在“系统设置 → 隐私与安全性 → 自动化”中允许后重试。')
      }
      throw new Error(`无法写入${request.kind === 'event' ? '日历' : '提醒事项'}：${message}`)
    }
    return {
      kind: request.kind,
      title: request.title,
      target: request.kind === 'event' ? 'Calendar' : 'Reminders',
      createdAt: Date.now()
    }
  }
}
