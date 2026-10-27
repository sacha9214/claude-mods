import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ActiveClock, Estimate, Pending, PlanItem, PlanStatus, Tracked } from '../types'
import {
  asHistory,
  correction,
  duration,
  hitRate,
  median,
  planRange,
  rangeLabel,
  scaled,
  turnRange,
  withJudged,
  withStep,
  withTurn,
} from './estimate'
import type { History, Judged } from './estimate'

// Time left: while Claude works, a range of how long it has left, on the
// spinner line and above the prompt. With a plan, the steps still to go are
// drawn from your own past step durations; without one, from how much longer
// your past turns went on once they had run this long. Each estimate is
// judged when the plan or the turn ends, and the median miss corrects the next.

const clock = atom({ plugin: 'time-left', key: 'clock' } as const, { activeMs: 0, runningSince: null })
const tracked = atom({ plugin: 'time-left', key: 'tracked' } as const, {
  items: [],
  mark: 0,
  version: 0,
  durations: [],
})
const pending = atom({ plugin: 'time-left', key: 'pending' } as const, [])
const estimate = atom({ plugin: 'time-left', key: 'estimate' } as const, null)
const turnStart = atom({ plugin: 'time-left', key: 'turnStart' } as const, null)

const HISTORY = 'history'
const TEAL = '#17A2B8'

// The task-list tools of the main loop, and the question tool whose wait on
// the person is left out of active time.
const WATCHED = /ccd_turn__(update_plan|wrap_up)$|^(TodoWrite|TaskCreate|TaskUpdate|AskUserQuestion)$/

const isDone = (item: PlanItem) => item.status === 'completed'

const asStatus = (value: unknown): PlanStatus =>
  value === 'completed' || value === 'in_progress' ? value : 'pending'

const activeAt = (c: ActiveClock, now: number) =>
  c.activeMs + (c.runningSince === null ? 0 : now - c.runningSince)

type PlanChange = { isNew: boolean; apply: (items: PlanItem[]) => PlanItem[] }

// How a task-list tool changes the list: the desktop app's update_plan and
// wrap_up, the CLI's TodoWrite, TaskCreate and TaskUpdate.
const planChange = (tool: string, input: Record<string, unknown>, result: unknown): PlanChange | null => {
  const fromList = (list: unknown[]): PlanItem[] =>
    list.map((one, i) => {
      const item = (one ?? {}) as { content?: unknown; status?: unknown }
      return { id: String(i + 1), content: String(item.content ?? ''), status: asStatus(item.status) }
    })

  if (tool.endsWith('ccd_turn__update_plan')) {
    if (Array.isArray(input.items)) {
      const items = fromList(input.items)
      return { isNew: true, apply: () => items }
    }

    return {
      isNew: false,
      apply: list => {
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
      },
    }
  }

  if (tool.endsWith('ccd_turn__wrap_up')) {
    return { isNew: false, apply: list => list.map(one => ({ ...one, status: 'completed' as const })) }
  }

  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    const items = fromList(input.todos)
    return { isNew: false, apply: () => items }
  }

  if (tool === 'TaskCreate') {
    const task = (result as { task?: { id?: unknown; subject?: unknown } } | undefined)?.task
    if (task?.id === undefined) return null
    const item: PlanItem = { id: String(task.id), content: String(task.subject ?? input.subject ?? ''), status: 'pending' }
    return { isNew: false, apply: list => (list.every(isDone) ? [item] : [...list, item]) }
  }

  if (tool === 'TaskUpdate' && typeof input.taskId === 'string') {
    const id = input.taskId
    return {
      isNew: false,
      apply: list =>
        input.status === 'deleted'
          ? list.filter(one => one.id !== id)
          : list.map(one =>
              one.id === id ? { ...one, status: input.status === undefined ? one.status : asStatus(input.status) } : one,
            ),
    }
  }

  return null
}

const basisFor = (measured: number, judged: readonly Judged[], kind: 'plan' | 'turn') => {
  const rate = hitRate(judged, kind)
  const source =
    kind === 'plan'
      ? measured === 0
        ? 'estimation de départ'
        : `d'après ${measured} étape${measured > 1 ? 's' : ''} mesurée${measured > 1 ? 's' : ''}`
      : `d'après ${measured} tours passés`

  return rate === null ? `${source} · calibrage en cours` : `${source} · fourchette juste ${Math.round(rate * 100)} % du temps`
}

