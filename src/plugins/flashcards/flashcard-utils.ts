export type FlashcardGrade = 'again' | 'hard' | 'good' | 'easy'

export interface Flashcard {
  id: string
  question: string
  answer: string
  sourcePath: string
  line: number
}

export interface FlashcardReviewState {
  cardId: string
  dueAt: number
  intervalDays: number
  ease: number
  repetitions: number
  lastReviewedAt?: number
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(36)
}

export function parseFlashcards(markdown: string, sourcePath: string): Flashcard[] {
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  const cards: Flashcard[] = []
  for (let index = 0; index < lines.length; index += 1) {
    const question = lines[index]?.match(/^Q::\s*(.+)$/u)?.[1]?.trim()
    if (!question) continue
    const answer = lines[index + 1]?.match(/^A::\s*(.+)$/u)?.[1]?.trim()
    if (!answer) continue
    cards.push({
      id: `card-${stableHash(`${sourcePath}\u0000${question}\u0000${answer}`)}`,
      question,
      answer,
      sourcePath,
      line: index + 1
    })
    index += 1
  }
  return cards
}

export function initialReviewState(cardId: string, now = Date.now()): FlashcardReviewState {
  return { cardId, dueAt: now, intervalDays: 0, ease: 2.5, repetitions: 0 }
}

export function scheduleReview(
  current: FlashcardReviewState,
  grade: FlashcardGrade,
  now = Date.now()
): FlashcardReviewState {
  let repetitions = current.repetitions
  let ease = current.ease
  let intervalDays = current.intervalDays
  if (grade === 'again') {
    repetitions = 0
    intervalDays = 0
    ease = Math.max(1.3, ease - 0.2)
  } else {
    repetitions += 1
    ease = Math.max(1.3, ease + (grade === 'easy' ? 0.15 : grade === 'hard' ? -0.15 : 0))
    if (grade === 'hard') intervalDays = Math.max(1, Math.round(Math.max(1, intervalDays) * 1.2))
    else if (repetitions === 1) intervalDays = grade === 'easy' ? 4 : 1
    else if (repetitions === 2) intervalDays = grade === 'easy' ? 8 : 6
    else intervalDays = Math.max(1, Math.round(intervalDays * ease * (grade === 'easy' ? 1.3 : 1)))
  }
  const dueAt = grade === 'again' ? now + 10 * 60_000 : now + intervalDays * 86_400_000
  return { cardId: current.cardId, dueAt, intervalDays, ease, repetitions, lastReviewedAt: now }
}
