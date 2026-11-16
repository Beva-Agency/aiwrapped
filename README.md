# aiwrapped

Your year with Claude Code, Codex and Gemini CLI, in one image.
Ton année avec Claude Code, Codex et Gemini CLI, en une image.

```bash
npx aiwrapped
```

The CLI reads your logs locally, adds up totals (tokens, sessions, hours, tools, models) and opens your Wrapped on [wrapped.mazaki.fr](https://wrapped.mazaki.fr). Your prompts, your code and the models' answers never leave your machine.

Le CLI lit tes logs en local, additionne des totaux et ouvre ton Wrapped sur [wrapped.mazaki.fr](https://wrapped.mazaki.fr). Tes prompts, ton code et les réponses des modèles ne quittent pas ta machine.

## What it reads

| Tool | Path |
|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) |
| Codex | `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions` (or `$CODEX_HOME`) |
| Gemini CLI | `~/.gemini/tmp/*/chats/session-*.json(l)` |

## What gets sent

Only aggregated totals, encoded in the URL after the `#` (your browser never sends that part to the server). The page then adds your anonymous totals to the global counter, unless you pass `--no-stats`. Run `npx aiwrapped --json` to see exactly what would be sent.

## Options

```
--year <YYYY>          a specific year (default: the current year)
--since <YYYY-MM-DD>   from a date
--all                  your whole history
--only <tools>         claude,codex,gemini
--hide-projects        replace project names with projet-1, projet-2…
--no-stats             don't count this Wrapped in the global stats
--no-open              print the link without opening the browser
--json                 print the data that would be sent, and stop
--lang <fr|en>         terminal and website language
--claude-dir <path>    Claude Code folder (default: ~/.claude)
--codex-dir <path>     Codex folder (default: ~/.codex)
--gemini-dir <path>    Gemini CLI folder (default: ~/.gemini)
```

`NO_COLOR` is respected.

## Only one month of Claude Code?

By default Claude Code deletes sessions inactive for 30 days. For a full-year Wrapped, add this to `~/.claude/settings.json`:

```json
{ "cleanupPeriodDays": 365 }
```

## Development

```bash
npm install
npm run typecheck
npm run build                  # dist/cli.cjs, zero runtime dependencies
node dist/cli.cjs --url http://localhost:3000
```

Not affiliated with Anthropic, OpenAI or Google. MIT license.
