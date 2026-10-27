# claude-mods

Two Claude Code mods (function-hook plugins) that make long sessions cheaper and subagents visible. They work in the terminal and in the Claude desktop app. The on-screen text is in French.

## cache-clock

A line above the prompt, shown while Claude is idle: how long the conversation's prompt cache stays warm, and what your next message costs warm versus cold.

> ⏱ Cache chaud · froid dans 47 min · prochain message ≈ 0,06 $ (froid : 2,43 $) [Garder chaud 2 h]

- `/keep-warm [off | hours]`, or the "Garder chaud" button: just before the cache expires, a hidden fork re-reads the cached prefix (`$.model.fork`), so nothing is added to the conversation. In a live test it read 99.98% of a 303k-token conversation from the cache, about $0.06 per ping on Opus 5.5. It stops on your next real message, after the set duration (2 h by default), or if a ping finds the cache already cold.
- `/cache-clock` hides or shows the line.
- Cache lifetime: 1 hour on a Claude subscription (detected from its usage windows), 5 minutes with an API key. Options: `ttl` (`auto`, `1h`, `5m`) and `keepWarmHours`.
- Prices are list prices per million tokens (for example Opus 5.5: input $4, cache read $0.20, 1-hour cache write $8). On a subscription they stand for usage, not money.

## helper-desk

- A purple progress bar above the prompt for the current task list (the desktop app's plan, or TodoWrite / TaskCreate / TaskUpdate in the terminal), with the step in progress and a button when subagents are running.
- A side panel that opens at the first subagent (or with `/helpers`): the session cost from `/cost`, the main thread, then each subagent with its own color, its share of the cost, estimated cost, status, duration, tool count and current action.

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install cache-clock --marketplace sacha9214/claude-mods
```

```text
/plugin install helper-desk --marketplace sacha9214/claude-mods
```

From a shell:

```bash
claude plugin install cache-clock --marketplace sacha9214/claude-mods
```

```bash
claude plugin install helper-desk --marketplace sacha9214/claude-mods
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

Tested on Claude Code 2.1.309. The mod API is early access and may change between releases.

## Credits

Ideas from Ben AI's video "9 Insane Claude Mods I Already Can't Live Without", which credits [cache-tax](https://github.com/karanb192/cache-tax) by Karan Bansal and [claude-kit](https://github.com/JohnnyVizz/claude-kit) by JohnnyVizz. The code here is written from scratch.

## License

MIT
