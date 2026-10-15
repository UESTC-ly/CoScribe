import { z } from 'zod'

const memoryFields = {
  category: z.enum(['preference', 'profile', 'goal']),
  text: z.string().trim().min(1).max(1_000)
}
const identityFields = {
  id: z.uuid(),
  expectedRevision: z.number().int().positive()
}

export const rememberSchema = z.strictObject(memoryFields)
export const updateSchema = z.strictObject({ ...memoryFields, ...identityFields })
export const forgetSchema = z.strictObject(identityFields)
export const policySchema = z.strictObject({
  enabled: z.boolean(),
  allowRemote: z.boolean(),
  expectedRevision: z.number().int().nonnegative()
})
export const recallSchema = z.strictObject({
  query: z.string().max(20_000),
  remote: z.boolean(),
  coreOnly: z.boolean().optional()
})

export const memorySearchSchema = z.strictObject({ query: z.string().trim().min(1).max(2_000), limit: z.number().int().min(1).max(8).default(5) })
export const memoryReadSchema = z.strictObject({ items: z.array(z.strictObject({ kind: z.enum(['memory', 'learning']), id: z.uuid(), revision: z.number().int().positive() })).min(1).max(5) })
export const searchPolicySchema = z.strictObject({ profileId: z.string().max(80).regex(/^[A-Za-z0-9._-]*$/u), model: z.string().trim().max(100), expectedRevision: z.number().int().nonnegative() })

export type AssistantCommand = 'list' | 'remember' | 'update' | 'forget' | 'policy' | 'recall' | 'revision' | 'close'
  | 'memory-search' | 'memory-read' | 'search-policy' | 'rebuild-index' | 'embedding-corpus' | 'embedding-save' | 'answer-begin' | 'answer-record' | 'answer-stale' | 'history-access'
  | 'learning-list' | 'learning-sources' | 'learning-mutate' | 'learning-attach' | 'learning-source-delete' | 'learning-import' | 'learning-due'
  | 'automatic' | 'candidate' | 'observe' | 'workspace' | 'workspace-policy' | 'activity' | 'draft' | 'get-draft' | 'export-state' | 'export-prepare' | 'export-finish' | 'clear-review'
export interface AssistantWorkerRequest {
  id: number
  command: AssistantCommand
  payload?: unknown
}
export interface AssistantWorkerResponse {
  id: number
  value?: unknown
  error?: string
}

// A deterministic lexical baseline, including Chinese short words. No model
// or network calls; the same tokens are used for indexing and querying.
export function memoryTokens(text: string): string[] {
  const normalized = text.normalize('NFKC').toLocaleLowerCase('en-US')
  const tokens = new Set<string>()
  for (const word of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word]
      for (let i = 0; i < chars.length; i += 1) {
        tokens.add(chars[i])
        if (i + 1 < chars.length) tokens.add(chars[i] + chars[i + 1])
      }
    } else tokens.add(word)
  }
  return [...tokens]
}

// Bounded aliases for common technical names; these are query terms, never
// facts about the user. No model call is needed to bridge these names.
export function memoryQuery(text: string): string {
  const aliases = [['RAG', '检索增强生成'], ['LLM', '大语言模型'], ['TypeScript', 'TS'], ['JavaScript', 'JS'], ['C++', 'CPP'], ['间隔复习', '间隔重复']]
  const normalized = text.normalize('NFKC').toLowerCase()
  return text + ' ' + aliases.filter((group) => group.some((term) => /[\u4e00-\u9fff]/u.test(term)
    ? normalized.includes(term.toLowerCase())
    : new RegExp('(?:^|[^a-z0-9])' + term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '(?:$|[^a-z0-9])', 'u').test(normalized))).flat().join(' ')
}
