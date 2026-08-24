// dsh-memory-guard — host half, PLAIN-JAVASCRIPT function body for cordis_define.
//
// 用法: 把本文件的全部内容（不含本顶部注释）原样粘贴到 cordis_define 的
// code.host 参数。code.host 是一个 async 函数体（host-runner 会把它包进
// `(async () => {...})()` 执行），所以这里以 `return { ... }` 开头直接返回
// 一个 Cordis Plugin 对象，不写任何 import/require（沙箱内不可用）。
//
// 逻辑与静态包 @deepseek-ai/dsh-memory-guard 的 src/index.ts 一致:
//  - 监听 tools/pre-execute（host 级，覆盖主 agent 与所有子代理）
//  - 工具名属于记忆写入类 且 payload 含裸 {{ 或 }} 字面量 → 拒绝
//    （返回 { kind: 'deny', reason }，reason 明确提示怎么改）
//  - 安全 → 放行（返回 next()）
//  - 管理工具 memory 的只读 action（read/缺省）放行
//
// 注意: cordis_define 只校验语法并保存源码，不运行；注册后需再调 cordis_run
// 激活。

return {
  name: 'dsh-memory-guard',
  apply(ctx) {
    const WRITE_TOOLS = new Set([
      'memory_log', 'memory_note', 'memory_user', 'memory_reflect',
      'memory_consolidate', 'memory_maintain', 'memory_external', 'memory',
      'calendar_add', 'calendar_done', 'calendar_remove',
    ])
    const PATTERN = '\\{\\{[^}]*\\}\\}|\\{\\{'

    // 反引号内的内容是可放行的转义形式（如 `{{commit}}`），不参与扫描。
    // 反引号须成对：最后一个未闭合的反引号后的内容仍是普通文本，必须扫描
    // （否则裸 {{commit}} 会被漏检，fail-open）。
    const scanSegments = (text) => {
      const parts = text.split('`')
      const outside = []
      for (let i = 0; i < parts.length; i++) {
        const isInside = i % 2 === 1 && i + 1 < parts.length
        if (!isInside) outside.push(parts[i])
      }
      return outside
    }

    // 只扫描每个 STRING 字段值，不扫描整段 JSON——
    // 嵌套对象的 JSON 收尾会自带 }}，整段扫描会误伤。
    const scanBraceLiterals = (args, source) => {
      const matches = []
      const paths = []
      const re = new RegExp(source, 'g')
      const walk = (value, path) => {
        if (matches.length >= 3) return
        if (typeof value === 'string') {
          const hits = []
          for (const segment of scanSegments(value)) {
            re.lastIndex = 0
            const found = segment.match(re)
            if (found) hits.push(...found)
          }
          if (hits.length > 0) {
            matches.push(...hits.slice(0, 3 - matches.length))
            paths.push(path || '(root)')
          }
          return
        }
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) walk(value[i], path + '[' + i + ']')
          return
        }
        if (typeof value === 'object' && value !== null) {
          for (const key of Object.keys(value)) {
            walk(value[key], path === '' ? key : path + '.' + key)
          }
        }
      }
      walk(args, '')
      return { matches: matches.slice(0, 3), paths: paths.slice(0, 5) }
    }

    const isMemoryWriteAction = (args) => {
      if (typeof args !== 'object' || args === null) return false
      const action = args.action
      return typeof action === 'string' && ['add', 'update', 'rewrite', 'delete'].includes(action)
    }

    ctx.on('tools/pre-execute', (exec, next) => {
      const toolName = exec.name
      if (!WRITE_TOOLS.has(toolName)) return next()
      if (toolName === 'memory' && !isMemoryWriteAction(exec.arguments)) return next()
      const scan = scanBraceLiterals(exec.arguments, PATTERN)
      if (scan.matches.length === 0) return next()
      const samples = scan.matches.map((m) => JSON.stringify(m)).join(', ')
      const locations = scan.paths.length > 0 ? '参数路径: ' + scan.paths.join('; ') : ''
      const reason = '记忆禁止写 {{xxx}} 字面量 (工具 ' + toolName + ' 检测到: ' + samples + '; ' + locations + ')，请去掉花括号，或需要描述占位符时用反引号包裹（如 `{{commit}}` 而不是裸 {{commit}}）'
      console.log('[dsh-memory-guard] deny tool=' + toolName + ' matches=' + JSON.stringify(scan.matches))
      return { kind: 'deny', reason }
    })
  },
}