import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const band = (surface: 'terminal' | 'desktop', isWorking = true) =>
  ({
    plugin: 'helper-desk',
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

const pane = (surface: 'terminal' | 'desktop') =>
  ({
    plugin: 'helper-desk',
    component: 'Pane',
    requestId: 'helper-desk',
    surface,
    props: {
      title: 'Helper desk',
      isFocused: false,
      bodyColumns: 60,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 40 },
      view: {},
    },
  }) as const

let opened = 0

// Each hook here stands for the engine beneath the plugin.
const engine = (on: On) => {
  opened = 0
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 1_000_000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 3 }], cost: { usd: 3.5 } } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: true } }
  })
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'Research cache pricing', type: 'Explore', status: 'running' as const }],
  }))
  on('tool.call', () => ({ result: {} }) as never)
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 10_000,
        output_tokens: 2_000,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 0,
      },
    }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
}

const PLAN = 'mcp__ccd_turn__update_plan'

test('the band fills as the plan advances, on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.tool.call({
    tool: PLAN,
    items: [
      { content: 'Read the docs', status: 'in_progress' },
      { content: 'Build the mod', status: 'pending' },
      { content: 'Test it', status: 'pending' },
    ],
    scope: 'first_task',
  } as never)
  await $.tool.call({ tool: PLAN, advance: true } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    expect((await ui.find({ type: 'Text', text: /\/3/ }))?.text).toBe('1/3')
    expect((await ui.find({ type: 'Text', text: /▸/ }))?.text).toBe('▸ Build the mod')
    await ui.unmount()
  }

  await $.tool.call({ tool: PLAN, done: [2], start: 3 } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' } as never)
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /\/3/ }))?.text).toBe('3/3')
  await ui.unmount()

  // Idle with everything done: the band steps aside.
  const idle = await $.ui.mount(band('desktop', false))
  expect(await idle.find({ type: 'Text', text: /\/3/ })).toBeUndefined()
  await idle.unmount()
})

test('TodoWrite drives the bar too', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'One', status: 'completed', activeForm: 'Doing one' },
      { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
    ],
  })

  const ui = await $.ui.mount(band('terminal'))
  expect((await ui.find({ type: 'Text', text: /\/2/ }))?.text).toBe('1/2')
  await ui.unmount()
})

test('a subagent gets its row: color, activity, tokens and cost', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  await $.turn.start({ text: 'research', turnId: 't-a1', agentId: 'a1' })
  expect(opened).toBe(1)

  const stream = $.turn.step({ turnId: 't-a1', index: 0, model: 'claude-opus-5-5', messageCount: 1, agentId: 'a1' })
  for await (const _ of stream) {
    // drain
  }
  await $.tool.call({ tool: 'Read', file_path: '/Users/me/notes/pricing.md', agentId: 'a1' } as never)
  await clock.advance(42_000)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(pane(surface))
    expect(await ui.find({ type: 'Text', text: 'Research cache pricing' })).toBeDefined()
    // 10k x 4 $ + 100k x 0.20 $ + 2k x 20 $ per million = 0.10 $.
    expect((await ui.find({ type: 'Text', text: /100 %/ }))?.text).toContain('0,10 $')
    expect((await ui.find({ type: 'Text', text: /en cours/ }))?.text).toContain('Read · pricing.md')
    await ui.unmount()
  }

  await $.turn.complete({ turnId: 't-a1', agentId: 'a1', reason: 'answer', answer: 'found it', durationMs: 42_000, isAborted: false })
  const ui = await $.ui.mount(pane('desktop'))
  expect((await ui.find({ type: 'Text', text: /terminé/ }))?.text).toContain('1 outil')
  expect((await ui.find({ type: 'Text', text: /Coût de la session/ }))?.text).toContain('3,50 $')
  await ui.press({ key: 'clear-done' })
  expect(await ui.find({ type: 'Text', text: 'Research cache pricing' })).toBeUndefined()
  await ui.unmount()

  // A second agent run does not reopen a pane the person may have closed.
  await $.turn.start({ text: 'again', turnId: 't-a1b', agentId: 'a1' })
  expect(opened).toBe(1)
})

test('an engine fork no list names is not shown', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'compact', turnId: 't-x', agentId: 'engine-fork' })
  expect(opened).toBe(0)
})