async function loadHistory($: EngineInterface): Promise<History> {
  return asHistory(await $.store.get(HISTORY))
}

async function activeNow($: EngineInterface) {
  const now = await $.clock.now()
  return activeAt(await read($, clock), now)
}

async function pause($: EngineInterface) {
  const now = await $.clock.now()
  await update($, clock, (c): ActiveClock =>
    c.runningSince === null ? c : { activeMs: c.activeMs + now - c.runningSince, runningSince: null },
  )
}

async function resume($: EngineInterface) {
  const now = await $.clock.now()
  await update($, clock, (c): ActiveClock => (c.runningSince === null ? { ...c, runningSince: now } : c))
}

// Judges the estimates of one kind against the active time that really went by.
async function judge($: EngineInterface, kind: 'plan' | 'turn') {
  const due = (await read($, pending)).filter(p => p.kind === kind)
  if (due.length === 0) return
  const active = await activeNow($)
  const verdicts: Judged[] = due.map(p => {
    const actual = active - p.at
    return { kind, ratio: p.mid > 0 ? actual / p.mid : 1, hit: actual >= p.low && actual <= p.high }
  })
  await $.store.set(HISTORY, withJudged(await loadHistory($), verdicts))
  await update($, pending, list => list.filter(p => p.kind !== kind))
}

async function remember($: EngineInterface, guess: Pending) {
  await update($, pending, list => (list.some(p => p.key === guess.key) ? list : [...list, guess].slice(-20)))
}

// Works out the range while a main turn runs; clears it otherwise.
async function recompute($: EngineInterface) {
  if ((await read($, clock)).runningSince === null) {
    await update($, estimate, () => null)
    return
  }

  const active = await activeNow($)
  const plan = await read($, tracked)
  const history = await loadHistory($)
  const left = plan.items.filter(one => !isDone(one))

  if (left.length > 0) {
    const current = plan.items.find(one => one.status === 'in_progress')
    const done = plan.items.length - left.length
    // This plan's own steps count double: they say most about the work at hand.
    const pool = [...plan.durations, ...plan.durations, ...history.steps]
    const raw = planRange(
      pool,
      current ? active - plan.mark : null,
      current ? left.length - 1 : left.length,
      plan.version * 997 + done,
    )
    const shown = scaled(raw, correction(history.judged, 'plan'))
    const next: Estimate = {
      kind: 'plan',
      ...shown,
      done,
      total: plan.items.length,
      basis: basisFor(history.steps.length, history.judged, 'plan'),
    }
    await update($, estimate, () => next)
    await remember($, {
      kind: 'plan',
      key: `plan:${plan.version}:${done}`,
      at: active,
      mid: raw.mid,
      low: shown.low,
      high: shown.high,
    })
    return
  }

  const started = await read($, turnStart)
  const raw = started === null ? null : turnRange(history.turns, active - started)
  if (started === null || raw === null) {
    await update($, estimate, () => null)
    return
  }

  const shown = scaled(raw, correction(history.judged, 'turn'))
  const next: Estimate = {
    kind: 'turn',
    ...shown,
    done: 0,
    total: 0,
    basis: basisFor(history.turns.length, history.judged, 'turn'),
  }
  await update($, estimate, () => next)
  await remember($, { kind: 'turn', key: `turn:${started}`, at: active, mid: raw.mid, low: shown.low, high: shown.high })
}

async function applyPlan($: EngineInterface, change: PlanChange) {
  const active = await activeNow($)
  const before = await read($, tracked)
  const items = change.apply(before.items)
  const isNew =
    change.isNew || ((before.items.length === 0 || before.items.every(isDone)) && items.some(one => !isDone(one)))

  if (isNew) {
    // A new plan: the old one's open estimates can no longer be judged.
    await update($, pending, list => list.filter(p => p.kind !== 'plan'))
    await update($, tracked, (t): Tracked => ({ items, mark: active, version: t.version + 1, durations: [] }))
  } else {
    const finished = items.filter(isDone).length - before.items.filter(isDone).length
    const step = active - before.mark
    // One step ended: a clean measure. Several at once (skipped, wrapped up) are not.
    if (finished === 1 && step > 1000) {
      await $.store.set(HISTORY, withStep(await loadHistory($), step))
    }
    await update($, tracked, (t): Tracked => ({
      ...t,
      items,
      mark: finished > 0 ? active : t.mark,
      durations: finished === 1 && step > 1000 ? [...t.durations, step] : t.durations,
    }))
    if (items.length > 0 && items.every(isDone)) await judge($, 'plan')
  }

  await recompute($)
}

