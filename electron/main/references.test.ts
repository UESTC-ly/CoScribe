import { describe, expect, it, vi } from 'vitest'

import { crossrefReference, ReferenceMetadataService } from './references'

describe('Crossref reference lookup', () => {
  it('maps bounded Crossref fields to the portable reference contract', () => {
    expect(crossrefReference({
      type: 'journal-article',
      title: ['A grounded paper'],
      author: [{ given: 'Ada', family: 'Smith' }],
      published: { 'date-parts': [[2025, 2, 1]] },
      'container-title': ['Journal of Tests'],
      DOI: '10.1000/test',
      URL: 'https://doi.org/10.1000/test',
      abstract: '<jats:p>Evidence first.</jats:p>'
    })).toEqual({
      type: 'article', title: 'A grounded paper', authors: ['Ada Smith'], year: 2025,
      journal: 'Journal of Tests', doi: '10.1000/test', url: 'https://doi.org/10.1000/test',
      abstract: 'Evidence first.', tags: []
    })
  })

  it('encodes the DOI path and rejects malformed identifiers before the network', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ message: { title: ['Paper'], DOI: '10.1000/test' } }), { status: 200 }))
    const service = new ReferenceMetadataService(fetcher as typeof fetch)
    await expect(service.lookupDoi('https://doi.org/10.1000/test')).resolves.toMatchObject({ title: 'Paper' })
    expect(fetcher).toHaveBeenCalledWith('https://api.crossref.org/works/10.1000%2Ftest', expect.any(Object))
    await expect(service.lookupDoi('../etc/passwd')).rejects.toThrow(/有效 DOI/u)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
