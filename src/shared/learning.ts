import type { FlashcardGrade, FlashcardReviewState } from '../plugins/flashcards/flashcard-utils'

export type LearningStage = 'not-started' | 'learning' | 'learned' | 'paused'
export type SelfAssessment = 'unassessed' | 'needs-practice' | 'confident'
export type KnowledgeRelationKind = 'prerequisite' | 'part-of' | 'contrast' | 'application'
export type SourceStatus = 'available' | 'changed' | 'missing' | 'project-closed' | 'unverified' | 'blocked'

export interface LearningSourceInput {
  kind: 'project' | 'note' | 'literature' | 'selection'
  path?: string
  referenceId?: string
  quote?: string
  page?: number
  line?: number
}

export interface LearningSource extends LearningSourceInput {
  id: string
  workspaceId: string
  projectName: string
  fingerprint: string | null
  createdAt: number
  updatedAt: number
  revision: number
  status: SourceStatus
}

export interface KnowledgePoint {
  id: string
  name: string
  domain: string
  sourceIds: string[]
  createdAt: number
  updatedAt: number
  revision: number
}

export type LearningRecordInput = {
  knowledgeId: string
  sourceId?: string
  note: string
} & (
    | {
      kind: 'interest'
      value: 'following' | 'not-following'
    }
    | {
      kind: 'stage'
      value: LearningStage
    }
    | {
      kind: 'self-assessment'
      value: SelfAssessment
    }
  )

export type LearningRecord = LearningRecordInput & {
  id: string
  origin: 'user-explicit'
  createdAt: number
  updatedAt: number
  revision: number
}

export interface KnowledgeRelation {
  id: string
  fromId: string
  toId: string
  kind: KnowledgeRelationKind
  sourceId?: string
  note: string
  origin: 'user' | 'model'
  confirmedAt: number | null
  createdAt: number
  updatedAt: number
  revision: number
}

export interface ReviewMaterial {
  id: string
  knowledgeId: string
  question: string
  answer: string
  sourceId?: string
  relationIds: string[]
  origin: 'user' | 'model' | 'legacy-import'
  confirmedAt: number | null
  createdAt: number
  updatedAt: number
  revision: number
  schedule: FlashcardReviewState
  algorithmVersion: string
}

export interface LearningReviewEvent {
  id: string
  submissionId: string
  materialId: string
  knowledgeId: string
  grade: FlashcardGrade
  reviewedAt: number
  updatedAt: number
  revision: number
  nextDueAt: number
  materialRevision: number
  sourceId?: string
  sourceRevision?: number
  algorithmVersion: string
}

export interface LearningSnapshot {
  revision: number
  knowledge: KnowledgePoint[]
  sources: LearningSource[]
  records: LearningRecord[]
  relations: KnowledgeRelation[]
  materials: ReviewMaterial[]
  events: LearningReviewEvent[]
}

type Versioned = { expectedRevision: number }
export type LearningMutation = Versioned & (
  | {
    op: 'knowledge.save'
    id?: string
    name: string
    domain: string
  }
  | {
    op: 'knowledge.delete'
    id: string
  }
  | {
    op: 'source.attach'
    knowledgeId: string
    source: LearningSourceInput
  }
  | {
    op: 'source.relink'
    id: string
    source: LearningSourceInput
  }
  | {
    op: 'source.delete'
    id: string
  }
  | {
    op: 'record.save'
    id?: string
    record: LearningRecordInput
  }
  | {
    op: 'record.delete'
    id: string
  }
  | {
    op: 'relation.save'
    id?: string
    fromId: string
    toId: string
    kind: KnowledgeRelationKind
    sourceId?: string
    note: string
    origin: 'user' | 'model'
  }
  | {
    op: 'relation.confirm'
    id: string
  }
  | {
    op: 'relation.delete'
    id: string
  }
  | {
    op: 'material.save'
    id?: string
    knowledgeId: string
    question: string
    answer: string
    sourceId?: string
    relationIds: string[]
    origin: 'user' | 'model'
  }
  | {
    op: 'material.confirm'
    id: string
  }
  | {
    op: 'material.delete'
    id: string
  }
  | {
    op: 'review.submit'
    submissionId: string
    materialId: string
    grade: FlashcardGrade
  }
  | {
    op: 'review.correct'
    id: string
    grade: FlashcardGrade
  }
  | {
    op: 'review.delete'
    id: string
  }
)

// Available even after plugin consent is withdrawn: inspect/correct/forget
// existing personal data, without adding sources, suggestions or reviews.
export type LearningCorrection = Exclude<LearningMutation,
  { op: 'source.attach' | 'source.relink' | 'relation.save' | 'relation.confirm' | 'material.save' | 'material.confirm' | 'review.submit' }>

export interface LegacyLearningImport {
  expectedRevision: number
  paths: string[]
}
export interface LegacyLearningImportResult {
  snapshot: LearningSnapshot
  imported: number
  alreadyImported: number
  unmatchedReviewIds: string[]
}

export interface LearningAPI {
  list: () => Promise<LearningSnapshot>
  mutate: (input: LearningMutation) => Promise<LearningSnapshot>
  due: (through?: number) => Promise<{
    revision: number
    materials: ReviewMaterial[]
  }>
  importLegacy: (input: LegacyLearningImport) => Promise<LegacyLearningImportResult>
  inspect: () => Promise<LearningSnapshot>
  correct: (input: LearningCorrection) => Promise<LearningSnapshot>
}
