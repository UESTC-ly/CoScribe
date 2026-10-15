import type { FileReadResult, ResearchReference } from './types'

export type ResearchSource = 'crossref' | 'arxiv' | 'github'
export interface ResearchSearchRequest {
  topic: string
  sources: ResearchSource[]
  limit: number
  useAi: boolean
  githubMcpServerId?: string
}
export interface ResearchCandidate {
  id: string
  source: ResearchSource
  sourceId: string
  reference: ResearchReference
  pdfUrl?: string
  repository?: string
  readmePath?: string
  referenceId?: string
  imported?: boolean
  downloadStatus?: string
}
export interface ResearchRun {
  id: string
  topic: string
  queries: string[]
  sources: ResearchSource[]
  createdAt: number
  status: 'searching' | 'ready' | 'importing' | 'completed' | 'cancelled' | 'failed' | 'interrupted'
  candidates: ResearchCandidate[]
  warnings: string[]
  searches?: Array<{ source: ResearchSource; query: string; count: number; error?: string }>
  artifacts?: Array<{ path: string; kind: 'note' | 'review' }>
  logPath?: string
}
export interface ResearchDraft {
  id: string
  path: string
  content: string
  warnings: string[]
}
export interface ResearchAPI {
  list: () => Promise<ResearchRun[]>
  start: (request: ResearchSearchRequest) => Promise<ResearchRun>
  get: (id: string) => Promise<ResearchRun>
  cancel: (id: string) => Promise<void>
  import: (id: string, candidateIds: string[], download: boolean) => Promise<ResearchRun>
  draft: (id: string, candidateIds: string[], kind: 'note' | 'review', useAi: boolean) => Promise<ResearchDraft>
  confirm: (draftId: string) => Promise<FileReadResult>
}
