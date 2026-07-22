import { describe, expect, it } from 'vitest'

import { initialReviewState, parseFlashcards, scheduleReview } from '../../src/plugins/flashcards/flashcard-utils'

describe('Markdown flashcards', () => {
  it('extracts only adjacent Q and A pairs with stable source lines', () => {
    const cards = parseFlashcards('# Topic\n\nQ:: What is RAG?\nA:: Retrieval augmented generation.\n\nQ:: incomplete', '/project/cards.md')
    expect(cards).toHaveLength(1)
    expect(cards[0]).toMatchObject({ question: 'What is RAG?', answer: 'Retrieval augmented generation.', line: 3 })
    expect(parseFlashcards('Q:: What is RAG?\nA:: Retrieval augmented generation.', '/project/cards.md')[0]?.id).toBe(cards[0]?.id)
  })

  it('schedules again soon and expands successful intervals', () => {
    const now = Date.UTC(2026, 6, 23)
    const initial = initialReviewState('card-1', now)
    expect(scheduleReview(initial, 'again', now)).toMatchObject({ repetitions: 0, dueAt: now + 600_000 })
    const first = scheduleReview(initial, 'good', now)
    const second = scheduleReview(first, 'good', now + 86_400_000)
    expect(first.intervalDays).toBe(1)
    expect(second.intervalDays).toBe(6)
  })
})
