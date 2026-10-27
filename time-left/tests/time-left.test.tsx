import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import {
  asHistory,
  correction,
  hitRate,
  planRange,
  rangeLabel,
  turnRange,
} from '../hooks/estimate'

const S = 1000
const MIN = 60 * S

describe('the arithmetic', () => {
  test('steps that always take a minute: three left is three minutes', () => {
    const r = planRange([MIN, MIN, MIN, MIN], 0, 2, 1)
    expect(Math.round(r.mid / S)).toBe(180)
    expect(Math.round(r.low / S)).toBe(180)
    expect(Math.round(r.high / S)).toBe(180)
  })

  test('the step in progress counts only what is left of it', () => {
    const r = planRange([MIN, MIN, MIN, MIN], 40 * S, 0, 1)
    expect(Math.round(r.mid / S)).toBe(20)
  })

  test('uneven steps give a range, and the range of a sum', () => {
    const pool = [20 * S, 40 * S, MIN, 2 * MIN, 5 * MIN]
    const r = planRange(pool, null, 4, 7)
    expect(r.low).toBeLessThan(r.mid)
    expect(r.mid).toBeLessThan(r.high)
    // Four draws never all land on the extremes at the quartiles.
    expect(r.low).toBeGreaterThan(4 * 20 * S)
    expect(r.high).toBeLessThan(4 * 5 * MIN)
  })

  test('the same plan and step draw the same range', () => {
    const pool = [20 * S, 40 * S, MIN, 2 * MIN, 5 * MIN]
    expect(planRange(pool, 10 * S, 3, 42)).toEqual(planRange(pool, 10 * S, 3, 42))
  })

  test('a step past everything measured still gets some time', () => {
    const r = planRange([MIN, MIN, MIN, MIN], 10 * MIN, 0, 1)
    expect(Math.round(r.mid / S)).toBe(300)
  })

  test('no plan: nothing under eight turns, then what longer turns went on for', () => {
    expect(turnRange([MIN, MIN, MIN], 0)).toBeNull()
    const turns = [30 * S, MIN, 2 * MIN, 3 * MIN, 4 * MIN, 5 * MIN, 6 * MIN, 8 * MIN, 10 * MIN, 12 * MIN]
    const r = turnRange(turns, 3 * MIN)
    expect(r).not.toBeNull()
    expect(r!.mid).toBeGreaterThan(2 * MIN)
    // Past almost every turn: no honest answer.
    expect(turnRange(turns, 11 * MIN)).toBeNull()
  })

  test('calibration waits for five verdicts, then follows the median miss', () => {
    const late = (n: number) => Array.from({ length: n }, () => ({ kind: 'plan' as const, ratio: 1.6, hit: false }))
    expect(correction(late(4), 'plan')).toBe(1)
    expect(Math.round(correction(late(6), 'plan') * 100)).toBe(160)
    expect(correction(late(6), 'turn')).toBe(1)
    expect(correction([...late(6), ...late(6).map(j => ({ ...j, ratio: 9 }))], 'plan')).toBe(2.5)
    expect(hitRate(late(6), 'plan')).toBe(0)
  })

  test('labels', () => {
    expect(rangeLabel({ low: 3 * MIN, mid: 5 * MIN, high: 7.2 * MIN })).toBe('≈ 3–7 min')
    expect(rangeLabel({ low: 30 * S, mid: 45 * S, high: 80 * S })).toBe('≈ 30–80 s')
    expect(rangeLabel({ low: 2 * S, mid: 5 * S, high: 10 * S })).toBe('presque fini')
  })

  test('a store written by anything else reads as empty history', () => {
    expect(asHistory(undefined)).toEqual({ steps: [], turns: [], judged: [] })
    expect(asHistory({ steps: [1000, 'x', -5], turns: 'no', judged: [{ kind: 'plan', ratio: 1, hit: true }, {}] })).toEqual({
      steps: [1000],
      turns: [],
      judged: [{ kind: 'plan', ratio: 1, hit: true }],
    })
  })
})

const spinner = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'time-left',
    component: 'Spinner',
    requestId: 'main',
    surface,
    props: { word: 'Thinking', message: null, suffix: '…', mode: 'thinking' },
  }) as const

const band = (surface: 'terminal' | 'desktop', isWorking = true) =>
  ({
    plugin: 'time-left',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    surface,
    props: {
      hasSurvey: false,
      isWorking,
      maxRows: 10,
      bodyColumns: 120,
      scroll: { offset: 0, bodyRows: 10 },
      view: {},
    },
  }) as const

