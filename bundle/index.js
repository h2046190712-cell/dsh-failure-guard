/**
 * loop-guard —— 工具调用的那道闸
 *
 * 三件事：
 * 1) 同一个调用（工具名 + 参数）反复撞同一个墙：第 N 次就拦下，告诉它「这条路不会自己变好」。
 * 2) 同一个工具连续失败到顶：熔断，冷却一段时间内直接拒，冷却后放一次试探。
 * 3) 失败回执里把「这是失败，不是结果」写清楚，别让模型拿报错当答案编下去。
 *
 * 另外给系统提示加一条常驻的地基话术（可以关）。
 */

export const name = 'loop-guard'

export const inject = ['tools', 'systemPrompt']

const DEFAULTS = {
  failThreshold: 3,
  cooldownMs: 60_000,
  repeatLimit: 3,
  repeatWindowMs: 10 * 60_000,
  grounding: true,
  exempt: ['windows_desktop'],
}

/** 稳定序列化：对象的键排序，避免 {a,b} 与 {b,a} 被当成两个调用。 */
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}'
}

function fingerprint(name, args) {
  let text = ''
  try {
    text = stable(args)
  } catch {
    text = String(args)
  }
  if (text.length > 4096) text = text.slice(0, 4096)
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return name + '#' + (h >>> 0).toString(36)
}

function nowMs() {
  return Date.now()
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...(config ?? {}) }
  const exempt = new Set(cfg.exempt ?? [])

  /** 熔断账：`agent|tool` -> { fails, openUntil, probes } */
  const breakers = new Map()
  /** 重复账：`agent|指纹` -> { count, firstAt, lastAt, denied } */
  const repeats = new Map()

  const agentOf = (exec) => String(exec?.agent?.id ?? 'shared')

  function pruneRepeats(t) {
    if (repeats.size < 512) return
    for (const [key, row] of repeats) {
      if (t - row.lastAt > cfg.repeatWindowMs) repeats.delete(key)
    }
  }

  function breakerCheck(agent, tool, t) {
    const key = agent + '|' + tool
    const row = breakers.get(key)
    if (!row) return { allowed: true }
    if (!row.openUntil) return { allowed: true }
    if (t >= row.openUntil) {
      // 冷却结束：放一次试探
      row.openUntil = 0
      row.probes += 1
      return { allowed: true, probe: true }
    }
    return {
      allowed: false,
      reason:
        `熔断中：工具 「${tool}」 已经连续失败 ${row.fails} 次，冷却还剩 ${Math.ceil((row.openUntil - t) / 1000)} 秒。` +
        '这期间再调同一个工具只会再失败一次。请改用别的办法；确实拿不到，就直接说「没拿到」，不要编。',
      code: 'CIRCUIT_OPEN',
    }
  }

  ctx.on('tools/pre-execute', async (exec, next) => {
    const tool = String(exec?.name ?? '')
    if (!tool || exempt.has(tool)) return next()

    const agent = agentOf(exec)
    const t = nowMs()

    // 1) 熔断
    const b = breakerCheck(agent, tool, t)
    if (!b.allowed) {
      return { kind: 'deny', reason: b.reason, info: { name: 'loop-guard', code: b.code } }
    }

    // 2) 同一个调用反复撞
    const fp = agent + '|' + fingerprint(tool, exec?.arguments)
    let row = repeats.get(fp)
    if (!row || t - row.firstAt > cfg.repeatWindowMs) {
      row = { count: 0, firstAt: t, lastAt: t, denied: false }
      repeats.set(fp, row)
    }
    row.count += 1
    row.lastAt = t
    pruneRepeats(t)

    if (row.denied || row.count > cfg.repeatLimit) {
      row.denied = true
      return {
        kind: 'deny',
        reason:
          `同一个调用（工具 「${tool}」 同一份参数）这已经是第 ${row.count} 次了，前 ${row.count - 1} 次的结果不会因为再来一次而改变。` +
          '换参数、换工具，或者停下来把情况说清楚。',
        info: { name: 'loop-guard', code: 'REPEAT_CALL' },
      }
    }

    return next()
  })

  ctx.on('tools/post-execute', async (exec, result, next) => {
    const tool = String(exec?.name ?? '')
    const agent = agentOf(exec)
    const t = nowMs()
    const decision = await next()

    if (!tool || exempt.has(tool)) return decision

    const failed = decision?.kind === 'accept' ? result?.isError === true : result?.isError === true

    if (!failed) {
      const key = agent + '|' + tool
      const row = breakers.get(key)
      if (row) {
        row.fails = 0
        row.openUntil = 0
        row.probes = 0
      }
      return decision
    }

    // 被我们自己拦下的不算「工具自己失败」，否则熔断会被自己的回执喂大
    if (result?.error?.info?.name === 'loop-guard') return decision

    // —— 失败：记账 + 改回执 ——
    const key = agent + '|' + tool
    let row = breakers.get(key)
    if (!row) {
      row = { fails: 0, openUntil: 0, probes: 0 }
      breakers.set(key, row)
    }
    row.fails += 1
    if (row.fails >= cfg.failThreshold && !row.openUntil) {
      row.openUntil = t + cfg.cooldownMs
    }

    const info = result?.error?.info
    const code = info?.code ?? 'ERROR'
    const held = row.openUntil && row.openUntil > t
    const note =
      `[loop-guard] 这次调用是失败的（工具 ${tool}，code=${code}），不是拿到了结果。` +
      '不要假设它成功，也不要拿这行报错当答案去编内容。' +
      '换参数或换工具再试；如果这条路已经试过两次，就改用文字说明你拿不到什么。' +
      (held ? ` 这个工具已达到连续失败 ${row.fails} 次，接下来 ${Math.ceil((row.openUntil - t) / 1000)} 秒内会被熔断拦下。` : '')

    const base = decision?.kind === 'accept' ? (decision.content ?? result?.content ?? []) : result?.content ?? []
    return { kind: 'accept', content: [...base, { type: 'text', text: note }] }
  })

  if (cfg.grounding !== false) {
    let order = 100
    try {
      order = ctx.systemPrompt.getContextOrder?.('memory')
      if (typeof order !== 'number') order = 100
    } catch {
      order = 100
    }
    ctx.systemPrompt.context({
      name: 'loop-guard.grounding',
      order,
      text:
        '工具报错就是失败，不是结果。没拿到就说没拿到，不要用报错去编内容；' +
        '同一个调用（工具 + 参数）最多试两次，第三次换办法或停下来问。',
    })
  }

  ctx.effect(() => () => {
    breakers.clear()
    repeats.clear()
  })
}
