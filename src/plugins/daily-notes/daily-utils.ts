export const DEFAULT_DAILY_TEMPLATE = `# {{date}} · {{weekday}}

## 今日重点

- [ ]

## 学习与工作记录


## 想法与发现


## 明日准备

- [ ]
`

export const DEFAULT_WEEKLY_TEMPLATE = `# {{year}} 年第 {{week}} 周回顾

## 本周成果

-

## 重要笔记

-

## 未完成事项

- [ ]

## 下周重点

- [ ]
`

function isoWeek(date: Date): number {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const day = target.getUTCDay() || 7
  target.setUTCDate(target.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1))
  return Math.ceil((((target.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
}

function parsedLocalDate(dateValue: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(dateValue)) return null
  const [year, month, day] = dateValue.split('-').map(Number)
  const date = new Date(year, month - 1, day, 12)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

export function isValidLocalDateValue(dateValue: string): boolean {
  return parsedLocalDate(dateValue) !== null
}

function requireLocalDate(dateValue: string): Date {
  const date = parsedLocalDate(dateValue)
  if (!date) throw new Error('笔记日期无效。')
  return date
}

export function localDateValue(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function dailyNotePath(dateValue: string): string {
  requireLocalDate(dateValue)
  return `每日笔记/${dateValue}.md`
}

export function weeklyNotePath(dateValue: string): string {
  const date = requireLocalDate(dateValue)
  return `每周回顾/${date.getFullYear()}-W${String(isoWeek(date)).padStart(2, '0')}.md`
}

export function renderNoteTemplate(template: string, dateValue: string, projectName: string): string {
  const date = requireLocalDate(dateValue)
  const variables: Record<string, string> = {
    date: dateValue,
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1).padStart(2, '0'),
    day: String(date.getDate()).padStart(2, '0'),
    weekday: new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(date),
    week: String(isoWeek(date)).padStart(2, '0'),
    project: projectName
  }
  return template.replace(/\{\{(date|year|month|day|weekday|week|project)\}\}/gu, (_match, key: string) => variables[key] ?? '').trimEnd() + '\n'
}
