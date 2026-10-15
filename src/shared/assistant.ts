export type PersonalMemoryCategory = 'preference' | 'profile' | 'goal'

export interface PersonalMemoryInput {
  category: PersonalMemoryCategory
  text: string
}

export interface PersonalMemory extends PersonalMemoryInput {
  id: string
  revision: number
  createdAt: number
  updatedAt: number
  source: {
    id: string
    kind: 'user-explicit' | 'user-stated'
    origin: 'about-me' | 'chat' | 'memory-file'
    recordedAt: number
    quote?: string
    sessionId?: string
  }
}

export interface PersonalMemoryPolicy {
  enabled: boolean
  allowRemote: boolean
  revision: number
}

export interface PersonalMemorySnapshot {
  policy: PersonalMemoryPolicy
  items: PersonalMemory[]
  automatic: AutomaticMemoryPolicy
  candidates: MemoryCandidate[]
  storage?: { format: 'markdown'; directory: string }
  search?: MemorySearchPolicy
}

export interface MemorySearchPolicy { profileId: string; model: string }
export interface MemorySearchHit {
  kind: 'memory' | 'learning'
  id: string
  revision: number
  summary: string
  score: number
  path?: string
}
export interface MemorySearchResult {
  revision: number
  status: PersonalMemoryContext['status']
  hits: MemorySearchHit[]
  warning?: string
}

export interface AutomaticMemoryPolicy {
  enabled: boolean
  saveLearning: boolean
  revision: number
}

export interface MemoryCandidate extends PersonalMemoryInput {
  id: string
  quote: string
  sessionId: string
  createdAt: number
  conflict: boolean
}

export interface ReviewWorkspacePolicy {
  recording: boolean
  revision: number
  since: number | null
}

export type ReviewActivityKind = 'conversation' | 'note-edited' | 'completed' | 'unresolved' | 'reflection'

export interface ReviewActivity {
  id: string
  kind: ReviewActivityKind
  summary: string
  occurredAt: number
  source: 'app-event' | 'user-report'
  locator: string
}

export interface ReviewDraft {
  id: string
  date: string
  timeZone: string
  createdAt: number
  markdown: string
  activityCount: number
  gaps: string[]
}

export interface PersonalMemoryUpdate extends PersonalMemoryInput {
  id: string
  expectedRevision: number
}

export interface PersonalMemoryForget {
  id: string
  expectedRevision: number
}

export interface PersonalMemoryPolicyUpdate {
  enabled: boolean
  allowRemote: boolean
  expectedRevision: number
}

export interface PersonalMemoryContext {
  prompt: string
  revision: number | null
  status: 'used' | 'disabled' | 'remote-blocked' | 'empty' | 'unavailable'
}

export interface AssistantAPI {
  learning: import('./learning').LearningAPI
  memory: {
    list: () => Promise<PersonalMemorySnapshot>
    remember: (input: PersonalMemoryInput) => Promise<PersonalMemorySnapshot>
    update: (input: PersonalMemoryUpdate) => Promise<PersonalMemorySnapshot>
    forget: (input: PersonalMemoryForget) => Promise<PersonalMemorySnapshot>
    setPolicy: (input: PersonalMemoryPolicyUpdate) => Promise<PersonalMemorySnapshot>
    setAutomatic: (input: { enabled: boolean; saveLearning: boolean; expectedRevision: number }) => Promise<PersonalMemorySnapshot>
    resolveCandidate: (input: { id: string; action: 'accept' | 'dismiss'; replaceId?: string; expectedRevision?: number }) => Promise<PersonalMemorySnapshot>
    setSearch: (input: MemorySearchPolicy & { expectedRevision: number }) => Promise<PersonalMemorySnapshot>
    rebuildIndex: (input: { expectedRevision: number }) => Promise<PersonalMemorySnapshot>
  }
  review: {
    policy: () => Promise<ReviewWorkspacePolicy>
    setPolicy: (input: { recording: boolean; expectedRevision: number }) => Promise<ReviewWorkspacePolicy>
    addActivity: (input: { date: string; timeZone: string; kind: 'completed' | 'unresolved' | 'reflection'; summary: string; key: string }) => Promise<void>
    generate: (input: { date: string; timeZone: string; includePlan: boolean }) => Promise<ReviewDraft>
    prepareExport: (input: { draftId: string; targetPath?: string }) => Promise<import('./types').FileOperationProposal>
    commitExport: (proposalId: string) => Promise<import('./types').FileReadResult>
    clear: (expectedRevision: number) => Promise<ReviewWorkspacePolicy>
  }
}
