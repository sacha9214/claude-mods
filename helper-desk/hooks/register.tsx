import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { AgentRow, PlanItem, PlanStatus, Spend } from '../types'

// Helper desk: a purple progress bar of the task list above the prompt, and a
// side panel where each subagent has its color, status, activity and cost.

const PANE = 'helper-desk'
const PURPLE = '#8B5CF6'
const COLORS = ['#E07A5F', '#3D9970', '#4C8BF5', '#D4A017', '#B05CC6', '#17A2B8', '#E8590C', '#C2185B']
const EMPTY: Spend = { input: 0, output: 0, read: 0, write: 0, usd: 0, isPriced: true, model: '' }

const plan = atom({ plugin: 'helper-desk', key: 'plan' } as const, [])
const agents = atom({ plugin: 'helper-desk', key: 'agents' } as const, [])
const main = atom({ plugin: 'helper-desk', key: 'main' } as const, EMPTY)
const sessionUsd = atom({ plugin: 'helper-desk', key: 'sessionUsd' } as const, null)
const writeFactor = atom({ plugin: 'helper-desk', key: 'writeFactor' } as const, 2)
const hasAutoOpened = atom({ plugin: 'helper-desk', key: 'hasAutoOpened' } as const, false)
const tick = atom({ plugin: 'helper-desk', key: 'tick' } as const, 0)

// Whether a pane opened unasked would sit beside the transcript (read off the
// band's viewport; unknown counts as yes, as on the desktop app).
const flags = { canDock: true }

// List prices in USD per million tokens (claude-api skill, 2026-10).
type Rate = { input: number; output: number; read: number }

const rateOf = (model: string, prompt: number): Rate | null => {
  const m = model.toLowerCase()
  if (/(fable|mythos)-5-1/.test(m)) return { input: 10, output: 50, read: 0.25 }
  if (/(fable|mythos)-5/.test(m)) return { input: 10, output: 50, read: 1 }
  if (/opus-5-5/.test(m)) return { input: 4, output: 20, read: 0.2 }
  if (/opus-5/.test(m)) return { input: 5, output: 25, read: 0.5 }
  if (/sonnet-5/.test(m)) return { input: 2, output: 10, read: 0.2 }
  if (/haiku-5-5/.test(m)) {
    return prompt > 100_000
      ? { input: 0.5, output: 2.5, read: 0.05 }
      : { input: 0.1, output: 0.5, read: 0.01 }
  }
  if (/haiku-4-5/.test(m)) return { input: 1, output: 5, read: 0.1 }
  return null
}

const addUsage = (spend: Spend, usage: TurnUsage, factor: number): Spend => {
  const prompt = usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens
  const rate = rateOf(usage.model, prompt)
  const usd =
    rate === null
      ? 0
      : (usage.input_tokens * rate.input +
          usage.cache_creation_input_tokens * rate.input * factor +
          usage.cache_read_input_tokens * rate.read +
          usage.output_tokens * rate.output) /
        1e6

  return {
    input: spend.input + usage.input_tokens,
    output: spend.output + usage.output_tokens,
    read: spend.read + usage.cache_read_input_tokens,
    write: spend.write + usage.cache_creation_input_tokens,
    usd: spend.usd + usd,
    isPriced: spend.isPriced && rate !== null,
    model: usage.model,
  }
}

const totalTokens = (s: Spend) => s.input + s.output + s.read + s.write

const asStatus = (value: unknown): PlanStatus =>
  value === 'completed' || value === 'in_progress' ? value : 'pending'

