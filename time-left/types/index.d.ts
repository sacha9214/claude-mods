export type PlanStatus = 'pending' | 'in_progress' | 'completed'

/** One step of the task list, whichever tool wrote it. */
export type PlanItem = { id: string; content: string; status: PlanStatus }

/**
 * Active time: how long main turns have run, waits on the person left out.
 * `runningSince` is set while a main turn runs.
 */
export type ActiveClock = { activeMs: number; runningSince: number | null }

/** The plan as followed: its steps, when (in active time) the last step ended, and this plan's measured steps. */
export type Tracked = { items: PlanItem[]; mark: number; version: number; durations: number[] }

/** An estimate waiting to be judged against what really happened. `mid` is the raw (uncorrected) middle. */
export type Pending = { kind: 'plan' | 'turn'; key: string; at: number; mid: number; low: number; high: number }

/** What the spinner line and the band show. */
export type Estimate = {
  kind: 'plan' | 'turn'
  low: number
  mid: number
  high: number
  done: number
  total: number
  basis: string
}

declare module 'claude-code' {
  interface PluginState {
    'time-left': {
      clock: ActiveClock
      tracked: Tracked
      pending: Pending[]
      estimate: Estimate | null
      turnStart: number | null
    }
  }
}
