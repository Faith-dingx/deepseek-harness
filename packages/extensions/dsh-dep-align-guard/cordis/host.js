// dsh-dep-align-guard — host half, PLAIN-JAVASCRIPT function body for cordis_define.
//
// 用法: 把本文件的全部内容（不含本顶部注释）原样粘贴到 cordis_define 的
// code.host 参数。code.host 是一个 async 函数体（host-runner 会把它包进
// `(async () => {...})()` 执行），所以这里以 `return { ... }` 开头直接返回
// 一个 Cordis Plugin 对象，不写任何 import/require（沙箱内不可用）。
//
// 逻辑与静态包 @deepseek-ai/dsh-dep-align-guard 的 src/index.ts 一致:
//  - 监听 tools/pre-execute（host 级，覆盖主 agent 与所有子代理）
//  - 检测依赖操作: pnpm 子命令（install/deploy/add/remove/update/link/rebuild/
//    dedupe/prune）或受管清单文件被写（package.json / pnpm-lock.yaml /
//    pnpm-workspace.yaml / .npmrc / node_modules/.pnpm-workspace-state-v1.json /
//    node_modules/.modules.yaml）
//  - 操作前提醒（logger，不阻断）; 操作后（tools/post-execute）执行对齐校验:
//      ① node_modules/.pnpm-workspace-state-v1.json 的 settings.dev === true
//      ② node_modules/.bin/lefthook 存在
//      ③ lockfile 一致性（frozen-lockfile dry-run）——沙箱无 child_process，
//         动态半场固定 'skipped'，该判据由静态包执行
//  - 未对齐 → 按 agent 粒度阻断后续工具调用（返回 { kind: 'deny', reason }），
//    只放行 `CI=true pnpm install` 对齐命令; 对齐恢复后自动解除阻断
//  - 告警: 写入 config.alertDir/dep-misaligned.json（沙箱无 process/home 解析，
//    需显式配置 alertDir; 未配置则仅日志）
//
// 沙箱限制（cordis-host-runner sandbox.ts）: 无 require/process/Buffer/fetch/
// timers。文件访问通过 ctx.fs（@deepseek-ai/dsh-fs 服务，resolve/stat/
// readText/writeText）; 若宿主未提供 fs 服务，动态半场降级为"只提醒不校验"
// （fail-open 并大声记录）——一个无法验证的半场绝不能砸系统。
//
// 注意: cordis_define 只校验语法并保存源码，不运行；注册后需再调 cordis_run
// 激活。静态包（src/index.ts → lib）才是权威实现，本文件是沙箱可用镜像。

