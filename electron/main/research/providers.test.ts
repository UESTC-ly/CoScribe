import { describe, expect, it, vi } from 'vitest'
import { arxivCandidates, githubCandidates, ResearchProviders, responseBytes, sourceUrl } from './providers'

const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2601.01234v2</id><title>Graph &amp; Drug Discovery</title><author><name>Ada Smith</name></author><published>2026-01-02T00:00:00Z</published><summary>Grounded abstract evidence.</summary><arxiv:doi>10.1000/graph</arxiv:doi></entry></feed>'
describe('bounded research providers', () => {
  it('parses arXiv evidence metadata and canonical PDF addresses without trusting link attributes', () => {
    expect(arxivCandidates(atom, 5)[0]).toMatchObject({ source: 'arxiv', sourceId: '2601.01234v2', pdfUrl: 'https://arxiv.org/pdf/2601.01234v2', reference: { title: 'Graph & Drug Discovery', authors: ['Ada Smith'], year: 2026, doi: '10.1000/graph', abstract: 'Grounded abstract evidence.' } })
    expect(() => arxivCandidates('<!DOCTYPE feed [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + atom, 5)).toThrow('格式无效')
    expect(arxivCandidates(atom.replace('2601.01234v2', '../escape'), 5)).toEqual([])
  })
  it('accepts only canonical GitHub repository identities', () => {
    expect(githubCandidates({ items: [{ full_name: 'owner/project', html_url: 'https://github.com/owner/project', description: 'Readme data', language: 'Python' }, { full_name: 'owner/../escape', html_url: 'https://evil.test' }, { full_name: 'owner/other', html_url: 'https://evil.test' }] }, 5)).toHaveLength(1)
  })
  it('rejects private, credential-bearing and cross-provider redirects before fetching their destinations', async () => {
    for (const address of ['http://arxiv.org/pdf/a', 'https://127.0.0.1/file', 'https://user:secret@api.github.com/repos/a/b', 'https://arxiv.org:444/pdf/a', 'https://arxiv.org.evil.test/']) expect(() => sourceUrl(address)).toThrow()
    const fetcher = vi.fn(async () => new Response('', { status: 302, headers: { Location: 'https://127.0.0.1/private' } }))
    await expect(new ResearchProviders(fetcher as typeof fetch).fetch('https://api.github.com/search/repositories', new AbortController().signal)).rejects.toThrow('允许')
    expect(fetcher).toHaveBeenCalledTimes(1)
    fetcher.mockImplementation(async () => new Response('', { status: 302, headers: { Location: 'https://api.crossref.org/works' } }))
    await expect(new ResearchProviders(fetcher as typeof fetch).fetch('https://api.github.com/search/repositories', new AbortController().signal)).rejects.toThrow('边界')
  })
  it('caps streamed and declared response sizes and bounds HTTP redirects', async () => {
    await expect(responseBytes(new Response('12345'), 4)).rejects.toThrow('上限')
    await expect(responseBytes(new Response('1', { headers: { 'Content-Length': '100' } }), 4)).rejects.toThrow('上限')
    const fetcher = vi.fn(async () => new Response('', { status: 302, headers: { Location: '/next' } }))
    await expect(new ResearchProviders(fetcher as typeof fetch).fetch('https://arxiv.org/pdf/a', new AbortController().signal)).rejects.toThrow('次数')
    expect(fetcher).toHaveBeenCalledTimes(4)
  })
  it('restricts MCP research to one declared read-only search tool and normalizes its result', async () => {
    const invoke = vi.fn(async () => ({ kind: 'tool' as const, name: 'search_repositories', content: '', structuredContent: { items: [{ full_name: 'owner/repo', html_url: 'https://github.com/owner/repo' }] }, isError: false, durationMs: 1 }))
    const providers = new ResearchProviders(vi.fn() as unknown as typeof fetch, { invoke })
    await expect(providers.search('github', 'graph', 3, new AbortController().signal, 'official')).resolves.toHaveLength(1)
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ name: 'search_repositories', arguments: { query: 'graph', perPage: 3, minimal_output: false } }), expect.objectContaining({ readOnly: true }))
  })
  it('honors an already-cancelled request without network calls', async () => {
    const fetcher = vi.fn()
    const controller = new AbortController(); controller.abort()
    await expect(new ResearchProviders(fetcher).fetch('https://arxiv.org/pdf/2601.00001', controller.signal)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
})