// Each hook here stands for the engine beneath the plugin.
const engine = (on: On) => {
  mock.store(on)
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('tool.call', () => ({ result: {} }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return (
      <Text>
        {e.props.word}
        {e.props.suffix}
      </Text>
    )
  })
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const PLAN = 'mcp__ccd_turn__update_plan'
const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ content: `Step ${i + 1}`, status: i === 0 ? 'in_progress' : 'pending' }))

const completeTurn = ($: Engine, turnId: string) =>
  $.turn.complete({ turnId, reason: 'answer', answer: 'done', durationMs: 0, isAborted: false })

// One turn with a plan of `steps` steps, each taking `each` ms.
const runPlan = async ($: Engine, clock: { advance: (ms: number) => Promise<void> }, turnId: string, steps: number, each: number) => {
  await $.turn.start({ text: 'go', turnId })
  await $.tool.call({ tool: PLAN, items: items(steps), scope: 'continuation' } as never)
  for (let i = 0; i < steps - 1; i++) {
    await clock.advance(each)
    await $.tool.call({ tool: PLAN, advance: true } as never)
  }
  await clock.advance(each)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' } as never)
  await completeTurn($, turnId)
}

describe('the mod', () => {
  test('a plan gets a range on the spinner line and above the prompt, on every surface', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: PLAN, items: items(4), scope: 'first_task' } as never)
    await clock.advance(MIN)
    await $.tool.call({ tool: PLAN, advance: true } as never)

    for (const surface of ['terminal', 'desktop'] as const) {
      const line = await $.ui.mount(spinner(surface))
      expect((await line.find({ type: 'Text', text: /Thinking/ }))?.text).toMatch(/^Thinking… · ≈ \d+(–\d+)? (min|s)$/)
      await line.unmount()

      const ui = await $.ui.mount(band(surface))
      expect((await ui.find({ type: 'Text', text: /⏳/ }))?.text).toMatch(/restantes$/)
      expect((await ui.find({ type: 'Text', text: /étape/ }))?.text).toContain('étape 2/4')
      await ui.unmount()
    }
  })

  test('nothing shows while idle', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await runPlan($, clock, 't1', 3, MIN)

    const line = await $.ui.mount(spinner('desktop'))
    expect((await line.find({ type: 'Text', text: /Thinking/ }))?.text).toBe('Thinking…')
    await line.unmount()
  })

  test('history learns the steps, and the estimate follows it', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    // Six plans of three 2-minute steps.
    for (let n = 0; n < 6; n++) await runPlan($, clock, `t${n}`, 3, 2 * MIN)

    const report = await $.command.run({ command: 'time-left', args: '' } as never)
    expect(report.text).toContain('Étapes mesurées : 18 (médiane 2,0 min)')
    expect(report.text).toContain('Tours mesurés : 6')

    // A new plan of three steps, nothing done yet: about six minutes.
    await $.turn.start({ text: 'go', turnId: 'last' })
    await $.tool.call({ tool: PLAN, items: items(3), scope: 'continuation' } as never)
    const line = await $.ui.mount(spinner('desktop'))
    expect((await line.find({ type: 'Text', text: /Thinking/ }))?.text).toBe('Thinking… · ≈ 6 min')
    await line.unmount()
  })

  test('time waiting on a question to the person is left out', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    // The person takes half an hour to answer (registered first: it answers before the engine's stand-in).
    on('tool.call', { tool: 'AskUserQuestion' }, async () => {
      await clock.sleep(30 * MIN)
      return { result: {} } as never
    })
    engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

    await $.turn.start({ text: 'go', turnId: 't1' })
    await $.tool.call({ tool: PLAN, items: items(2), scope: 'first_task' } as never)
    await clock.advance(MIN)
    const asked = $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
    await clock.advance(30 * MIN)
    await asked
    await clock.advance(MIN)
    await $.tool.call({ tool: PLAN, advance: true } as never)

    const report = await $.command.run({ command: 'time-left', args: '' } as never)
    // Two minutes of work, not thirty-two.
    expect(report.text).toContain('Étapes mesurées : 1 (médiane 2,0 min)')
  })

  test('reset empties the history', async ($, on) => {
    const clock = mock.clock(on, { now: 1_000_000 })
    engine(on)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    await runPlan($, clock, 't1', 2, MIN)

    await $.command.run({ command: 'time-left', args: 'reset' } as never)
    const report = await $.command.run({ command: 'time-left', args: '' } as never)
    expect(report.text).toContain('Étapes mesurées : 0.')
  })
})
