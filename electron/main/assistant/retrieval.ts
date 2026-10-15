import type { MemorySearchHit } from '../../../src/shared/assistant'

export function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0
  let dot = 0
  let a = 0
  let b = 0
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!
    a += left[index]! ** 2
    b += right[index]! ** 2
  }
  return a && b ? dot / Math.sqrt(a * b) : 0
}

// Reciprocal rank fusion avoids comparing the unrelated BM25/cosine scales.
// An exact lexical hit survives even when its embedding is not available yet.
export function fuseMemoryHits(lexical: MemorySearchHit[], semantic: MemorySearchHit[], limit: number): MemorySearchHit[] {
  const hits = new Map<string, MemorySearchHit>()
  for (const list of [lexical, semantic]) list.forEach((hit, index) => {
    const key = hit.kind + ':' + hit.id
    const previous = hits.get(key)
    hits.set(key, { ...hit, score: (previous?.score ?? 0) + 1 / (60 + index + 1) })
  })
  return [...hits.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
}