return {
  name: 'dsh-dep-align-guard',
  apply(ctx, config) {
    const cfg = config || {}
    const workspaceRoot = cfg.workspaceRoot || ''
    const alertDir = cfg.alertDir || ''
    const PNPM_ACTIONS = ['install', 'deploy', 'add', 'remove', 'update', 'link', 'rebuild', 'dedupe', 'prune']
    const GUARDED_FILES = [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      'node_modules/.pnpm-workspace-state-v1.json',
      'node_modules/.modules.yaml',
    ]
    const SCRIPT_WORDS = new Set(['run', 'exec', 'dlx', 'x'])
    const FLAG_WITH_VALUE = new Set(['-C', '--dir', '--cwd', '-F', '--filter', '--config', '--reporter'])
    const SHELL_TOOLS = new Set(['bash', 'terminal_send'])
    const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
    const REASON = '依赖未对齐，请先运行 CI=true pnpm install'

    // 按 agent 粒度的阻断表（host 内存，重启清零）。
    const blockedByAgent = new Map()
    const incidents = []

    // --- 解析纯函数（与 src/index.ts 逐字对齐） ---
    const scanPnpmArgs = (after) => {
      const tokens = after.split(/\s+/).filter((t) => t.length > 0)
      let i = 0
      while (i < tokens.length) {
        const token = tokens[i]
        if (token === '&&' || token === ';' || token === '|' || token === '||' || token.startsWith('(')) return null
        if (token.startsWith('--') && token.includes('=')) { i += 1; continue }
        if (FLAG_WITH_VALUE.has(token)) { i += 2; continue }
        if (token.startsWith('-')) { i += 1; continue }
        if (SCRIPT_WORDS.has(token)) return null
        if (PNPM_ACTIONS.includes(token)) return token
        return null
      }
      return null
    }

    const detectPnpmOperations = (command) => {
      const found = []
      const re = /\b(?:corepack\s+)?pnpm(?:@[^\s]+)?\b/g
      let m
      while ((m = re.exec(command)) !== null) {
        const after = command.slice((m.index || 0) + m[0].length)
        const op = scanPnpmArgs(after)
        if (op !== null) found.push(op)
      }
      return found
    }

    const detectPnpmOperation = (command) => {
      const all = detectPnpmOperations(command)
      return all.length > 0 ? all[0] : null
    }

    const detectGuardedFile = (target) => {
      if (typeof target !== 'string') return null
      const normalized = target.replace(/\\/g, '/').replace(/^\.\//, '')
      for (const name of GUARDED_FILES) {
        if (normalized === name || normalized.endsWith('/' + name)) return name
      }
      return null
    }

    const pathFieldOf = (args) => {
      if (typeof args !== 'object' || args === null) return undefined
      const candidate = typeof args.file_path === 'string' ? args.file_path : args.path
      return typeof candidate === 'string' ? candidate : undefined
    }

    const detectDepOperation = (exec) => {
      const args = exec.arguments
      if (SHELL_TOOLS.has(exec.name)) {
        const command = (typeof args === 'object' && args !== null)
          ? (args.command !== undefined ? args.command : args.text)
          : undefined
        if (typeof command === 'string') {
          const action = detectPnpmOperation(command)
          if (action !== null) return { kind: 'shell', target: action }
        }
        return null
      }
      if (FILE_TOOLS.has(exec.name)) {
        const pathArgument = pathFieldOf(args)
        if (pathArgument === undefined) return null
        const matched = detectGuardedFile(pathArgument)
        if (matched !== null) return { kind: 'file', target: matched }
      }
      return null
    }

    const isAlignmentCommand = (command) => {
      if (!/\bCI\s*=\s*true\b/i.test(command)) return false
      const ops = detectPnpmOperations(command)
      return ops.length > 0 && ops.every((op) => op === 'install')
    }

    const agentKeyOf = (exec) => {
      if (exec.agent !== undefined) return String(exec.agent.id)
      return 'no-agent:' + String(exec.rootCallId !== undefined ? exec.rootCallId : exec.callId)
    }

    const isAlignmentCommandArg = (exec) => {
      const args = exec.arguments
      if (typeof args !== 'object' || args === null) return false
      const command = typeof args.command === 'string' ? args.command : args.text
      return typeof command === 'string' && isAlignmentCommand(command)
    }

    // --- 对齐校验（仅通过 ctx.fs，宿主未提供则 fail-open + 日志） ---
    const fsApi = (ctx.fs && typeof ctx.fs.resolve === 'function' && typeof ctx.fs.stat === 'function'
      && typeof ctx.fs.readText === 'function' && typeof ctx.fs.writeText === 'function') ? ctx.fs : null

    const nmDir = workspaceRoot.length > 0 ? workspaceRoot + '/node_modules' : ''

    const runAlignmentCheck = async () => {
      const details = []
      if (fsApi === null) {
        return {
          aligned: true,
          nodeModulesAbsent: true,
          devFlag: 'missing',
          lefthook: 'missing',
          lockfile: 'skipped',
          details: ['沙箱无 ctx.fs 服务，动态半场无法校验对齐（fail-open）'],
        }
      }
      if (workspaceRoot.length === 0) {
        return {
          aligned: true,
          nodeModulesAbsent: true,
          devFlag: 'missing',
          lefthook: 'missing',
          lockfile: 'skipped',
          details: ['未配置 workspaceRoot，跳过对齐校验（fail-open）'],
        }
      }
      let nodeModulesAbsent = false
      try {
        const target = await fsApi.resolve(nmDir)
        const info = await fsApi.stat(target)
        nodeModulesAbsent = !(info && info.type === 'directory')
      } catch (e) {
        nodeModulesAbsent = true
      }
      let devFlag = 'missing'
      if (!nodeModulesAbsent) {
        try {
          const stateTarget = await fsApi.resolve(nmDir + '/.pnpm-workspace-state-v1.json')
          const text = await fsApi.readText(stateTarget)
          const parsed = JSON.parse(text)
          const settings = parsed && parsed.settings
          if (settings && typeof settings.dev === 'boolean') devFlag = settings.dev ? 'dev' : 'nondev'
        } catch (e2) {
          devFlag = 'missing'
        }
      }
      let lefthook = 'missing'
      if (!nodeModulesAbsent) {
        try {
          const binTarget = await fsApi.resolve(nmDir + '/.bin/lefthook')
          const info = await fsApi.stat(binTarget)
          lefthook = info !== undefined ? 'present' : 'missing'
        } catch (e3) {
          lefthook = 'missing'
        }
      }
      // 判据③（dry-run）在沙箱不可用（无 child_process），固定 skipped。
      let aligned = true
      if (!nodeModulesAbsent) {
        if (devFlag !== 'dev') details.push('判据① settings.dev=' + devFlag + '（期望 true）')
        if (lefthook !== 'present') details.push('判据② node_modules/.bin/lefthook=' + lefthook + '（期望存在）')
        aligned = devFlag === 'dev' && lefthook === 'present'
      } else {
        details.push('node_modules 不存在（全新安装阶段，豁免阻断）')
      }
      return { aligned, nodeModulesAbsent, devFlag, lefthook, lockfile: 'skipped', details }
    }

    const writeAlert = async (record) => {
      try {
        if (fsApi === null || alertDir.length === 0) {
          console.log('[dsh-dep-align-guard] alert skipped (no fs or alertDir): ' + JSON.stringify(record))
          return
        }
        await fsApi.resolve(alertDir)
        const payload = { updatedAt: new Date().toISOString(), incidents }
        const target = await fsApi.resolve(alertDir + '/dep-misaligned.json')
        await fsApi.writeText(target, JSON.stringify(payload, null, 2) + '\n')
        console.log('[dsh-dep-align-guard] alert written to ' + alertDir + '/dep-misaligned.json')
      } catch (e) {
        console.log('[dsh-dep-align-guard] alert write failed: ' + String(e))
      }
    }

    // --- 事件钩子 ---
    ctx.on('tools/pre-execute', (exec, next) => {
      const key = agentKeyOf(exec)
      const block = blockedByAgent.get(key)
      if (block !== undefined) {
        if (isAlignmentCommandArg(exec)) {
          console.log('[dsh-dep-align-guard] allow alignment command for blocked agent=' + key)
          return next()
        }
        return { kind: 'deny', reason: REASON + '（阻断时间 ' + new Date(block.since).toISOString() + '）' }
      }
      const op = detectDepOperation(exec)
      if (op === null) return next()
      console.log('[dsh-dep-align-guard] 依赖操作 ' + (op.kind === 'shell' ? 'pnpm ' : '') + op.target
        + '（agent=' + key + '）：完成后将校验对齐状态')
      return next()
    })

    ctx.on('tools/post-execute', async (exec, result, next) => {
      const op = detectDepOperation(exec)
      if (op === null) return next()

      const key = agentKeyOf(exec)
      const report = await runAlignmentCheck()
      const wasBlocked = blockedByAgent.has(key)
      const decision = await next()

      if (report.aligned) {
        if (wasBlocked) {
          blockedByAgent.delete(key)
          console.log('[dsh-dep-align-guard] 对齐恢复，解除 agent=' + key + ' 的阻断')
        }
        return decision
      }
      if (!wasBlocked) {
        blockedByAgent.set(key, { since: Date.now(), report })
        const record = {
          timestamp: new Date().toISOString(),
          agent: key,
          tool: exec.name,
          operation: op.target,
          workspaceRoot,
          devFlag: report.devFlag,
          lefthook: report.lefthook,
          lockfile: report.lockfile,
          details: report.details,
        }
        incidents.push(record)
        void writeAlert(record)
        console.log('[dsh-dep-align-guard] 对齐校验未通过，阻断 agent=' + key + '：' + report.details.join('；'))
      }
      return decision
    })
  },
}
