export type PlanStatus = 'pending' | 'in_progress' | 'completed'

/** One step of the task list, whichever tool wrote it. */
export type PlanItem = { id: string; content: string; status: PlanStatus }

/** Tokens and estimated cost of one loop (a subagent, or the main thread). */
export type Spend = {
  input: number
  output: number
  read: number
  write: number
  usd: number
  isPriced: boolean
  model: string
}

/** One subagent as the panel shows it. */
export type AgentRow = {
  id: string
  description: string
  type: string
  color: string
  status: string
  startedAt: number
  endedAt: number | null
  tools: number
  activity: string
  spend: Spend
}

declare module 'claude-code' {
  interface PluginState {
    'helper-desk': {
      plan: PlanItem[]
      agents: AgentRow[]
      main: Spend
      sessionUsd: number | null
      writeFactor: number
      hasAutoOpened: boolean
      tick: number
    }
  }
}
