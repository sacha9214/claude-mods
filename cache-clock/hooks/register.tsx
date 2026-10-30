import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CacheTtl, Ping, Touch, TtlInfo } from '../types'

// Cache clock: shows how long the main thread's prompt cache stays warm, what
// the next message costs warm and cold, and keeps it warm on request with a
// hidden fork that re-reads the cached prefix just before it expires.

const touch = atom({ plugin: 'cache-clock', key: 'touch' } as const, null)
const ttl = atom({ plugin: 'cache-clock', key: 'ttl' } as const, {
  value: '1h',
  source: 'account',
})
const warmUntil = atom({ plugin: 'cache-clock', key: 'warmUntil' } as const, null)
const lastPing = atom({ plugin: 'cache-clock', key: 'lastPing' } as const, null)
const tick = atom({ plugin: 'cache-clock', key: 'tick' } as const, 0)
const isHidden = atom({ plugin: 'cache-clock', key: 'isHidden' } as const, false)

const PING_PROMPT =
  'Keep-alive ping sent by the cache-clock mod while the user is away. Reply with the single word: ok'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

const ttlMs = (info: TtlInfo) => (info.value === '1h' ? HOUR : 5 * MINUTE)
// How long before expiry the ping goes out: room for one retry on the next tick.
const marginMs = (info: TtlInfo) => (info.value === '1h' ? 4 * MINUTE : MINUTE)

// List prices in USD per million tokens (claude-api skill, 2026-10).
type Rate = { input: number; read: number }

const rateOf = (model: string, tokens: number): Rate | null => {
  const m = model.toLowerCase()
  if (/(fable|mythos)-5-1/.test(m)) return { input: 10, read: 0.25 }
  if (/(fable|mythos)-5/.test(m)) return { input: 10, read: 1 }
  if (/opus-5-5/.test(m)) return { input: 4, read: 0.2 }
  if (/opus-5/.test(m)) return { input: 5, read: 0.5 }
  if (/sonnet-5/.test(m)) return { input: 2, read: 0.2 }
  if (/haiku-5-5/.test(m)) {
    return tokens > 100_000 ? { input: 0.5, read: 0.05 } : { input: 0.1, read: 0.01 }
  }
  if (/haiku-4-5/.test(m)) return { input: 1, read: 0.1 }
  return null
}

const costs = (last: Touch, info: TtlInfo) => {
  const rate = rateOf(last.model, last.tokens)
  if (rate === null) return null
  const writeFactor = info.value === '1h' ? 2 : 1.25

  return {
    warm: (last.tokens / 1e6) * rate.read,
    cold: (last.tokens / 1e6) * rate.input * writeFactor,
  }
}

// What the person set (filled in by register and session.start) and what is in
// flight. Module values start over on a reload, which is what they mean.
type Lang = 'en' | 'fr'
const settings = { ttlOption: null as CacheTtl | null, keepWarmMs: 2 * HOUR, langOption: null as Lang | null, lang: 'en' as Lang }

