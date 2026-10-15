import { createHash } from 'node:crypto'
import type { PersonalMemoryInput } from '../../../src/shared/assistant'

export function contentHash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value.normalize('NFKC').trim()).digest('hex')
}

export interface ExtractedMemory extends PersonalMemoryInput {
  quote: string
  slot: string
  autoEligible: boolean
}

// Only the current, directly submitted user text enters this extractor. It
// never reads attachments, recalled memories, model output, or old sessions.
export function extractMemories(text: string): ExtractedMemory[] {
  if (text.length > 2_000 || /["“”‘’`<>]|(?:^|\n)\s*>|(?:引用|假设|假如|如果|例如|比如|示例|角色扮演|邮件|网页|原文|文章|作者|他说|她说|忽略|密钥|密码|令牌|系统指令|忘记|不要记住)/u.test(text)) return []
  const result: ExtractedMemory[] = []
  for (const statement of text.split(/[。！!\n]/u).map((value) => value.trim()).filter(Boolean)) {
    if (statement.length < 5 || statement.length > 250 || /[?？]|(?:不再|停止|已经|曾经|过去|也许|可能|打算让|替我)/u.test(statement)) continue
    const learning = statement.match(/^我(?:最近|目前|现在)?正在(?:学习|复习|研究|准备)([^，,；;：:]+)$/u)
    const preference = /^(?:我(?:更)?喜欢|我希望你|以后请)(?:用中文|用英文|用C\+\+|用Python|先给例子|先给结论|详细讲解|简洁回答)/iu.test(statement)
    const profile = /^我是[^，,；;：:]+(?:学生|工程师|研究员|教师|开发者)$/u.test(statement)
    if (learning) {
      result.push({ category: 'goal', text: statement, quote: statement, slot: 'learning:' + fingerprint(learning[1]), autoEligible: !/(?:疾病|抑郁|焦虑|治疗|宗教|政治|婚姻|怀孕|收入|账号)/u.test(statement) })
    } else if (preference || profile) {
      result.push({ category: preference ? 'preference' : 'profile', text: statement, quote: statement, slot: preference ? 'explanation' : 'identity', autoEligible: false })
    }
    if (result.length === 3) break
  }
  return result
}
