#!/usr/bin/env node

/**
 * validate-inject.mjs — Cordis inject 合法性校验
 *
 * 扫描所有 extension 插件的 inject 数组/对象，对照 cordis 源码和 api-catalog
 * 验证每个服务名是否合法。发现非法值 → exit 1。
 *
 * 挂载点：lefthook pre-commit + P3 check-agent 强制步骤
 *
 * 「合法」判定（并集）：
 *   1. harness 服务：tool-cordis 生成目录 SERVICE_API 的 key
 *   2. client 服务：cordis-client-runner 目录 SERVICE_API 的 key
 *   3. cordis 核心服务：timer / loader / hmr（INHERITED_CTX_API 标注的运行期服务）
 *   4. 运行期服务：宿主/客户端运行时提供但未入目录的服务（见 RUNTIME_SERVICES）
 * 嵌套路径（remote.dynamicCordisRunner）只校验首段，其余段须为合法 JS 标识符。
 *
 * 用法：node scripts/validate-inject.mjs [--extensions-root <dir>]
 *          [--harness-catalog <file>] [--client-catalog <file>] [--json]
 * 退出码：0 = 全部合法；1 = 发现非法 inject；2 = 配置错误（目录缺失等）。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(scriptDir, '..')
const { values: options } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'extensions-root': { type: 'string' },
    'harness-catalog': { type: 'string' },
    'client-catalog': { type: 'string' },
    'json': { type: 'boolean' },
  },
})
const extensionsRoot = resolve(
  options['extensions-root'] ?? join(repoRoot, 'packages/extensions'),
)
const harnessCatalogPath = resolve(
  options['harness-catalog'] ?? join(extensionsRoot, 'tool-cordis/src/generated/api-catalog.ts'),
)
const clientCatalogPath = resolve(
  options['client-catalog'] ?? join(extensionsRoot, 'cordis-client-runner/src/client/api-catalog.ts'),
)
const jsonMode = options['json'] === true

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const SEP = '/'

/**
 * Cordis 核心服务：INHERITED_CTX_API 标注为运行期提供的可注入服务。
 * - ctx.timer（+ interval / timeout / throttle / debounce）：provided at runtime
 * - ctx.loader：present under the loader
 * - ctx.hmr：present under the hmr plugin
 */
const CORE_SERVICES = new Set(['timer', 'loader', 'hmr'])

/**
 * 运行期由宿主/客户端提供、但未进 api-catalog SERVICE_API 的可注入服务。
 * 新增这类服务时必须在此登记，否则会被误报为非法：
 * - dynamicCordisRunner：cordis-host-runner DynamicCordisRunnerService；
 *   client runner ctx.provide('dynamicCordisRunner')
 * - cordisInspect：cordis-host-runner CordisInspectRegistryService；
 *   client runner ctx.provide('cordisInspect')
 * - modules：packages/client/modules ctx.reflect.provide('modules')
 * - remote：client 运行时提供（client-runtime / ui 会话层）
 * - inputTriggers：packages/client/ui-input-trigger 服务契约
 */
const RUNTIME_SERVICES = new Set([
  'dynamicCordisRunner',
  'cordisInspect',
  'modules',
  'remote',
  'inputTriggers',
])

