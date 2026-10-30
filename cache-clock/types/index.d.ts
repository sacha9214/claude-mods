export type CacheTtl = '1h' | '5m'

/** Where the lifetime came from: the option, a reply's cache record, or the account kind. */
export type TtlInfo = { value: CacheTtl; source: 'option' | 'reply' | 'account' }

/** The main thread's last request: when it was sent and how many tokens the next one re-reads. */
export type Touch = { at: number; tokens: number; model: string }

/** The last keep-warm ping. `note`: 'nothing', 'cold' or 'failed:<reason>', worded when drawn. */
export type Ping = { at: number; isOk: boolean; cacheRead: number; note: string }

declare module 'claude-code' {
  interface PluginState {
    'cache-clock': {
      touch: Touch | null
      ttl: TtlInfo
      warmUntil: number | null
      lastPing: Ping | null
      tick: number
      isHidden: boolean
    }
  }
}
