// The arithmetic of time-left, kept apart from the hooks so tests reach it
// directly. Every duration is in milliseconds of active time.

export type Range = { low: number; mid: number; high: number }

/** One estimate judged after the fact: actual over the raw middle, and whether the shown range held it. */
export type Judged = { kind: 'plan' | 'turn'; ratio: number; hit: boolean }

/** What the mod keeps across sessions in `$.store`. */
export type History = { steps: number[]; turns: number[]; judged: Judged[] }

/** Step durations to lean on before any were measured: 45 s to 6 min. */
export const PRIOR_STEPS = [45, 60, 90, 120, 180, 240, 360].map(s => s * 1000)

const KEEP_STEPS = 200
const KEEP_TURNS = 200
const KEEP_JUDGED = 80

const numbers = (value: unknown): number[] =>
  Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0) : []

/** Reads what the store holds, whatever shape an older version left there. */
export const asHistory = (value: unknown): History => {
  const raw = (value ?? {}) as { steps?: unknown; turns?: unknown; judged?: unknown }
  const judged = Array.isArray(raw.judged)
    ? raw.judged.filter(
        (j): j is Judged =>
          typeof j === 'object' &&
          j !== null &&
          (j.kind === 'plan' || j.kind === 'turn') &&
          typeof j.ratio === 'number' &&
          Number.isFinite(j.ratio) &&
          typeof j.hit === 'boolean',
      )
    : []

  return { steps: numbers(raw.steps), turns: numbers(raw.turns), judged }
}

export const withStep = (h: History, ms: number): History => ({ ...h, steps: [...h.steps, ms].slice(-KEEP_STEPS) })
export const withTurn = (h: History, ms: number): History => ({ ...h, turns: [...h.turns, ms].slice(-KEEP_TURNS) })
export const withJudged = (h: History, more: Judged[]): History => ({
  ...h,
  judged: [...h.judged, ...more].slice(-KEEP_JUDGED),
})

export const quantile = (sorted: readonly number[], q: number): number => {
  if (sorted.length === 0) return 0
  const pos = (sorted.length - 1) * q
  const below = sorted[Math.floor(pos)] ?? 0
  const above = sorted[Math.ceil(pos)] ?? below

  return below + (above - below) * (pos - Math.floor(pos))
}

export const median = (values: readonly number[]): number => quantile([...values].sort((a, b) => a - b), 0.5)

// A small seeded generator (mulberry32): the same plan and step draw the same
// samples, so the range moves with the clock and does not flicker.
const random = (seed: number) => {
  let t = seed >>> 0

  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)

    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Time left on a plan: the rest of the step in progress, given how long it
 * has run, plus `after` steps still to start, each drawn from `pool`.
 * Bootstrapped, so the range of the sum is that of a sum, not n times a range.
 */
export const planRange = (
  pool: readonly number[],
  currentElapsed: number | null,
  after: number,
  seed: number,
): Range => {
  const samples = pool.length >= 4 ? [...pool] : [...pool, ...PRIOR_STEPS]
  const rest =
    currentElapsed === null
      ? []
      : (() => {
          const longer = samples.filter(d => d > currentElapsed).map(d => d - currentElapsed)
          // Past everything measured: say as much again as half what it ran.
          return longer.length > 0 ? longer : [Math.max(15_000, currentElapsed * 0.5)]
        })()
  const draw = random(seed)
  const pick = (list: readonly number[]) => list[Math.floor(draw() * list.length)] ?? 0
  const totals: number[] = []
  for (let i = 0; i < 400; i++) {
    let total = rest.length > 0 ? pick(rest) : 0
    for (let k = 0; k < after; k++) total += pick(samples)
    totals.push(total)
  }
  totals.sort((a, b) => a - b)

  return { low: quantile(totals, 0.2), mid: quantile(totals, 0.5), high: quantile(totals, 0.8) }
}

/**
 * Time left on a turn with no plan: how much longer the past turns that ran
 * at least this long went on. Null while the history is too thin to say.
 */
export const turnRange = (turns: readonly number[], elapsed: number): Range | null => {
  if (turns.length < 8) return null
  const longer = turns
    .filter(d => d > elapsed)
    .map(d => d - elapsed)
    .sort((a, b) => a - b)
  if (longer.length < 3) return null

  return { low: quantile(longer, 0.2), mid: quantile(longer, 0.5), high: quantile(longer, 0.8) }
}

/** How much to stretch or shrink raw estimates: the median of actual over predicted, once five were judged. */
export const correction = (judged: readonly Judged[], kind: 'plan' | 'turn'): number => {
  const ratios = judged.filter(j => j.kind === kind).map(j => j.ratio)
  if (ratios.length < 5) return 1

  return Math.min(2.5, Math.max(0.5, median(ratios)))
}

/** Share of judged estimates whose range held what happened, or null under five. */
export const hitRate = (judged: readonly Judged[], kind: 'plan' | 'turn'): number | null => {
  const mine = judged.filter(j => j.kind === kind).slice(-50)
  if (mine.length < 5) return null

  return mine.filter(j => j.hit).length / mine.length
}

export const scaled = (r: Range, factor: number): Range => ({
  low: r.low * factor,
  mid: r.mid * factor,
  high: r.high * factor,
})

const seconds = (ms: number) => Math.max(5, Math.round(ms / 5000) * 5)

/** The words the spinner line and the band show. */
export const rangeLabel = (r: Range): string => {
  if (r.high < 20_000) return 'presque fini'
  if (r.high < 90_000) {
    const low = seconds(r.low)
    const high = Math.max(low, seconds(r.high))
    return low === high ? `≈ ${low} s` : `≈ ${low}–${high} s`
  }
  const low = Math.max(1, Math.round(r.low / 60_000))
  const high = Math.max(low, Math.round(r.high / 60_000))

  return low === high ? `≈ ${low} min` : `≈ ${low}–${high} min`
}

/** A duration as the stats command writes it. */
export const duration = (ms: number): string =>
  ms < 90_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 60_000).toFixed(1).replace('.', ',')} min`