// How a task-list tool changes the list: the desktop app's update_plan and
// wrap_up, the CLI's TodoWrite, TaskCreate and TaskUpdate.
const planChange = (
  tool: string,
  input: Record<string, unknown>,
  result: unknown,
): ((items: PlanItem[]) => PlanItem[]) | null => {
  if (tool.endsWith('ccd_turn__update_plan')) {
    const given = input.items
    if (Array.isArray(given)) {
      const items = given.map((one: { content?: unknown; status?: unknown }, i): PlanItem => ({
        id: String(i + 1),
        content: String(one.content ?? ''),
        status: asStatus(one.status),
      }))
      return () => items
    }

    return list => {
      const items = list.map(one => ({ ...one }))
      if (input.advance === true) {
        const current = items.find(one => one.status === 'in_progress')
        if (current) current.status = 'completed'
        const following = items.find(one => one.status === 'pending')
        if (following) following.status = 'in_progress'
      }
      if (Array.isArray(input.done)) {
        for (const n of input.done) {
          const one = items[Number(n) - 1]
          if (one) one.status = 'completed'
        }
      }
      if (typeof input.start === 'number') {
        const one = items[input.start - 1]
        if (one) one.status = 'in_progress'
      }
      return items
    }
  }

  if (tool.endsWith('ccd_turn__wrap_up')) {
    return list => list.map(one => ({ ...one, status: 'completed' as const }))
  }

  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const items = input.todos.map((one: { content?: unknown; status?: unknown }, i): PlanItem => ({
      id: String(i + 1),
      content: String(one.content ?? ''),
      status: asStatus(one.status),
    }))
    return () => items
  }

  if (tool === 'TaskCreate') {
    const task = (result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
    if (task?.id === undefined) return null
    const item: PlanItem = { id: String(task.id), content: String(task.subject ?? input.subject ?? ''), status: 'pending' }
    return list => [...list, item]
  }

  if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    const id = input.taskId
    return list =>
      input.status === 'deleted'
        ? list.filter(one => one.id !== id)
        : list.map(one =>
            one.id === id
              ? {
                  ...one,
                  content: typeof input.subject === 'string' ? input.subject : one.content,
                  status: input.status === undefined ? one.status : asStatus(input.status),
                }
              : one,
          )
  }

  return null
}

// A few words on what a subagent's tool call is doing.
const describeCall = (tool: string, input: Record<string, unknown>) => {
  const text = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const file = (key: string) => text(key).split('/').pop() ?? ''

  switch (tool) {
    case 'Bash':
      return `Bash · ${text('command').slice(0, 48)}`
    case 'Read':
    case 'Edit':
    case 'Write':
      return `${tool} · ${file('file_path')}`
    case 'Grep':
    case 'Glob':
      return `${tool} · ${text('pattern').slice(0, 40)}`
    case 'WebFetch':
      try {
        return `WebFetch · ${new URL(text('url')).host}`
      } catch {
        return 'WebFetch'
      }
    case 'WebSearch':
      return `WebSearch · ${text('query').slice(0, 40)}`
    default:
      return tool.startsWith('mcp__') ? tool.split('__').slice(1).join(' · ') : tool
  }
}

const STATUS: Record<string, string> = {
  pending: 'en attente',
  running: 'en cours',
  waiting: 'attend',
  idle: 'au repos',
  completed: 'terminé',
  failed: 'échec',
  killed: 'arrêté',
}

const isActive = (row: AgentRow) => row.status === 'running' || row.status === 'pending' || row.status === 'waiting'

const money = (usd: number) =>
  usd < 0.01 ? '< 0,01 $' : `${usd.toFixed(2).replace('.', ',')} $`

const tokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace('.', ',')} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n)

const span = (ms: number) => {
  const s = Math.round(Math.max(0, ms) / 1000)
  if (s < 60) return `${s} s`
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min ${String(s % 60).padStart(2, '0')}`

  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`
}

