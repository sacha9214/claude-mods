# claude-mods

Three Claude Code mods (function-hook plugins) that make long sessions cheaper, subagents visible and waiting less blind. Each one works on its own. They work in the terminal and in the Claude desktop app. cache-clock speaks English, or French when Claude's `language` setting or your system locale is French; helper-desk and time-left are in French for now.

## cache-clock

A line above the prompt, shown while Claude is idle: how long the conversation's prompt cache stays warm, and what your next message costs warm versus cold.

> ⏱ Cache warm · cold in 47 min · next message ≈ $0.06 (cold: $2.43) [Keep warm 2 h]

- `/keep-warm [off | hours]`, or the "Keep warm" button: just before the cache expires, a hidden fork re-reads the cached prefix (`$.model.fork`), so nothing is added to the conversation. In a live test it read 99.98% of a 303k-token conversation from the cache, about $0.06 per ping on Opus 5.5. It stops on your next real message, after the set duration (2 h by default), or if a ping finds the cache already cold.
- `/cache-clock` hides or shows the line.
- Cache lifetime: 1 hour on a Claude subscription (detected from its usage windows), 5 minutes with an API key. Options: `ttl` (`auto`, `1h`, `5m`), `keepWarmHours`, and `language` (`auto`, `en`, `fr`): `auto` picks French when Claude's `language` setting, `LC_ALL`, `LC_MESSAGES` or `LANG` says French, and English otherwise.
- Prices are list prices per million tokens (for example Opus 5.5: input $4, cache read $0.20, 1-hour cache write $8). On a subscription they stand for usage, not money.

## helper-desk

- A purple progress bar above the prompt for the current task list (the desktop app's plan, or TodoWrite / TaskCreate / TaskUpdate in the terminal), with the step in progress and a button when subagents are running.
- A side panel that opens at the first subagent (or with `/helpers`): the session cost from `/cost`, the main thread, then each subagent with its own color, its share of the cost, estimated cost, status, duration, tool count and current action.

## time-left

While Claude works, an estimate of how long it has left: at the end of the spinner line, and on a line above the prompt.

> En cours… · ≈ 4–7 min
>
> ⏳ ≈ 4–7 min restantes · étape 3/7 · d'après 42 étapes mesurées · fourchette juste 72 % du temps

- With a task list, the steps still to go are drawn from your own past step durations (this plan's steps count double), and the step in progress counts only what is left of it given how long it has run. A bootstrap over the samples gives a 20th–80th percentile range, not a single number.
- Without a task list, after 8 measured turns: how much longer your past turns went on once they had run this long. Before that, nothing is shown rather than a guess.
- Only active time counts: the wait while you answer a question is left out.
- Self-calibration: each estimate is judged when its plan or turn ends. After five verdicts, the median of actual over predicted stretches or shrinks the next ones, and the line says how often the range held.
- History lives in the mod's own store, across sessions. `/time-left` shows the statistics, `/time-left reset` clears them.
- Expect a wide range for the first plans: with no history it starts from 45 s to 6 min per step, and drops that prior after two measured steps.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install cache-clock --marketplace sacha9214/claude-mods
```

```text
/plugin install helper-desk --marketplace sacha9214/claude-mods
```

```text
/plugin install time-left --marketplace sacha9214/claude-mods
```

From a shell:

```bash
claude plugin install cache-clock --marketplace sacha9214/claude-mods
```

```bash
claude plugin install helper-desk --marketplace sacha9214/claude-mods
```

```bash
claude plugin install time-left --marketplace sacha9214/claude-mods
```

Answer `y` to add the marketplace, then pick a scope (user scope loads the mods in every session).

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `sacha9214/claude-mods`, then Add plugin. A mod installed from a terminal at the user scope also loads in the desktop app's local sessions.

## Develop

Clone the repository, then add the folder itself as a marketplace, so the mods are read from your working copy:

```bash
claude plugin marketplace add ./claude-mods
```

After an edit, run `/reload-plugins` or start a new session. Checks:

```bash
claude plugin validate ./claude-mods
```

```bash
claude plugin test ./claude-mods/cache-clock
```

```bash
claude plugin test ./claude-mods/helper-desk
```

```bash
claude plugin test ./claude-mods/time-left
```

Tested on Claude Code 2.1.309. The mod API is early access and may change between releases.

## Credits

Ideas from Ben AI's video "9 Insane Claude Mods I Already Can't Live Without", which credits [cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal and [claude-kit](https://github.com/JohnnyVizz/claude-kit) by JohnnyVizz. The code here is written from scratch.

## License

MIT