async function onTick($: EngineInterface) {
  if ((await read($, clock)).runningSince !== null) await recompute($)
}

async function stats($: EngineInterface) {
  const h = await loadHistory($)
  const factorPlan = correction(h.judged, 'plan')
  const factorTurn = correction(h.judged, 'turn')
  const ratePlan = hitRate(h.judged, 'plan')
  const rateTurn = hitRate(h.judged, 'turn')
  const judgedPlan = h.judged.filter(j => j.kind === 'plan').length
  const judgedTurn = h.judged.filter(j => j.kind === 'turn').length

  return [
    `Étapes mesurées : ${h.steps.length}${h.steps.length > 0 ? ` (médiane ${duration(median(h.steps))})` : ''}.`,
    `Tours mesurés : ${h.turns.length}${h.turns.length > 0 ? ` (médiane ${duration(median(h.turns))})` : ''}${h.turns.length < 8 ? ', estimation sans plan à partir de 8' : ''}.`,
    `Plans : ${judgedPlan} estimations jugées, ${ratePlan === null ? 'fiabilité après 5' : `fourchette juste ${Math.round(ratePlan * 100)} % du temps`}, correction ×${factorPlan.toFixed(2).replace('.', ',')}.`,
    `Sans plan : ${judgedTurn} estimations jugées, ${rateTurn === null ? 'fiabilité après 5' : `fourchette juste ${Math.round(rateTurn * 100)} % du temps`}, correction ×${factorTurn.toFixed(2).replace('.', ',')}.`,
  ].join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'time-left',
      description: "Statistiques de l'estimation du temps restant (reset pour effacer l'historique)",
      argumentHint: '[reset]',
    })
    $.clock.every(10_000, () => {
      void onTick($)
    })

    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await resume($)
      const active = await activeNow($)
      await update($, turnStart, () => active)
      await recompute($)
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ended = await next(e)
    if (e.agentId !== undefined) return ended
    try {
      const active = await activeNow($)
      const started = await read($, turnStart)
      if (started !== null && active - started > 2000) {
        await $.store.set(HISTORY, withTurn(await loadHistory($), active - started))
      }
      await judge($, 'turn')
      await pause($)
      await update($, turnStart, () => null)
      await update($, estimate, () => null)
    } catch {
      // Measuring never touches the turn.
    }

    return ended
  })

  on('tool.call', { tool: WATCHED }, async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    const tool = String(e.tool)

    if (tool === 'AskUserQuestion') {
      await pause($)
      try {
        return await next(e)
      } finally {
        await resume($)
      }
    }

    const ran = await next(e)
    try {
      if (ran.deny === undefined && ran.isError !== true) {
        const change = planChange(tool, e as unknown as Record<string, unknown>, ran.result)
        if (change !== null) await applyPlan($, change)
      }
    } catch {
      // The estimate only watches: a failed write never touches the call.
    }

    return ran
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'time-left' }, async ($, e) => {
    if (e.args.trim().toLowerCase() === 'reset') {
      await $.store.delete(HISTORY)
      return { text: 'Historique du temps restant effacé.' }
    }

    return { text: await stats($) }
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    const shown = await read($, estimate)
    if (shown === null) return next(e)
    // A subagent's spinner keeps its own line.
    if ((await $.agent.list()).some(agent => agent.id === e.requestId)) return next(e)

    const suffix = `${e.props.suffix} · ${rangeLabel(shown)}`

    return next({ ...e, props: { ...e.props, suffix } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (!e.props.isWorking || e.props.hasSurvey || e.props.view.agentId !== undefined) return below

    const shown = await read($, estimate)
    if (shown === null) return below

    const { Box, Text } = $.ui.resolve(e)
    const words = rangeLabel(shown)
    const head = words.startsWith('≈') ? `⏳ ${words} restantes` : `⏳ ${words}`
    const step = shown.kind === 'plan' ? `étape ${Math.min(shown.done + 1, shown.total)}/${shown.total} · ` : ''

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={TEAL}>{head}</Text>
          <Text dimColor>
            {step}
            {shown.basis}
          </Text>
        </Box>
        {below}
      </Box>
    )
  })
}
