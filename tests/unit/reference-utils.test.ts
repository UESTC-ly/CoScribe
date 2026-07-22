import { describe, expect, it } from 'vitest'

import {
  bibTeXFor,
  citationToken,
  mergeReferences,
  parseBibTeX,
  parseRis,
  referenceNoteMarkdown
} from '../../src/plugins/references/reference-utils'

describe('reference library utilities', () => {
  it('imports nested BibTeX fields without losing the citation key', () => {
    const [reference] = parseBibTeX(`@article{vaswani2017attention,
      title={Attention Is {All} You Need},
      author={Vaswani, Ashish and Shazeer, Noam},
      year={2017},
      journal={NeurIPS},
      doi={10.5555/3295222.3295349}
    }`, 100)

    expect(reference).toMatchObject({
      citeKey: 'vaswani2017attention',
      title: 'Attention Is All You Need',
      authors: ['Ashish Vaswani', 'Noam Shazeer'],
      year: 2017,
      journal: 'NeurIPS',
      doi: '10.5555/3295222.3295349'
    })
    expect(citationToken(reference)).toBe('[@vaswani2017attention]')
    expect(referenceNoteMarkdown(reference)).toContain('## 主要发现')
    expect(bibTeXFor(reference)).toContain('@article{vaswani2017attention')
  })

  it('imports RIS and merges DOI duplicates instead of duplicating records', () => {
    const [reference] = parseRis(`TY  - JOUR
TI  - Retrieval-Augmented Generation
AU  - Lewis, Patrick
PY  - 2020
DO  - https://doi.org/10.1000/rag
KW  - RAG
ER  -`, 200)
    expect(reference).toMatchObject({ title: 'Retrieval-Augmented Generation', authors: ['Patrick Lewis'], year: 2020, doi: '10.1000/rag' })
    const merged = mergeReferences([reference], [{ ...reference, id: 'incoming', notes: 'updated' }])
    expect(merged).toHaveLength(1)
    expect(merged[0].id).toBe(reference.id)
    expect(merged[0].notes).toBe('updated')
  })
})