const bar = (share: number, width: number) => {
  const filled = Math.max(0, Math.min(width, Math.round(share * width)))

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// Cache writes cost 2x input on a subscription (1-hour entries), 1.25x with an
// API key. A mod is not told the account kind; the subscription's usage
// windows, which arrive with the first reply, say it.
async function settleWriteFactor($: EngineInterface) {
  const usage = await $.session.usage()
  const isSubscription = usage.rateLimits.some(limit => limit.kind === 'five_hour' || limit.kind === 'seven_day')
  await update($, writeFactor, () => (isSubscription ? 2 : 1.25))
}

async function openPane($: EngineInterface) {
  await update($, hasAutoOpened, () => true)
  return $.ui.open({ id: PANE, title: 'Helper desk' })
}

async function ensureAgent($: EngineInterface, agentId: string) {
  if ((await read($, agents)).some(row => row.id === agentId)) return true

  // Ids no list names are the engine's own forks (compaction, memory).
  const info = (await $.agent.list()).find(one => one.id === agentId)
  if (info === undefined) return false

  const startedAt = await $.clock.now()
  await update($, agents, list =>
    list.some(row => row.id === agentId)
      ? list
      : [
          ...list,
          {
            id: agentId,
            description: info.description || info.name || info.type,
            type: info.type,
            color: COLORS[list.length % COLORS.length] ?? PURPLE,
            status: 'running',
            startedAt,
            endedAt: null,
            tools: 0,
            activity: 'démarre…',
            spend: EMPTY,
          },
        ].slice(-40),
  )

  if (flags.canDock && !(await read($, hasAutoOpened))) await openPane($)

  return true
}

async function changeAgent($: EngineInterface, agentId: string, change: (row: AgentRow) => AgentRow) {
  await update($, agents, list => list.map(row => (row.id === agentId ? change(row) : row)))
}

async function recordStep($: EngineInterface, agentId: string | undefined, usage: TurnUsage | null) {
  if (usage === null) return
  const factor = await read($, writeFactor)
  if (agentId === undefined) {
    await update($, main, spend => addUsage(spend, usage, factor))
    return
  }
  if (await ensureAgent($, agentId)) {
    await changeAgent($, agentId, row => ({ ...row, spend: addUsage(row.spend, usage, factor) }))
  }
}

async function onTick($: EngineInterface) {
  if ((await read($, agents)).some(isActive)) await update($, tick, n => n + 1)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'helpers',
      description: 'Ouvre le panneau Helper desk (sous-agents, coûts, avancement)',
    })

    await settleWriteFactor($)

    $.clock.every(5_000, () => {
      void onTick($)
    })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, plan, () => [])
      await update($, agents, () => [])
      await update($, main, () => EMPTY)
    }

    return next(e)
  })

  on('command.run', { command: 'helpers' }, async $ => {
    await openPane($)

    return { text: 'Panneau Helper desk ouvert.' }
  })

  // Every tool but Agent: a hook the Agent call passes through would be one
  // the subagent's own tool calls step past, and those are what we count.
  on('tool.call', { tool: /^(?!Agent$)/ }, async ($, e, next) => {
    const ran = await next(e)
    try {
      const tool = String(e.tool)
      const input = e as unknown as Record<string, unknown>
      if (e.agentId !== undefined) {
        const agentId = e.agentId
        if (await ensureAgent($, agentId)) {
          const activity = describeCall(tool, input)
          await changeAgent($, agentId, row => ({ ...row, tools: row.tools + 1, activity }))
        }
      } else if (ran.deny === undefined && ran.isError !== true) {
        const change = planChange(tool, input, ran.result)
        if (change !== null) await update($, plan, change)
      }
    } catch {
      // The desk only watches: a failed write never touches the call.
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      if (await ensureAgent($, agentId)) {
        await changeAgent($, agentId, row => ({ ...row, status: 'running', endedAt: null }))
      }
    }

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    try {
      await recordStep($, e.agentId, step.usage)
    } catch {
      // Counting is best effort.
    }

    return step
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    try {
      if (e.agentId !== undefined && (await read($, agents)).some(row => row.id === e.agentId)) {
        const agentId = e.agentId
        const info = (await $.agent.list()).find(one => one.id === agentId)
        const now = await $.clock.now()
        const status =
          info?.type === 'teammate'
            ? 'idle'
            : e.reason === 'answer'
              ? 'completed'
              : e.reason === 'aborted'
                ? 'killed'
                : 'failed'
        await changeAgent($, agentId, row => ({ ...row, status, endedAt: now, activity: STATUS[status] ?? status }))
      }
      const usage = await $.session.usage()
      await update($, sessionUsd, () => usage.cost?.usd ?? null)
      if (e.agentId === undefined) await settleWriteFactor($)
    } catch {
      // Best effort, as above.
    }

    return ended
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    flags.canDock = e.viewport?.isFullscreen !== false
    if (e.props.hasSurvey || e.props.view.agentId !== undefined) return below

    const items = await read($, plan)
    const list = await read($, agents)
    const running = list.filter(isActive).length
    const done = items.filter(one => one.status === 'completed').length
    const showPlan = items.length > 0 && (done < items.length || e.props.isWorking)
    if (!showPlan && running === 0) return below

    const { Box, Text, Button } = $.ui.resolve(e)
    const current = items.find(one => one.status === 'in_progress') ?? items.find(one => one.status === 'pending')
    const width = Math.max(10, Math.min(28, Math.floor(e.props.bodyColumns / 4)))

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          {showPlan && <Text color={PURPLE}>{bar(done / items.length, width)}</Text>}
          {showPlan && (
            <Text color={PURPLE} weight="semibold" tabular>
              {done}/{items.length}
            </Text>
          )}
          {showPlan && (
            <Text wrap="truncate-end">
              {current ? `▸ ${current.content}` : '✓ tout est fait'}
            </Text>
          )}
          {running > 0 && (
            <Button key="agents" dimColor onPress={() => void openPane($)}>
              🦀 {running} agent{running > 1 ? 's' : ''}
            </Button>
          )}
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    await read($, tick)
    const list = await read($, agents)
    const mainSpend = await read($, main)
    const engineUsd = await read($, sessionUsd)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)

    const rows = [...list].sort((a, b) =>
      isActive(a) === isActive(b) ? b.startedAt - a.startedAt : isActive(a) ? -1 : 1,
    )
    const isPriced = mainSpend.isPriced && list.every(row => row.spend.isPriced)
    const weight = (s: Spend) => (isPriced ? s.usd : totalTokens(s))
    const all = weight(mainSpend) + list.reduce((sum, row) => sum + weight(row.spend), 0)
    const share = (s: Spend) => (all > 0 ? weight(s) / all : 0)
    const estimated = mainSpend.usd + list.reduce((sum, row) => sum + row.spend.usd, 0)
    const width = Math.max(8, Math.min(24, e.props.bodyColumns - 26))
    const pct = (s: Spend) => `${Math.round(share(s) * 100)} %`
    const cost = (s: Spend) => (s.isPriced ? `≈ ${money(s.usd)}` : `${tokens(totalTokens(s))} tokens`)

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Text weight="semibold">
            Coût de la session : {engineUsd === null ? `≈ ${money(estimated)}` : money(engineUsd)}
          </Text>
          <Text dimColor>
            {engineUsd === null
              ? "estimé aux prix publics depuis l'activation du mod"
              : `selon /cost · dont ${money(estimated)} suivis depuis l'activation du mod`}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color={PURPLE}>●</Text>
            <Text weight="semibold">Fil principal</Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            <Text color={PURPLE}>{bar(share(mainSpend), width)}</Text>
            <Text dimColor tabular>
              {pct(mainSpend)} · {cost(mainSpend)}
            </Text>
          </Box>
        </Box>

        {rows.length === 0 && (
          <Text dimColor>Aucun sous-agent pour l'instant : ils apparaîtront ici dès que Claude en lance un.</Text>
        )}

        {rows.map(row => (
          <Box key={row.id} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={row.color}>●</Text>
              <Text weight="semibold" wrap="truncate-end">
                {row.description}
              </Text>
              <Text dimColor>{row.type}</Text>
            </Box>
            <Box flexDirection="row" gap={1}>
              <Text color={row.color}>{bar(share(row.spend), width)}</Text>
              <Text dimColor tabular>
                {pct(row.spend)} · {cost(row.spend)}
              </Text>
            </Box>
            <Text dimColor={!isActive(row)} wrap="truncate-end">
              {STATUS[row.status] ?? row.status} · {span((row.endedAt ?? now) - row.startedAt)} · {row.tools} outil
              {row.tools > 1 ? 's' : ''}
              {isActive(row) ? ` · ${row.activity}` : ''}
            </Text>
          </Box>
        ))}

        {list.some(row => !isActive(row)) && (
          <Button
            key="clear-done"
            dimColor
            onPress={() => void update($, agents, all => all.filter(isActive))}
          >
            Effacer les terminés
          </Button>
        )}
      </Box>
    )
  })
}
