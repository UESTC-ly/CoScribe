export const PLANNER_FILE_PATH = '计划/项目计划.md'
export const PLANNER_TABLE_START = '<!-- coscribe:planner:start -->'
export const PLANNER_TABLE_END = '<!-- coscribe:planner:end -->'

export const PLANNER_STATUSES = ['待办', '进行中', '已完成'] as const
export const PLANNER_PRIORITIES = ['低', '中', '高'] as const

export type PlannerStatus = (typeof PLANNER_STATUSES)[number]
export type PlannerPriority = (typeof PLANNER_PRIORITIES)[number]

export interface PlannerTask {
  date: string
  time: string
  title: string
  status: PlannerStatus
  priority: PlannerPriority
  notes: string
}

const HEADER = '| 日期 | 时间 | 事项 | 状态 | 优先级 | 备注 |'
const DIVIDER = '| --- | --- | --- | --- | --- | --- |'

function tableBlock(rows: string[] = []): string {
  return [PLANNER_TABLE_START, HEADER, DIVIDER, ...rows, PLANNER_TABLE_END].join('\n')
}

export function createPlannerMarkdown(): string {
  return [
    '# 项目计划',
    '',
    '> 由 CoScribe「计划与日程」插件维护。它仍然是普通 Markdown，可在任何编辑器中查看和修改。',
    '',
    '## 日程表',
    '',
    tableBlock(),
    '',
    '## 本周重点',
    '',
    '- [ ] 写下本周最重要的成果',
    '',
    '## 里程碑',
    '',
    '- [ ] 定义第一个里程碑',
    ''
  ].join('\n')
}

function escapeCell(value: string): string {
  return value.trim().replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/\r?\n/gu, '<br>')
}

function taskRow(task: PlannerTask): string {
  return `| ${escapeCell(task.date)} | ${escapeCell(task.time || '—')} | ${escapeCell(task.title)} | ${task.status} | ${task.priority} | ${escapeCell(task.notes || '—')} |`
}

function splitTableRow(row: string): string[] {
  const value = row.trim().replace(/^\|/u, '').replace(/\|$/u, '')
  const cells: string[] = []
  let cell = ''
  let escaped = false
  for (const character of value) {
    if (escaped) {
      cell += character
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else if (character === '|') {
      cells.push(cell.trim())
      cell = ''
    } else {
      cell += character
    }
  }
  if (escaped) cell += '\\'
  cells.push(cell.trim())
  return cells.map((value) => value.replace(/<br\s*\/?>/giu, '\n'))
}

function isStatus(value: string): value is PlannerStatus {
  return (PLANNER_STATUSES as readonly string[]).includes(value)
}

function isPriority(value: string): value is PlannerPriority {
  return (PLANNER_PRIORITIES as readonly string[]).includes(value)
}

export function parsePlannerTasks(markdown: string): PlannerTask[] {
  const start = markdown.indexOf(PLANNER_TABLE_START)
  const end = markdown.indexOf(PLANNER_TABLE_END, start + PLANNER_TABLE_START.length)
  if (start < 0 || end < 0) return []
  return markdown
    .slice(start + PLANNER_TABLE_START.length, end)
    .split(/\r?\n/u)
    .slice(2)
    .filter((line) => line.trim().startsWith('|'))
    .flatMap((line) => {
      const [date = '', time = '', title = '', status = '', priority = '', notes = ''] = splitTableRow(line)
      if (!title || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) return []
      return [{
        date,
        time: time === '—' ? '' : time,
        title,
        status: isStatus(status) ? status : '待办',
        priority: isPriority(priority) ? priority : '中',
        notes: notes === '—' ? '' : notes
      } satisfies PlannerTask]
    })
    .sort((left, right) => `${left.date} ${left.time}`.localeCompare(`${right.date} ${right.time}`, 'zh-CN'))
}

export function appendPlannerTask(markdown: string, task: PlannerTask): string {
  const source = markdown.trim() ? markdown.replace(/\r\n?/gu, '\n') : createPlannerMarkdown()
  const end = source.indexOf(PLANNER_TABLE_END)
  if (end >= 0 && source.includes(PLANNER_TABLE_START)) {
    const before = source.slice(0, end).replace(/\s*$/u, '')
    return `${before}\n${taskRow(task)}\n${source.slice(end)}`
  }
  return `${source.trimEnd()}\n\n## 日程表\n\n${tableBlock([taskRow(task)])}\n`
}
