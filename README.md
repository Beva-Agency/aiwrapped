# wrappedai

Your year with your AI coding agents, in one image: Claude Code, Codex, Cursor, Gemini CLI, Antigravity, OpenCode, Copilot CLI, Pi, Qwen Code and Cline.
Ton année avec tes agents IA, en une image.

```bash
npx wrappedai
```

The CLI reads your logs locally, adds up totals (tokens, sessions, hours, tools, models) and opens your Wrapped on [wrapped.mazaki.fr](https://wrapped.mazaki.fr). Your prompts, your code and the models' answers never leave your machine.

Le CLI lit tes logs en local, additionne des totaux et ouvre ton Wrapped sur [wrapped.mazaki.fr](https://wrapped.mazaki.fr). Tes prompts, ton code et les réponses des modèles ne quittent pas ta machine.

## What it reads

| Tool | Path | Tokens |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` (or `$CLAUDE_CONFIG_DIR`) | yes |
| Codex | `~/.codex/sessions/**/*.jsonl` and `~/.codex/archived_sessions` (or `$CODEX_HOME`) | yes |
| Gemini CLI | `~/.gemini/tmp/*/chats/session-*.json(l)` | yes |
| Antigravity | `~/.gemini/{antigravity,antigravity-ide,antigravity-cli}/conversations/*.db` | yes (recent `.db` conversations; older encrypted `.pb` ones: messages and hours only, from their plain transcript) |
| Cursor | `Cursor/User/globalStorage/state.vscdb` (IDE) and `~/.cursor/projects/*/agent-transcripts` (CLI) | with `--cursor-csv` only, see below |
| OpenCode | `~/.local/share/opencode/opencode.db` and older `storage/` files (or `$XDG_DATA_HOME`, `$OPENCODE_DATA_DIR`) | yes |
| Copilot CLI | `~/.copilot/session-state/*/events.jsonl` (or `$COPILOT_HOME`) | yes |
| Pi | `~/.pi/agent/sessions/*/*.jsonl` (or `$PI_CODING_AGENT_DIR`) | yes |
| Qwen Code | `~/.qwen/projects/*/chats/*.jsonl` (or `$QWEN_HOME`) | yes |
| Cline | `globalStorage/saoudrizwan.claude-dev/tasks/*/ui_messages.json` in VS Code, VS Code Insiders, VSCodium, Cursor and Windsurf, and `~/.cline/data/tasks` | yes |

Cursor, Antigravity and OpenCode store their data in SQLite. The CLI reads it with Node's built-in `node:sqlite`, available from **Node 22.13**. On an older Node, these databases are skipped (Antigravity still gives messages and hours from its transcripts) and the terminal says so. Everything else works from Node 18.

The CLI never opens credentials: not Cursor's `cursorAuth/accessToken`, not Antigravity's `state.vscdb`.

### Cursor tokens

Since early 2026 Cursor no longer stores token counts on your machine. The CLI still counts your Cursor sessions, messages, hours and tools. For exact tokens, download your usage from [cursor.com/dashboard](https://cursor.com/dashboard) (Usage, Export CSV) and pass the file:

```bash
npx wrappedai --cursor-csv ~/Downloads/usage-events.csv
```

The file stays on your machine like everything else.

## What gets sent

Only aggregated totals, encoded in the URL after the `#` (your browser never sends that part to the server). The page then adds your anonymous totals to the global counter, unless you pass `--no-stats`. Run `npx wrappedai --json` to see exactly what would be sent.

## Options

```
--year <YYYY>          a specific year (default: the current year)
--since <YYYY-MM-DD>   from a date
--all                  your whole history
--only <tools>         only these tools: claude, codex, gemini, antigravity, cursor,
                       opencode, copilot, pi, qwen, cline (comma separated)
--cursor-csv <file>    exact Cursor tokens from the dashboard's usage export
--hide-projects        replace project names with projet-1, projet-2…
--no-stats             don't count this Wrapped in the global stats
--no-open              print the link without opening the browser
--json                 print the data that would be sent, and stop
--lang <fr|en>         terminal and website language
--<tool>-dir <path>    a tool's folder if it is not in its usual place,
                       e.g. --claude-dir, --codex-dir, --opencode-dir, --cursor-dir
```

`NO_COLOR` is respected.

## Only one month of Claude Code?

By default Claude Code deletes sessions inactive for 30 days. For a full-year Wrapped, add this to `~/.claude/settings.json`:

```json
{ "cleanupPeriodDays": 365 }
```

## Adding a tool

1. A parser in `src/parsers/` that turns the tool's files into `usage`, `prompt`, `call` and `activity` events (see `src/collect.ts` for the token conventions: input without cache, output with reasoning, cache writes, cache reads).
2. An entry in `src/sources.ts` and the id in `TOOL_IDS` (`src/collect.ts`).
3. The same id on the website (`src/lib/payload/schema.ts`), with its name and color. The website must ship first: it rejects tools it does not know.

## Development

```bash
npm install
npm run typecheck
npm run build                  # dist/cli.cjs, zero runtime dependencies
node dist/cli.cjs --url http://localhost:3000
WRAPPEDAI_NO_SQLITE=1 node dist/cli.cjs   # behave like Node < 22.13
```

Parsers for the newer tools follow the formats documented by existing open-source trackers (codeburn, ccusage, tokscale, agentsview, agy-reader).

Not affiliated with Anthropic, OpenAI, Google, Anysphere (Cursor), GitHub or any other tool maker. MIT license.
