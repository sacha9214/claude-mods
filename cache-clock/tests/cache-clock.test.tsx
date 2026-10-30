import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const MIN = 60_000

const band = (surface: 'terminal' | 'desktop', isWorking = false) =>
  ({
    plugin: 'cache-clock',
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

// Each hook here stands for the engine beneath the plugin. `env` and `settings`
// are what the person's system and Claude Code settings hold (the language).
const engine = (on: On, isSubscription = true, env: Record<string, string> = {}, settings: Record<string, unknown> = {}) => {
  const commands: Record<string, string> = {}
  on('command.register', (_, e) => {
    commands[e.name] = e.description ?? ''
    return { value: { command: e.name } }
  })
  on('env.get', (_, e) => ({ value: env[e.name] }))
  on('settings.read', () => ({ value: settings as never }))
  // A subscription: its usage windows come with the replies.
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1_000_000 },
      rateLimits: isSubscription ? [{ kind: 'five_hour', percentUsed: 3 }] : [],
    },
  }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.toast', () => ({ value: undefined }))
  // A 200k-token conversation on Opus 5.5, served from the cache.
  on('turn.step', async function* (_, e) {
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'done',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: {
        model: 'claude-opus-5-5',
        input_tokens: 0,
        output_tokens: 1_000,
        cache_read_input_tokens: 199_000,
        cache_creation_input_tokens: 0,
      },
    }
  })
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)
    return <Box />
  })
  return commands
}

const oneTurn = async ($: Engine) => {
  await $.turn.start({ text: 'hello', turnId: 't1' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 2 })
  for await (const _ of stream) {
    // drain
  }
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 1_000, isAborted: false })
}

test('the band counts down, prices the next message, then goes cold', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount(band(surface))
    expect((await ui.find({ type: 'Text', text: /Cache warm/ }))?.text).toContain('cold in 1 h')
    // 200k tokens: 0.2 M x 0.20 $ warm, 0.2 M x 4 $ x 2 (1-hour write) cold.
    const prices = await ui.find({ type: 'Text', text: /next message/ })
    expect(prices?.text).toContain('$0.04')
    expect(prices?.text).toContain('$1.60')
    await ui.unmount()
  }

  await clock.advance(61 * MIN)
  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /Cache cold/ }))?.text).toContain('for 1 min')
  await ui.unmount()
})

test('nothing shows while a turn runs', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($)

  const ui = await $.ui.mount(band('desktop', true))
  expect(await ui.find({ type: 'Text', text: /Cache/ })).toBeUndefined()
  await ui.unmount()
})

test('keep-warm pings just before expiry and stops on the next prompt', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  engine(on)
  let forks = 0
  on('model.fork', () => {
    forks += 1
    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: {
          input_tokens: 20,
          output_tokens: 1,
          cache_read_input_tokens: 199_000,
          cache_creation_input_tokens: 0,
        },
      },
    }
  })
  on('prompt.submit', (_, e) => ({ text: e.text }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($)

  const started = await $.command.run({ command: 'keep-warm', args: '' } as never)
  expect(started.text).toContain('Keep-warm on for 2 h')

  await clock.advance(50 * MIN)
  expect(forks).toBe(0)
  await clock.advance(7 * MIN)
  expect(forks).toBe(1)

  // The ping restarted the clock: the next one comes an hour later.
  await clock.advance(50 * MIN)
  expect(forks).toBe(1)
  await clock.advance(7 * MIN)
  expect(forks).toBe(2)

  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /kept warm/ }))?.text).toContain('199k tokens re-read')
  await ui.unmount()

  await $.prompt.submit({ text: 'back', wait: false } as never)
  await clock.advance(60 * MIN)
  expect(forks).toBe(2)
})

test('keep-warm stops by itself after its duration', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  engine(on)
  let forks = 0
  on('model.fork', () => {
    forks += 1
    return {
      value: {
        isAnswered: true,
        text: 'ok',
        usage: { input_tokens: 20, output_tokens: 1, cache_read_input_tokens: 199_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($)
  await $.command.run({ command: 'keep-warm', args: '' } as never)

  await clock.advance(5 * 60 * MIN)
  // Two hours of keep-warm on a 1-hour cache: two pings, then it stops.
  expect(forks).toBe(2)
})

test('an API key (no usage windows) counts down 5 minutes', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  engine(on, false)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($)

  const ui = await $.ui.mount(band('desktop'))
  expect((await ui.find({ type: 'Text', text: /Cache warm/ }))?.text).toContain('cold in 5 min')
  // 5-minute writes cost 1.25x input: 0.2 M x 4 $ x 1.25.
  expect((await ui.find({ type: 'Text', text: /next message/ }))?.text).toContain('$1.00')
  await ui.unmount()
})

// ------------------------------------------------------------------ language
const frenchBand = async ($: Engine) => {
  const ui = await $.ui.mount(band('desktop'))
  const line = (await ui.find({ type: 'Text', text: /Cache chaud/ }))?.text
  const prices = (await ui.find({ type: 'Text', text: /prochain message/ }))?.text
  await ui.unmount()
  return { line, prices }
}

test('a French system locale shows the band in French', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const commands = engine(on, true, { LANG: 'fr_FR.UTF-8' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($)
  const { line, prices } = await frenchBand($)
  expect(line).toContain('froid dans 1 h')
  expect(prices).toContain('0,04 $')
  expect(prices).toContain('1,60 $')
  expect(commands['keep-warm']).toContain('Garde le cache')
})

test("Claude's language setting wins over the system locale", async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  engine(on, true, { LANG: 'en_US.UTF-8' }, { language: 'french' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($)
  expect((await frenchBand($)).line).toContain('froid dans 1 h')
})

test('the language option wins over everything', { options: { language: 'en' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const commands = engine(on, true, { LANG: 'fr_FR.UTF-8' }, { language: 'français' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($)
  const ui = await $.ui.mount(band('terminal'))
  expect((await ui.find({ type: 'Text', text: /Cache warm/ }))?.text).toContain('cold in 1 h')
  await ui.unmount()
  expect(commands['keep-warm']).toContain('Keeps the conversation cache warm')
})

test('LC_ALL beats LANG, and French keep-warm replies follow', { options: { language: 'auto' } }, async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  engine(on, true, { LC_ALL: 'fr_CA.UTF-8', LANG: 'en_US.UTF-8' })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await oneTurn($)
  const started = await $.command.run({ command: 'keep-warm', args: '1,5' } as never)
  expect(started.text).toContain('Keep-warm activé pour 1 h 30')
  expect(started.text).toContain('0,04 $')
  const stopped = await $.command.run({ command: 'keep-warm', args: 'arrêt' } as never)
  expect(stopped.text).toBe('Keep-warm arrêté.')
})
