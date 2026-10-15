import type { ReviewActivity } from '../../../src/shared/assistant'
import type { PlannerTask } from '../../../src/plugins/planner/planner-utils'
import { contentHash, fingerprint } from './automatic-memory'

export function validDay(date: string): boolean {
  const instant = Date.parse(date + 'T12:00:00Z')
  return /^\d{4}-\d{2}-\d{2}$/u.test(date) && date >= '2000-01-01' && date <= '2100-12-31' && Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === date
}

export function nextDay(date: string): string {
  return new Date(Date.parse(date + 'T12:00:00Z') + 86_400_000).toISOString().slice(0, 10)
}

export function dayWindow(date: string, timeZone: string): { start: number; end: number } {
  if (!validDay(date)) throw new Error('复盘日期无效。')
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
  const localDay = (instant: number): string => {
    const parts = formatter.formatToParts(new Date(instant))
    return ['year', 'month', 'day'].map((key) => parts.find((part) => part.type === key)!.value).join('-')
  }
  const boundary = (day: string): number => {
    const center = Date.parse(day + 'T00:00:00Z')
    let left = center - 172_800_000
    let right = center + 172_800_000
    while (left < right) {
      const middle = Math.floor((left + right) / 2)
      if (localDay(middle) < day) left = middle + 1
      else right = middle
    }
    return left
  }
  const start = boundary(date)
  if (localDay(start) !== date) throw new Error('所选时区中不存在这个日期。')
  return { start, end: boundary(nextDay(date)) }
}

function plain(text: string): string {
  return text.replace(/\r?\n/gu, ' ').replace(/[\\`*{}\[\]<>#|]/gu, '\\$&')
}

export function reviewMarkers(date: string, timeZone: string): { start: string; end: string } {
  const key = `${date}:${fingerprint(timeZone).slice(0, 12)}`
  return { start: `<!-- coscribe:review:${key}:start -->`, end: `<!-- coscribe:review:${key}:end -->` }
}

export function renderReview(input: { date: string; timeZone: string; activities: ReviewActivity[]; plans: PlannerTask[]; gaps: string[] }): string {
  const { date, timeZone, activities, plans, gaps } = input
  const time = new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const rows = (kinds: ReviewActivity['kind'][]): string[] => activities.filter((item) => kinds.includes(item.kind)).map((item) => `- ${plain(item.summary)}（${item.source === 'user-report' ? '用户补充，日期由用户指定' : '应用记录 ' + time.format(new Date(item.occurredAt))}；${plain(item.locator)}；来源 ${item.id}）`)
  const section = (title: string, content: string[], empty: string): string => `### ${title}\n\n${content.length ? content.join('\n') : empty}\n`
  const todayPlans = plans.filter((item) => item.date === date).map((item) => `- ${plain(item.title)}：计划表状态为“${item.status}”（仅为计划记录，不作为实际完成证据）。`)
  const tomorrow = plans.filter((item) => item.date === nextDay(date)).map((item) => `- ${plain(item.time || '时间未指定')} · ${plain(item.title)}（${item.status}）`)
  const suggestions = activities.some((item) => item.kind === 'unresolved') ? ['- 优先处理上面记录的未解决问题，再根据明日计划安排学习时间。'] : ['- 根据已记录内容选择一个主题继续学习，并补充可验证的完成记录。']
  const markers = reviewMarkers(date, timeZone)
  return [markers.start, `## ${date} 每日复盘`, `> 时区：${plain(timeZone)}。按实际活动账本生成，不调用模型；记录不等于学会或参加。`,
    section('已记录的对话与笔记活动', rows(['conversation', 'note-edited', 'reflection']), '本日未发现已记录的相关活动；不代表今天没有学习。'),
    section('实际完成事项', rows(['completed']), '没有已记录的完成事项，不能据此判断计划是否完成。'),
    section('未解决问题', rows(['unresolved']), '没有已记录的未解决问题。'),
    section('计划与实际对照', todayPlans, '未读取到本日计划。'),
    section('明日已知安排', tomorrow, '当前已读取范围内没有明日安排；系统日历和邮箱未接入。'),
    section('下一步建议', suggestions, ''),
    section('覆盖范围与缺口', gaps.map((gap) => '- ' + plain(gap)), '仅覆盖本项目已授权、成功记录的应用内活动与用户补充。'),
    markers.end].join('\n') + '\n'
}

export function managedBlock(content: string, date: string, timeZone: string): string | null {
  const markers = reviewMarkers(date, timeZone)
  const start = content.indexOf(markers.start)
  const end = content.indexOf(markers.end)
  if (start < 0 && end < 0) return null
  if (start < 0 || end < start || content.indexOf(markers.start, start + 1) >= 0 || content.indexOf(markers.end, end + 1) >= 0) throw new Error('复盘区块标记不完整或重复，请保留原文件并选择其他位置。')
  return content.slice(start, end + markers.end.length)
}

export function mergeReview(content: string, block: string, date: string, timeZone: string, ownedHash: string | null): string {
  const existing = managedBlock(content, date, timeZone)
  const next = block.trimEnd()
  if (existing === next) return content
  if (existing) {
    if (!ownedHash || contentHash(existing) !== ownedHash) throw new Error('复盘区块已被人工修改，已保留原内容。请另选文件或先处理修改。')
    return content.replace(existing, next)
  }
  return content + (content ? (content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n') : '') + next + '\n'
}
