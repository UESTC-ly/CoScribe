import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
const appPath = path.resolve(process.argv[2] ?? 'release/mac-arm64/CoScribe.app')
const resourcesPath = path.join(appPath, 'Contents', 'Resources')
const asarPath = path.join(resourcesPath, 'app.asar')

if (!existsSync(asarPath)) {
  throw new Error(`找不到 macOS 成品：${asarPath}`)
}

const asarCli = require.resolve('@electron/asar/bin/asar.js')
const entries = execFileSync(process.execPath, [asarCli, 'list', asarPath], {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024
}).split(/\r?\n/u).filter(Boolean)
const entrySet = new Set(entries)

const requiredEntries = [
  '/node_modules/chokidar/package.json',
  '/node_modules/mammoth/package.json',
  '/node_modules/pdfjs-dist/legacy/build/pdf.mjs',
  '/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs',
  '/out/renderer/assets/ocr/models/PP-OCRv6_small_det_onnx_infer.tar',
  '/out/renderer/assets/ocr/models/PP-OCRv6_small_rec_onnx_infer.tar',
  '/out/renderer/assets/ocr/ort/ort-wasm-simd-threaded.jsep.mjs',
  '/out/renderer/assets/ocr/ort/ort-wasm-simd-threaded.jsep.wasm',
  '/resources/ocr/LICENSE-APACHE-2.0.txt'
]
const missing = requiredEntries.filter((entry) => !entrySet.has(entry))
if (missing.length) {
  throw new Error(`成品缺少运行文件：\n${missing.join('\n')}`)
}

const rendererOnlyPackages = [
  '@codemirror/commands',
  '@paddleocr/paddleocr-js',
  '@uiw/react-codemirror',
  'mermaid',
  'react',
  'react-dom',
  'react-markdown',
  'react-pdf'
]
const duplicated = rendererOnlyPackages.filter((name) =>
  entries.some((entry) => entry === `/node_modules/${name}` || entry.startsWith(`/node_modules/${name}/`))
)
if (duplicated.length) {
  throw new Error(`成品仍包含已打进 renderer bundle 的依赖：${duplicated.join(', ')}`)
}

const sourceMaps = entries.filter((entry) => entry.endsWith('.map'))
if (sourceMaps.length) {
  throw new Error(`成品仍包含 ${sourceMaps.length} 个 source map。`)
}

const executablePath = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'))
const runtimeProbe = [
  'const { pathToFileURL } = require("node:url")',
  'const root = process.argv[1]',
  'Promise.all([',
  '  import(pathToFileURL(root + "/node_modules/chokidar/index.js").href),',
  '  Promise.resolve(require(root + "/node_modules/mammoth/lib/index.js")),',
  '  import(pathToFileURL(root + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs").href)',
  ']).then(([chokidar, mammoth, pdfjs]) => {',
  '  if (typeof chokidar.watch !== "function" || typeof mammoth.extractRawText !== "function" || typeof pdfjs.getDocument !== "function") process.exit(2)',
  '}).catch((error) => { console.error(error); process.exit(1) })'
].join('\n')
execFileSync(executablePath, ['-e', runtimeProbe, asarPath], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'pipe'
})

const topLevelPackages = new Set(entries.flatMap((entry) => {
  const match = entry.match(/^\/node_modules\/(?:@[^/]+\/)?[^/]+/u)
  return match ? [match[0].slice('/node_modules/'.length)] : []
}))
const sizeMiB = statSync(asarPath).size / 1024 / 1024

console.log(`Packaging verification passed: ${sizeMiB.toFixed(1)} MiB app.asar, ${topLevelPackages.size} top-level runtime packages, 0 source maps, runtime imports loaded.`)