function terminate(message, exitCode) {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok: false, exitCode, message })}\n`)
  } else {
    process.stderr.write(`${message}\n`)
  }
  process.exit(exitCode)
}

function readCatalog(path, label) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    terminate(
      `validate-inject: 无法读取 ${label}（${path}）。`
        + '请检查 api-catalog 迁移状态，或用 --harness-catalog / --client-catalog 覆盖路径。',
      2,
    )
  }
}

/** 从 SERVICE_API 数组块提取每个条目的 key（条目开头为 { 换行 key: '...'）。 */
function serviceKeys(catalogText) {
  const keys = new Set()
  const entry = /\{\s*\n\s*key: '([^']+)'/g
  for (const match of catalogText.matchAll(entry)) keys.add(match[1])
  return keys
}

/**
 * 把字符串/注释替换为等长空格（保留换行），使声明级正则只在真实代码上命中，
 * 同时保持与原文相同的偏移与行号。
 */
function sanitize(source) {
  let out = ''
  let i = 0
  const n = source.length
  while (i < n) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      out += '  '
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += '  '
        i += 2
      }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c
      out += ' '
      i++
      while (i < n) {
        if (source[i] === '\\') {
          out += '  '
          i += 2
          continue
        }
        if (source[i] === quote) {
          out += ' '
          i++
          break
        }
        out += source[i] === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

/** 收集扩展包 src/ 下的 .ts 源码文件（跳过 node_modules / lib / 符号链接 / spec / 声明文件）。 */
function collectSourceFiles(root) {
  const files = []
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      terminate(`validate-inject: 无法读取扩展目录（${dir}）。请检查 --extensions-root。`, 2)
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === '.git') continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else if (
        entry.name.endsWith('.ts')
        && !entry.name.endsWith('.d.ts')
        && !entry.name.endsWith('.spec.ts')
        && path.includes(`${SEP}src${SEP}`)
      ) {
        files.push(path)
      }
    }
  }
  walk(root)
  return files.sort()
}

/** 从 openIdx（'[' 或 '{'）找匹配的闭合括号；返回闭合下标，未闭合返回 -1。 */
function matchClosing(text, openIdx) {
  const open = text[openIdx]
  const close = open === '[' ? ']' : '}'
  let depth = 1
  let i = openIdx + 1
  let quote = null
  while (i < text.length) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i += 2
      else {
        if (c === quote) quote = null
        i++
      }
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      i++
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i += 2
      continue
    }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return i
    }
    i++
  }
  return -1
}

/** 按顶层逗号切分（跳过字符串/注释/嵌套）。 */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let quote = null
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
      continue
    }
    if (c === '[' || c === '{' || c === '(') depth++
    else if (c === ']' || c === '}' || c === ')') depth--
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

/** 解析数组字面量元素：必须是字符串字面量。返回 { values } 或 { structural }。 */
function parseArrayElement(element) {
  const trimmed = element.trim()
  if (trimmed === '') return { value: undefined }
  const match = trimmed.match(/^(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")$/)
  if (!match) return { structural: `数组元素必须是字符串字面量（发现 '${trimmed.slice(0, 40)}'）` }
  return { value: match[1] ?? match[2] }
}

/** 解析对象字面量段（key: value）：返回 { value } 或 { structural }。 */
function parseObjectSegment(segment) {
  let depth = 0
  let quote = null
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      continue
    }
    if (c === '[' || c === '{' || c === '(') depth++
    else if (c === ']' || c === '}' || c === ')') depth--
    else if (c === ':' && depth === 0) {
      let key = segment.slice(0, i).trim()
      if (key === '') return { structural: '对象键为空' }
      const quoted = key.match(/^'(?:\\.|[^'\\])*'$|^"(?:\\.|[^"\\])*"$/)
      if (quoted) key = key.slice(1, -1)
      if (key.includes('[')) return { structural: `不支持计算键（${key}）` }
      return { value: key }
    }
  }
  return { structural: `对象元素缺少 ':'（${segment.trim().slice(0, 40)}）` }
}

/** 校验服务路径（identifier(.identifier)*），返回错误信息或 null。 */
function pathError(name) {
  if (name.length === 0) return 'inject 值为空字符串'
  const segments = name.split('.')
  for (const segment of segments) {
    if (!IDENTIFIER.test(segment)) {
      return `'${name}' 含非法路径段 '${segment}'（每段须为合法 JS 标识符）`
    }
  }
  return null
}

const harnessCatalog = readCatalog(harnessCatalogPath, 'harness api-catalog')
const clientCatalog = readCatalog(clientCatalogPath, 'client api-catalog')
const known = new Set([
  ...serviceKeys(harnessCatalog),
  ...serviceKeys(clientCatalog),
  ...CORE_SERVICES,
  ...RUNTIME_SERVICES,
])

const sourceFiles = collectSourceFiles(extensionsRoot)
const failures = []
let declarationCount = 0

const declRe = /\b(?:export\s+const|static)\s+inject\s*(?::[^=]*)?=/g

for (const file of sourceFiles) {
  const source = readFileSync(file, 'utf8')
  const sanitized = sanitize(source)
  declRe.lastIndex = 0
  let match
  while ((match = declRe.exec(sanitized)) !== null) {
    declarationCount++
    const line = source.slice(0, match.index).split('\n').length
    const relative = file.startsWith(extensionsRoot) ? file.slice(extensionsRoot.length + 1) : file
    let cursor = match.index + match[0].length
    while (cursor < sanitized.length && /\s/.test(sanitized[cursor])) cursor++
    const open = sanitized[cursor]
    let names = []
    if (open === '[') {
      const close = matchClosing(source, cursor)
      if (close === -1) {
        failures.push({ file: relative, line, message: '数组字面量未闭合' })
        continue
      }
      const body = source.slice(cursor + 1, close)
      for (const element of splitTopLevel(body)) {
        const parsed = parseArrayElement(element)
        if (parsed.structural) {
          failures.push({ file: relative, line, message: parsed.structural })
        } else if (parsed.value !== undefined) {
          names.push(parsed.value)
        }
      }
    } else if (open === '{') {
      const close = matchClosing(source, cursor)
      if (close === -1) {
        failures.push({ file: relative, line, message: '对象字面量未闭合' })
        continue
      }
      const body = source.slice(cursor + 1, close)
      for (const segment of splitTopLevel(body)) {
        const parsed = parseObjectSegment(segment)
        if (parsed.structural) {
          failures.push({ file: relative, line, message: parsed.structural })
        } else {
          names.push(parsed.value)
        }
      }
    } else {
      const shown = open === undefined || open === '' ? '文件末尾' : `'${open}'`
      failures.push({ file: relative, line, message: `inject 声明必须为数组或对象字面量（发现 ${shown}）` })
      continue
    }

    const seen = new Set()
    for (const name of names) {
      const duplicate = seen.has(name)
      seen.add(name)
      if (duplicate) {
        failures.push({ file: relative, line, message: `inject 内重复声明服务 '${name}'` })
        continue
      }
      const pathIssue = pathError(name)
      if (pathIssue) {
        failures.push({ file: relative, line, message: pathIssue })
        continue
      }
      const first = name.split('.')[0]
      if (!known.has(first)) {
        failures.push({
          file: relative,
          line,
          message: `'${name}' 不是已知服务（首段 '${first}' 不在 api-catalog SERVICE_API / `
            + 'cordis 核心（timer/loader/hmr）/ RUNTIME_SERVICES 中）。'
            + '若为新增运行期服务，请在脚本 RUNTIME_SERVICES 登记。',
        })
      }
    }
  }
}

function knownSummary() {
  return `已知服务 ${known.size} 个（api-catalog harness+client ∪ cordis 核心 ∪ RUNTIME_SERVICES）`
}

if (failures.length > 0) {
  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      exitCode: 1,
      scannedFiles: sourceFiles.length,
      declarations: declarationCount,
      failures,
    })}\n`)
  } else {
    process.stdout.write('validate-inject.mjs — Cordis inject 合法性校验\n')
    process.stdout.write(`扫描 ${sourceFiles.length} 个文件、${declarationCount} 处 inject 声明\n`)
    for (const failure of failures) {
      process.stdout.write(`✗ ${failure.file}:${failure.line} — ${failure.message}\n`)
    }
    process.stdout.write(`结论：发现 ${failures.length} 处非法 inject（exit 1）。${knownSummary()}\n`)
  }
  process.exit(1)
}

if (jsonMode) {
  process.stdout.write(`${JSON.stringify({
    ok: true,
    exitCode: 0,
    scannedFiles: sourceFiles.length,
    declarations: declarationCount,
    failures,
  })}\n`)
} else {
  process.stdout.write('validate-inject.mjs — Cordis inject 合法性校验\n')
  process.stdout.write(`扫描 ${sourceFiles.length} 个文件、${declarationCount} 处 inject 声明\n`)
  process.stdout.write(`结论：全部合法（exit 0）。${knownSummary()}\n`)
}
process.exit(0)