const money = (usd: number) =>
  settings.lang === 'fr'
    ? usd < 0.01 ? '< 0,01 $' : `${usd.toFixed(2).replace('.', ',')} $`
    : usd < 0.01 ? '< $0.01' : `$${usd.toFixed(2)}`

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}${settings.lang === 'fr' ? ' ' : ''}k` : String(n))

const span = (ms: number) => {
  const min = Math.round(Math.max(0, ms) / MINUTE)
  const fr = settings.lang === 'fr'
  if (min < 1) return fr ? "moins d'1 min" : 'under 1 min'
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const rest = min % 60
  if (rest === 0) return `${h} h`

  return fr ? `${h} h ${String(rest).padStart(2, '0')}` : `${h} h ${rest} min`
}

// Every sentence the mod shows, in English and in French.
const TEXT = {
  en: {
    stopped: (why: string) => `Cache clock: keep-warm stopped, ${why}.`,
    started: (d: string) => `Cache clock: keep-warm on for ${d}.`,
    why: { nothing: 'nothing to keep warm', cold: 'the cache was already cold', max: 'its time is up', expired: 'the cache expired before the ping', back: "you're back" },
    note: { nothing: 'nothing to re-read', cold: 'the cache was already cold', failed: (r: string) => `failed (${r})` },
    keepWarmDesc: 'Keeps the conversation cache warm while you are away (stops at your next message)',
    keepWarmHint: '[off | hours]',
    clockDesc: 'Shows or hides the cache countdown above the prompt',
    off: 'Keep-warm stopped.',
    none: "Nothing to keep warm: Claude hasn't sent anything in this session yet.",
    late: 'Too late: the cache is already cold. Your next message will rewrite it anyway.',
    each: (warm: string, cold: string) => ` Each ping costs about ${warm}, versus ${cold} for a cold cache.`,
    on: (d: string, each: string) => `Keep-warm on for ${d}: a hidden ping re-reads the cache just before it expires, and stops at your next message.${each}`,
    hidden: 'Cache countdown hidden.',
    shown: 'Cache countdown shown.',
    coldFor: (d: string) => `❄ Cache cold for ${d}`,
    coldNext: (n: string) => `· next message re-reads ${n} tokens at full price`,
    warmLine: (d: string) => `⏱ Cache warm · cold in ${d}`,
    cached: (n: string, ttl: string) => `· ${n} tokens cached (${ttl})`,
    next: (warm: string, cold: string) => `· next message ≈ ${warm} (cold: ${cold})`,
    keepButton: (d: string) => `Keep warm ${d}`,
    kept: (d: string) => `🔥 kept warm for ${d} more`,
    lastPing: (ago: string, n: string) => ` · last ping ${ago} ago (${n} tokens re-read)`,
    lastPingNote: (note: string) => ` · last ping: ${note}`,
    stop: 'Stop',
  },
  fr: {
    stopped: (why: string) => `Cache clock : keep-warm arrêté, ${why}.`,
    started: (d: string) => `Cache clock : keep-warm activé pour ${d}.`,
    why: { nothing: 'rien à garder au chaud', cold: 'le cache était déjà froid', max: 'durée maximale atteinte', expired: 'le cache a expiré avant le ping', back: 'tu es de retour' },
    note: { nothing: 'rien à relire', cold: 'le cache était déjà froid', failed: (r: string) => `échec (${r})` },
    keepWarmDesc: 'Garde le cache de la conversation chaud pendant ton absence (stop au prochain message)',
    keepWarmHint: '[off | heures]',
    clockDesc: 'Affiche ou masque le compte à rebours du cache au-dessus du prompt',
    off: 'Keep-warm arrêté.',
    none: "Rien à garder au chaud : Claude n'a encore rien envoyé dans cette session.",
    late: 'Trop tard : le cache est déjà froid. Ton prochain message le réécrira de toute façon.',
    each: (warm: string, cold: string) => ` Chaque ping coûte environ ${warm}, contre ${cold} pour un cache froid.`,
    on: (d: string, each: string) => `Keep-warm activé pour ${d} : un ping invisible relit le cache juste avant qu'il expire, et s'arrête dès ton prochain message.${each}`,
    hidden: 'Compte à rebours du cache masqué.',
    shown: 'Compte à rebours du cache affiché.',
    coldFor: (d: string) => `❄ Cache froid depuis ${d}`,
    coldNext: (n: string) => `· prochain message : relit ${n} tokens au plein tarif`,
    warmLine: (d: string) => `⏱ Cache chaud · froid dans ${d}`,
    cached: (n: string, ttl: string) => `· ${n} tokens en cache (${ttl})`,
    next: (warm: string, cold: string) => `· prochain message ≈ ${warm} (froid : ${cold})`,
    keepButton: (d: string) => `Garder chaud ${d}`,
    kept: (d: string) => `🔥 maintenu encore ${d}`,
    lastPing: (ago: string, n: string) => ` · dernier ping il y a ${ago} (${n} tokens relus)`,
    lastPingNote: (note: string) => ` · dernier ping : ${note}`,
    stop: 'Arrêter',
  },
}
const say = () => TEXT[settings.lang]

// A ping's note is kept as a code and worded when drawn, so it follows the language.
const noteText = (note: string) => {
  const t = say().note
  if (note === 'nothing') return t.nothing
  if (note === 'cold') return t.cold
  if (note.startsWith('failed:')) return t.failed(note.slice('failed:'.length))
  return note
}

// The language option wins; else Claude's own `language` setting; else the
// system locale (LC_ALL, then LC_MESSAGES, then LANG); else English.
async function pickLang($: EngineInterface): Promise<Lang> {
  if (settings.langOption !== null) return settings.langOption
  const french = (value: string) => /^(fr|french|fran[cç]ais)/i.test(value.trim())
  try {
    const chosen = await $.settings.read({ key: 'language' })
    if (typeof chosen === 'string' && chosen.trim() !== '') return french(chosen) ? 'fr' : 'en'
  } catch {
    // Settings are a hint, never a reason to fail the session.
  }
  for (const value of [await $.env.get('LC_ALL'), await $.env.get('LC_MESSAGES'), await $.env.get('LANG')]) {
    if (value !== undefined && value !== '') return french(value) ? 'fr' : 'en'
  }

  return 'en'
}
const flags = { isBusy: false, isPinging: false }

// A Claude subscription writes 1-hour cache entries, an API key 5-minute ones.
// A mod is not told the account kind; the subscription's usage windows, which
// arrive with the first reply, say it.
async function accountTtl($: EngineInterface): Promise<CacheTtl> {
  const usage = await $.session.usage()

  return usage.rateLimits.some(limit => limit.kind === 'five_hour' || limit.kind === 'seven_day') ? '1h' : '5m'
}

async function stopKeepWarm($: EngineInterface, why: string) {
  if ((await read($, warmUntil)) === null) return
  await update($, warmUntil, () => null)
  $.ui.toast(say().stopped(why))
}

async function ping($: EngineInterface) {
  flags.isPinging = true
  try {
    const at = await $.clock.now()
    const before = await read($, touch)
    const reply = await $.model.fork({ prompt: PING_PROMPT })
    const usage = 'usage' in reply ? reply.usage : undefined
    const cacheRead = usage?.cache_read_input_tokens ?? 0

    if (!reply.isAnswered && reply.reason === 'nothing-to-fork') {
      await update($, lastPing, (): Ping => ({ at, isOk: false, cacheRead: 0, note: 'nothing' }))
      await stopKeepWarm($, say().why.nothing)
      return
    }

    const isWarm = before !== null && cacheRead >= before.tokens * 0.5
    if (isWarm) {
      await update($, touch, last => (last === null ? last : { ...last, at }))
      await update($, lastPing, (): Ping => ({ at, isOk: true, cacheRead, note: '' }))
      return
    }

    const note = reply.isAnswered ? 'cold' : `failed:${reply.reason}`
    await update($, lastPing, (): Ping => ({ at, isOk: false, cacheRead, note }))
    if (reply.isAnswered) await stopKeepWarm($, say().why.cold)
  } finally {
    flags.isPinging = false
  }
}

async function onTick($: EngineInterface) {
  const last = await read($, touch)
  if (last === null) return
  await update($, tick, n => n + 1)

  const until = await read($, warmUntil)
  if (until === null || flags.isBusy || flags.isPinging) return

  const now = await $.clock.now()
  if (now >= until) {
    await stopKeepWarm($, say().why.max)
    return
  }

  const info = await read($, ttl)
  const expiresAt = last.at + ttlMs(info)
  if (now >= expiresAt) {
    await stopKeepWarm($, say().why.expired)
    return
  }
  if (now >= expiresAt - marginMs(info)) await ping($)
}

export const register: Register = (on, options) => {
  settings.ttlOption = options.ttl === '1h' || options.ttl === '5m' ? options.ttl : null
  const hoursOption = Number(options.keepWarmHours)
  settings.keepWarmMs = (Number.isFinite(hoursOption) && hoursOption > 0 ? hoursOption : 2) * HOUR
  settings.langOption = options.language === 'en' || options.language === 'fr' ? options.language : null
  const { ttlOption, keepWarmMs } = settings

  on('session.start', async ($, e, next) => {
    settings.lang = await pickLang($)
    await $.command.register({
      name: 'keep-warm',
      description: say().keepWarmDesc,
      argumentHint: say().keepWarmHint,
    })
    await $.command.register({
      name: 'cache-clock',
      description: say().clockDesc,
    })

    if (ttlOption !== null) {
      await update($, ttl, (): TtlInfo => ({ value: ttlOption, source: 'option' }))
    } else {
      const value = await accountTtl($)
      await update($, ttl, (current): TtlInfo =>
        current.source === 'reply' ? current : { value, source: 'account' },
      )
    }

    $.clock.every(20_000, () => {
      void onTick($)
    })

    return next(e)
  })

  // A resumed conversation: start the clock from its last reply.
  on('classic.SessionStart', async ($, e, next) => {
    const seconds = e.seconds_since_last_response
    const context = e.context_tokens
    if (seconds !== undefined && context !== undefined && context > 0) {
      const now = await $.clock.now()
      const model = e.model ?? (await $.session.model())
      await update($, touch, last =>
        last ?? { at: now - seconds * 1000, tokens: context, model },
      )
    }

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) flags.isBusy = true

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      flags.isBusy = false
      // The usage windows arrive with the first reply: settle the lifetime again.
      if (ttlOption === null && (await read($, ttl)).source === 'account') {
        const value = await accountTtl($)
        await update($, ttl, (current): TtlInfo => (current.source === 'account' ? { value, source: 'account' } : current))
      }
      await update($, tick, n => n + 1)
    }

    return next(e)
  })

  // Every main-thread request re-reads (or rewrites) the cache: the clock
  // restarts when it is sent, and its usage says how big the prefix is.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const at = await $.clock.now()
    const step = yield* next(e)
    try {
      const usage = step.usage
      if (usage !== null) {
        const size =
          usage.input_tokens +
          usage.cache_read_input_tokens +
          usage.cache_creation_input_tokens +
          usage.output_tokens
        await update($, touch, (): Touch => ({ at, tokens: size, model: usage.model }))
      }
    } catch {
      // The clock is a display: a failed write never touches the turn.
    }

    return step
  })

  // A subagent's reply carries Anthropic's own cache record, which says
  // whether this account writes 1-hour or 5-minute entries right now.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      if (ttlOption === null && ran.result !== undefined) {
        const record = ran.result as unknown as {
          usage?: {
            cache_creation?: {
              ephemeral_1h_input_tokens: number
              ephemeral_5m_input_tokens: number
            } | null
          }
        }
        const created = record.usage?.cache_creation
        if (created && created.ephemeral_1h_input_tokens > 0) {
          await update($, ttl, (): TtlInfo => ({ value: '1h', source: 'reply' }))
        } else if (created && created.ephemeral_5m_input_tokens > 0) {
          await update($, ttl, (): TtlInfo => ({ value: '5m', source: 'reply' }))
        }
      }
    } catch {
      // Reading the record is best effort.
    }

    return ran
  }).catch(($, e, next) => next(e))

  // The person is back: a real prompt ends the keep-warm.
  on('prompt.submit', async ($, e, next) => {
    if (e.command === undefined && e.isMeta === undefined) {
      await stopKeepWarm($, say().why.back)
    }

    return next(e)
  })

  on('command.run', { command: 'keep-warm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (['off', 'stop', 'no', 'non', 'arret', 'arrêt'].includes(arg)) {
      await update($, warmUntil, () => null)
      return { text: say().off }
    }

    const last = await read($, touch)
    if (last === null) {
      return { text: say().none }
    }

    const now = await $.clock.now()
    const info = await read($, ttl)
    if (now >= last.at + ttlMs(info)) {
      return { text: say().late }
    }

    const hours = Number(arg.replace(',', '.'))
    const duration = arg !== '' && Number.isFinite(hours) && hours > 0 ? Math.min(hours, 12) * HOUR : keepWarmMs
    await update($, warmUntil, () => now + duration)
    const price = costs(last, info)
    const each = price === null ? '' : say().each(money(price.warm), money(price.cold))

    return { text: say().on(span(duration), each) }
  })

  on('command.run', { command: 'cache-clock' }, async $ => {
    await update($, isHidden, hidden => !hidden)
    const hidden = await read($, isHidden)

    return { text: hidden ? say().hidden : say().shown }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || e.props.isWorking || e.props.view.agentId !== undefined) return below

    const last = await read($, touch)
    if (last === null || (await read($, isHidden))) return below

    await read($, tick)
    const info = await read($, ttl)
    const until = await read($, warmUntil)
    const pinged = await read($, lastPing)
    const now = await $.clock.now()
    const remaining = last.at + ttlMs(info) - now
    const price = costs(last, info)
    const { Box, Text, Button } = $.ui.resolve(e)

    const startKeepWarm = async () => {
      const at = await $.clock.now()
      await update($, warmUntil, () => at + keepWarmMs)
      $.ui.toast(say().started(span(keepWarmMs)))
    }
    const stop = () => update($, warmUntil, () => null)
    const t = say()

    if (remaining <= 0) {
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text color="#4C8BF5">{t.coldFor(span(-remaining))}</Text>
            <Text dimColor>
              {t.coldNext(tokens(last.tokens))}
              {price === null ? '' : ` (≈ ${money(price.cold)})`}
            </Text>
          </Box>
          {below}
        </Box>
      )
    }

    const isLate = remaining < marginMs(info) + MINUTE
    const pingLine =
      until !== null && pinged !== null
        ? pinged.isOk
          ? t.lastPing(span(now - pinged.at), tokens(pinged.cacheRead))
          : t.lastPingNote(noteText(pinged.note))
        : ''

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={isLate ? '#D4A017' : '#2E9E5B'}>
            {t.warmLine(span(remaining))}
          </Text>
          <Text dimColor>
            {price === null ? t.cached(tokens(last.tokens), info.value) : t.next(money(price.warm), money(price.cold))}
          </Text>
          {until === null ? (
            <Button key="keep-warm" dimColor onPress={() => void startKeepWarm()}>
              {t.keepButton(span(keepWarmMs))}
            </Button>
          ) : (
            <Text color="#E8590C">{t.kept(span(until - now))}{pingLine}</Text>
          )}
          {until !== null && (
            <Button key="stop-warm" dimColor onPress={() => void stop()}>
              {t.stop}
            </Button>
          )}
        </Box>
        {below}
      </Box>
    )
  })
}
