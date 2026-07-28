import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const globalStylesPath = resolve(process.cwd(), 'src/styles/global.css')

async function readGlobalStyles(): Promise<string> {
  return readFile(globalStylesPath, 'utf8')
}

describe('interactive cursor contract', () => {
  it('keeps pointer feedback on semantic controls and their hit-tested descendants', async () => {
    const styles = await readGlobalStyles()

    expect(styles).toContain("button:not(:disabled)")
    expect(styles).toContain("[role='button']:not([aria-disabled='true'])")
    expect(styles).toContain("[role='tab']:not([aria-disabled='true'])")
    expect(styles).toContain("[role='option']:not([aria-disabled='true'])")
    expect(styles).toMatch(/cursor:\s*pointer\s*!important;/u)
    expect(styles).toMatch(/\)\s*:where\(\*\)\s*\{\s*cursor:\s*pointer\s*!important;/u)
  })

  it('lets text entry and disabled controls override the pointer contract', async () => {
    const styles = await readGlobalStyles()
    const pointerRule = styles.indexOf('cursor: pointer !important')
    const textRule = styles.indexOf('cursor: text !important')
    const disabledRule = styles.indexOf('cursor: not-allowed')

    expect(pointerRule).toBeGreaterThan(-1)
    expect(textRule).toBeGreaterThan(pointerRule)
    expect(disabledRule).toBeGreaterThan(textRule)
    expect(styles).toMatch(/\):disabled,\s*:where\(\[aria-disabled='true'\]\)\s*\{\s*cursor:\s*not-allowed;/u)
    expect(styles).toContain(':where(button, input, select, textarea):disabled :where(*)')
    expect(styles).toContain(":where([aria-disabled='true']) :where(*)")
    expect(styles).toMatch(/cursor:\s*inherit\s*!important;/u)
  })
})
