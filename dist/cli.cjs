#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod2, isNodeMode, target) => (target = mod2 != null ? __create(__getProtoOf(mod2)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod2 || !mod2.__esModule ? __defProp(target, "default", { value: mod2, enumerable: true }) : target,
  mod2
));

// src/index.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_fs8 = __toESM(require("node:fs"));
var import_node_os4 = __toESM(require("node:os"));
var import_node_path14 = __toESM(require("node:path"));
var import_node_zlib = require("node:zlib");

// src/collect.ts
var TOOL_IDS = ["claude", "codex", "gemini", "antigravity", "cursor", "opencode", "copilot", "pi", "qwen", "cline"];
var DAY = 864e5;
var IDLE_GAP = 15 * 6e4;
function localDay(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function bucketOf(promptSize) {
  if (promptSize > 272e3) return 3;
  if (promptSize > 2e5) return 2;
  if (promptSize > 1e5) return 1;
  return 0;
}
var Aggregator = class {
  constructor(range) {
    this.range = range;
  }
  range;
  models = /* @__PURE__ */ new Map();
  daily = /* @__PURE__ */ new Map();
  hours = new Array(24).fill(0);
  week = new Array(168).fill(0);
  sessions = /* @__PURE__ */ new Map();
  projects = /* @__PURE__ */ new Map();
  calls = /* @__PURE__ */ new Map();
  filesRead = /* @__PURE__ */ new Set();
  filesEdited = /* @__PURE__ */ new Set();
  filesCreated = /* @__PURE__ */ new Set();
  toolStats = Object.fromEntries(
    TOOL_IDS.map((id) => [id, { files: 0, sessions: /* @__PURE__ */ new Set(), prompts: 0, first: Infinity }])
  );
  promptCount = 0;
  promptChars = 0;
  longestPrompt = 0;
  plan = 0;
  subagents = 0;
  web = 0;
  linesAdded = /* @__PURE__ */ new Map();
  linesRemoved = /* @__PURE__ */ new Map();
  minTs = Infinity;
  maxTs = -Infinity;
  rangeStart() {
    return this.range.start;
  }
  inRange(ts) {
    return Number.isFinite(ts) && ts >= this.range.start && ts <= this.range.end;
  }
  fileScanned(tool) {
    this.toolStats[tool].files += 1;
  }
  /** Bornes de la période et premier jour de l’outil. */
  mark(tool, ts) {
    if (ts < this.toolStats[tool].first) this.toolStats[tool].first = ts;
    if (ts < this.minTs) this.minTs = ts;
    if (ts > this.maxTs) this.maxTs = ts;
  }
  touch(tool, ts, session) {
    const key = `${tool}:${session}`;
    let s = this.sessions.get(key);
    if (!s) {
      s = { times: [], prompts: 0 };
      this.sessions.set(key, s);
    }
    s.times.push(ts);
    this.toolStats[tool].sessions.add(session);
    this.mark(tool, ts);
    return s;
  }
  /**
   * Activité sans tokens ni message (réponse de l’agent, appel d’outil) : prolonge la session pour le temps actif.
   * Sert aux outils qui ne gardent pas l’usage en local (Cursor) ou dont on ne lit que le transcript.
   */
  activity(tool, ts, session) {
    if (!this.inRange(ts) || !session) return;
    this.touch(tool, ts, session);
  }
  usage(e) {
    if (!this.inRange(e.ts)) return;
    const vals = [e.inp, e.out, e.cw5, e.cw1, e.cr, e.rs].map((v) => Number.isFinite(v) && v > 0 ? Math.round(v) : 0);
    const total = vals[0] + vals[1] + vals[2] + vals[3] + vals[4];
    if (total === 0) return;
    const b = bucketOf(e.promptSize);
    const f = !!e.fast;
    const key = `${e.tool}|${e.model}|${b}|${f ? 1 : 0}`;
    let row = this.models.get(key);
    if (!row) {
      row = { t: e.tool, m: e.model.slice(0, 80), b, f, u: [0, 0, 0, 0, 0, 0], n: 0 };
      this.models.set(key, row);
    }
    for (let i = 0; i < 6; i++) row.u[i] += vals[i];
    row.n += e.requests && e.requests > 1 ? Math.round(e.requests) : 1;
    const day = localDay(e.ts);
    const d = this.daily.get(day) ?? [0, 0];
    d[1] += total;
    this.daily.set(day, d);
    if (e.project) {
      const p = this.projects.get(e.project) ?? [0, 0];
      p[0] += total;
      this.projects.set(e.project, p);
    }
    if (e.session) this.touch(e.tool, e.ts, e.session);
    else this.mark(e.tool, e.ts);
  }
  prompt(e) {
    if (!this.inRange(e.ts)) return;
    this.promptCount += 1;
    this.promptChars += e.chars;
    if (e.chars > this.longestPrompt) this.longestPrompt = e.chars;
    this.toolStats[e.tool].prompts += 1;
    const date = new Date(e.ts);
    const h = date.getHours();
    const dow = (date.getDay() + 6) % 7;
    this.hours[h] += 1;
    this.week[dow * 24 + h] += 1;
    const day = localDay(e.ts);
    const d = this.daily.get(day) ?? [0, 0];
    d[0] += 1;
    this.daily.set(day, d);
    if (e.project) {
      const p = this.projects.get(e.project) ?? [0, 0];
      p[1] += 1;
      this.projects.set(e.project, p);
    }
    this.touch(e.tool, e.ts, e.session).prompts += 1;
  }
  call(e) {
    if (!this.inRange(e.ts)) return;
    this.calls.set(e.name, (this.calls.get(e.name) ?? 0) + 1);
    if (e.file) {
      const f = `${e.tool}:${e.file}`;
      if (e.name === "Read") this.filesRead.add(f);
      else if (e.name === "Edit" || e.name === "Write") {
        this.filesEdited.add(f);
        if (e.creates) this.filesCreated.add(f);
      }
    }
    if (e.name === "Plan") this.plan += 1;
    if (e.name === "Task") this.subagents += 1;
    if (e.name === "WebSearch" || e.name === "WebFetch") this.web += 1;
  }
  /** compteurs cumulés par session (Claude « cost-state ») : on garde le maximum */
  lines(session, added, removed) {
    if (added > (this.linesAdded.get(session) ?? 0)) this.linesAdded.set(session, added);
    if (removed > (this.linesRemoved.get(session) ?? 0)) this.linesRemoved.set(session, removed);
  }
  hasActivity() {
    return this.models.size > 0 || this.promptCount > 0;
  }
  firstDay(tool) {
    const f = this.toolStats[tool].first;
    return Number.isFinite(f) ? localDay(f) : void 0;
  }
  build(opts) {
    const from = localDay(this.minTs);
    const to = localDay(this.maxTs);
    const fromDate = /* @__PURE__ */ new Date(`${from}T00:00:00`);
    const durations = [];
    let minutes = 0;
    let longSessions = 0;
    let sessionCount = 0;
    for (const s of this.sessions.values()) {
      s.times.sort((a, b) => a - b);
      let active = 0;
      for (let i = 1; i < s.times.length; i++) {
        const gap = s.times[i] - s.times[i - 1];
        if (gap <= IDLE_GAP) active += gap;
      }
      const m = active / 6e4;
      minutes += m;
      if (s.prompts > 0 || s.times.length > 1) {
        sessionCount += 1;
        durations.push(m);
        if (m >= 120) longSessions += 1;
      }
    }
    durations.sort((a, b) => a - b);
    const medianSession = durations.length ? durations[Math.floor(durations.length / 2)] : 0;
    const daily = [];
    for (const [day, [prompts, tokens]] of this.daily) {
      const idx = Math.round(((/* @__PURE__ */ new Date(`${day}T00:00:00`)).getTime() - fromDate.getTime()) / DAY);
      if (idx >= 0) daily.push([idx, prompts, Math.round(tokens / 1e3)]);
    }
    daily.sort((a, b) => a[0] - b[0]);
    const projects = [...this.projects.entries()].filter(([, [tokens]]) => tokens > 0).sort((a, b) => b[1][0] - a[1][0]).slice(0, 4).map(([name, [tokens, prompts]], i) => [opts.hideProjects ? `projet-${i + 1}` : name.slice(0, 60), tokens, prompts]);
    const calls = [...this.calls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([name, n]) => [name.slice(0, 40), n]);
    const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
    const tools = {};
    for (const t of opts.tools) {
      const st = this.toolStats[t];
      if (st.files === 0 && st.sessions.size === 0) continue;
      let tm = 0;
      for (const [key, s] of this.sessions) {
        if (!key.startsWith(`${t}:`)) continue;
        for (let i = 1; i < s.times.length; i++) {
          const gap = s.times[i] - s.times[i - 1];
          if (gap <= IDLE_GAP) tm += gap;
        }
      }
      tools[t] = {
        files: st.files,
        sessions: st.sessions.size,
        prompts: st.prompts,
        minutes: Math.round(tm / 6e4),
        ...this.firstDay(t) ? { first: this.firstDay(t) } : {}
      };
    }
    return {
      v: 1,
      id: opts.id,
      ...opts.noStats ? { ns: true } : {},
      cli: opts.cli,
      gen: (/* @__PURE__ */ new Date()).toISOString(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: opts.lang,
      from,
      to,
      scope: opts.scope,
      ...opts.year ? { year: opts.year } : {},
      tools,
      models: [...this.models.values()].sort((a, b) => b.u.reduce((x, y) => x + y, 0) - a.u.reduce((x, y) => x + y, 0)).slice(0, 300).map((r) => ({ t: r.t, m: r.m, b: r.b, ...r.f ? { f: true } : {}, u: r.u, n: r.n })),
      hours: this.hours,
      week: this.week,
      daily,
      prompts: this.promptCount,
      sessions: sessionCount,
      minutes: Math.round(minutes),
      avgPrompt: this.promptCount ? Math.round(this.promptChars / this.promptCount) : 0,
      longestPrompt: this.longestPrompt,
      longSessions,
      medianSession: Math.round(medianSession),
      plan: this.plan,
      subagents: this.subagents,
      web: this.web,
      calls,
      files: { read: this.filesRead.size, edited: this.filesEdited.size, created: this.filesCreated.size },
      ...this.linesAdded.size ? { lines: { added: sum(this.linesAdded), removed: sum(this.linesRemoved) } } : {},
      projects
    };
  }
};

// src/files.ts
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_node_readline = __toESM(require("node:readline"));
async function walk(root, accept, since = 0, maxDepth = 8) {
  const out2 = [];
  async function rec(dir, depth) {
    let entries;
    try {
      entries = await import_node_fs.default.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = import_node_path.default.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await rec(full, depth + 1);
      } else if (e.isFile() && accept(e.name)) {
        try {
          const st = await import_node_fs.default.promises.stat(full);
          if (st.mtimeMs >= since) out2.push({ path: full, size: st.size, mtime: st.mtimeMs });
        } catch {
        }
      }
    }
  }
  await rec(root, 0);
  return out2;
}
function exists(p) {
  try {
    return import_node_fs.default.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
async function eachLine(file, onLine) {
  const stream = import_node_fs.default.createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const rl = import_node_readline.default.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line) onLine(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
function safeJson(line) {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}
function str(v) {
  return typeof v === "string" ? v : "";
}
function obj(v) {
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}
function arr(v) {
  return Array.isArray(v) ? v : [];
}
function projectName(cwd) {
  if (!cwd) return void 0;
  const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return base || void 0;
}

// src/i18n.ts
function detectLang(forced) {
  if (forced === "fr" || forced === "en") return forced;
  const env2 = process.env;
  const candidates = [env2.LC_ALL, env2.LC_MESSAGES, env2.LANG, env2.LANGUAGE];
  try {
    candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
  }
  for (const c of candidates) {
    if (c && /^fr([_-]|$)/i.test(c)) return "fr";
  }
  return "en";
}
var fr = {
  tagline: "lecture locale, rien n\u2019est envoy\xE9",
  files: (n) => `${n} fichiers`,
  notFound: "introuvable",
  skipped: "ignor\xE9",
  cursorCsv: (n) => `${n} lignes import\xE9es de l\u2019export Cursor`,
  cursorNoTokens: "Cursor ne garde plus ses tokens en local : ajoute --cursor-csv <export> pour les avoir",
  needsSqlite: (v) => `base SQLite non lue : il faut Node 22.13 ou plus (tu as ${v})`,
  noData: "Aucune activit\xE9 trouv\xE9e sur cette p\xE9riode.",
  noDataHint: "Essaie --all pour tout l\u2019historique, ou v\xE9rifie qu\u2019un de tes agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode\u2026) tourne sur cette machine.",
  summary: (days, sessions) => `${days} jours \xB7 ${sessions} sessions \xB7 `,
  tokens: (t) => `${t} tokens`,
  opened: "ouvert dans ton navigateur. Tout est apr\xE8s le #,",
  opened2: "et ton navigateur ne l\u2019envoie jamais au serveur.",
  notOpened: "copie ce lien dans ton navigateur :",
  stats: "Tes totaux anonymes alimentent le compteur global. Pour refuser : --no-stats",
  noStats: "Stats globales d\xE9sactiv\xE9es (--no-stats).",
  retention: (d) => `Claude Code n\u2019a gard\xE9 que ${d} jours de logs. Pour une ann\xE9e enti\xE8re : "cleanupPeriodDays": 365 dans ~/.claude/settings.json`,
  period: { year: (y) => `ann\xE9e ${y}`, since: (d) => `depuis le ${d}`, all: "tout l\u2019historique" },
  help: `Usage : npx wrappedai [options]

Lit en local les logs de tes agents IA, calcule ton Wrapped et l\u2019ouvre sur
wrapped.mazaki.fr. Tes prompts et ton code ne quittent pas ta machine.

Outils lus : claude (Claude Code), codex, gemini (Gemini CLI), antigravity, cursor,
opencode, copilot (Copilot CLI), pi, qwen (Qwen Code), cline.
Cursor, Antigravity et OpenCode demandent Node 22.13 ou plus (base SQLite).

Options
  --year <AAAA>          une ann\xE9e pr\xE9cise (d\xE9faut : l\u2019ann\xE9e en cours)
  --since <AAAA-MM-JJ>   depuis une date
  --all                  tout l\u2019historique
  --only <outils>        seulement ces outils, par exemple claude,cursor
  --cursor-csv <fichier> tokens exacts de Cursor : l\u2019export Usage de cursor.com/dashboard
  --hide-projects        remplace les noms de projets par projet-1, projet-2\u2026
  --no-stats             ne pas compter ce Wrapped dans les statistiques globales
  --no-open              affiche le lien sans ouvrir le navigateur
  --json                 affiche les donn\xE9es qui seraient envoy\xE9es, et c\u2019est tout
  --lang <fr|en>         langue du terminal et du site
  --<outil>-dir <chemin> dossier d\u2019un outil s\u2019il n\u2019est pas \xE0 sa place habituelle,
                         par exemple --claude-dir ~/.claude ou --opencode-dir ~/.local/share/opencode
  -v, --version          version
  -h, --help             cette aide`
};
var en = {
  tagline: "local read, nothing is sent",
  files: (n) => `${n} files`,
  notFound: "not found",
  skipped: "skipped",
  cursorCsv: (n) => `${n} rows imported from the Cursor export`,
  cursorNoTokens: "Cursor no longer keeps its tokens locally: add --cursor-csv <export> to get them",
  needsSqlite: (v) => `SQLite database not read: needs Node 22.13 or later (you have ${v})`,
  noData: "No activity found for this period.",
  noDataHint: "Try --all for your whole history, or check that one of your agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode\u2026) runs on this machine.",
  summary: (days, sessions) => `${days} days \xB7 ${sessions} sessions \xB7 `,
  tokens: (t) => `${t} tokens`,
  opened: "opened in your browser. Everything is after the #,",
  opened2: "and your browser never sends that part to the server.",
  notOpened: "paste this link in your browser:",
  stats: "Your anonymous totals feed the global counter. To opt out: --no-stats",
  noStats: "Global stats disabled (--no-stats).",
  retention: (d) => `Claude Code only kept ${d} days of logs. For a full year: "cleanupPeriodDays": 365 in ~/.claude/settings.json`,
  period: { year: (y) => `year ${y}`, since: (d) => `since ${d}`, all: "full history" },
  help: `Usage: npx wrappedai [options]

Reads your AI agents\u2019 logs locally, computes your Wrapped and opens it on
wrapped.mazaki.fr. Your prompts and code never leave your machine.

Tools read: claude (Claude Code), codex, gemini (Gemini CLI), antigravity, cursor,
opencode, copilot (Copilot CLI), pi, qwen (Qwen Code), cline.
Cursor, Antigravity and OpenCode need Node 22.13 or later (SQLite database).

Options
  --year <YYYY>          a specific year (default: the current year)
  --since <YYYY-MM-DD>   from a date
  --all                  your whole history
  --only <tools>         only these tools, for example claude,cursor
  --cursor-csv <file>    exact Cursor tokens: the Usage export from cursor.com/dashboard
  --hide-projects        replace project names with projet-1, projet-2\u2026
  --no-stats             don\u2019t count this Wrapped in the global stats
  --no-open              print the link without opening the browser
  --json                 print the data that would be sent, and stop
  --lang <fr|en>         terminal and website language
  --<tool>-dir <path>    a tool\u2019s folder if it is not in its usual place,
                         for example --claude-dir ~/.claude or --opencode-dir ~/.local/share/opencode
  -v, --version          version
  -h, --help             this help`
};
var TEXT = { fr, en };

// src/parsers/cursor.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path2 = __toESM(require("node:path"));

// src/sqlite.ts
var mod;
function load() {
  if (mod !== void 0) return mod;
  if (process.env.WRAPPEDAI_NO_SQLITE === "1") return mod = null;
  const emit = process.emitWarning;
  process.emitWarning = ((warning, ...rest) => {
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (/sqlite/i.test(String(msg))) return;
    return emit.call(process, warning, ...rest);
  });
  try {
    mod = require("node:sqlite");
  } catch {
    mod = null;
  } finally {
    process.emitWarning = emit;
  }
  return mod;
}
function sqliteAvailable() {
  return load() !== null;
}
var ReadOnlyDb = class _ReadOnlyDb {
  db;
  constructor(db) {
    this.db = db;
  }
  /** Ouvre une base en lecture seule ; null si le module manque ou si la base est illisible ou verrouillée. */
  static open(file) {
    const m = load();
    if (!m) return null;
    try {
      return new _ReadOnlyDb(new m.DatabaseSync(file, { readOnly: true }));
    } catch {
      return null;
    }
  }
  /** Parcourt les lignes une par une quand Node le permet (bases de plusieurs Go). */
  each(sql, params, onRow) {
    const st = this.db.prepare(sql);
    if (typeof st.iterate === "function") {
      for (const row of st.iterate(...params)) onRow(row);
    } else {
      for (const row of st.all(...params)) onRow(row);
    }
  }
  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }
  /** La table existe-t-elle ? (les schémas changent d’une version à l’autre) */
  hasTable(name) {
    return this.all("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;
  }
  /** Noms des colonnes d’une table. */
  columns(table) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return /* @__PURE__ */ new Set();
    return new Set(this.all(`PRAGMA table_info(${table})`).map((r) => String(r.name)));
  }
  close() {
    try {
      this.db.close();
    } catch {
    }
  }
};
function text(v) {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return "";
}

// src/parsers/cursor.ts
var CANON = {
  run_terminal_cmd: "Bash",
  run_terminal_command: "Bash",
  run_terminal_command_v2: "Bash",
  shell: "Bash",
  read_file: "Read",
  read_file_v2: "Read",
  readfile: "Read",
  read: "Read",
  edit_file: "Edit",
  edit_file_v2: "Edit",
  search_replace: "Edit",
  apply_patch: "Edit",
  strreplace: "Edit",
  editfile: "Edit",
  edit: "Edit",
  multiedit: "Edit",
  multi_edit: "Edit",
  write_file: "Write",
  write_file_v2: "Write",
  writefile: "Write",
  write: "Write",
  grep: "Grep",
  grep_search: "Grep",
  ripgrep: "Grep",
  ripgrep_raw_search: "Grep",
  rg: "Grep",
  codebase_search: "Grep",
  semantic_search_full: "Grep",
  glob_file_search: "Glob",
  file_search: "Glob",
  list_dir: "Glob",
  list_dir_v2: "Glob",
  ls: "Glob",
  glob: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  webfetch: "WebFetch",
  task: "Task",
  task_v2: "Task",
  subagent: "Task",
  todo_write: "Todo",
  create_plan: "Plan"
};
function canon(name) {
  const n = name.toLowerCase();
  if (n.startsWith("mcp_") || n.startsWith("mcp-") || n.startsWith("mcp__")) return "MCP";
  return CANON[n] ?? name;
}
function fileFromArgs(raw) {
  const m = /"(?:target_file|targetFile|file_path|filePath|relativeWorkspacePath|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  return m ? m[1].replace(/\\\\/g, "\\") : void 0;
}
function when(v) {
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1e3 : NaN;
  const s = text(v);
  if (!s) return NaN;
  if (/^\d{10,13}$/.test(s)) return when(Number(s));
  return Date.parse(s);
}
function cursorHome() {
  return import_node_path2.default.join(import_node_os.default.homedir(), ".cursor");
}
function cursorDb(root) {
  return import_node_path2.default.join(root, "User", "globalStorage", "state.vscdb");
}
async function findCursorFiles(root, since, csv) {
  const out2 = [];
  const db = cursorDb(root);
  try {
    const st = import_node_fs2.default.statSync(db);
    let mtime = st.mtimeMs;
    try {
      mtime = Math.max(mtime, import_node_fs2.default.statSync(`${db}-wal`).mtimeMs);
    } catch {
    }
    if (mtime >= since) out2.push({ path: db, size: st.size, mtime });
  } catch {
  }
  const projects = import_node_path2.default.join(cursorHome(), "projects");
  for (const f of await walk(projects, (n) => n.endsWith(".jsonl"), since, 4)) {
    if (f.path.split(/[\\/]/).includes("agent-transcripts")) out2.push(f);
  }
  if (csv) {
    try {
      const st = import_node_fs2.default.statSync(csv);
      out2.push({ path: csv, size: st.size, mtime: st.mtimeMs });
    } catch {
    }
  }
  return out2;
}
function parseHeaders(raw) {
  const s = text(raw);
  if (!s || s === "[]") return [];
  try {
    const list = JSON.parse(s);
    return Array.isArray(list) ? list.filter((h) => h && typeof h.bubbleId === "string") : [];
  } catch {
    return [];
  }
}
var J = "CASE WHEN typeof(value) = 'blob' THEN CAST(value AS TEXT) ELSE value END";
var MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
function tagTime(s) {
  const m = /<timestamp>\s*\w+,\s*(\w{3})\w*\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*(?:\((?:UTC|GMT)\s*([+-]\d{1,2})(?::?(\d{2}))?\))?/i.exec(s);
  if (!m) return NaN;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === void 0) return NaN;
  let h = Number(m[4]) % 12;
  if ((m[6] ?? "").toUpperCase() === "PM") h += 12;
  else if (!m[6]) h = Number(m[4]);
  const off = m[7] ? Number(m[7]) * 60 + Math.sign(Number(m[7]) || 1) * Number(m[8] ?? 0) : 0;
  return Date.UTC(Number(m[3]), month, Number(m[2]), h, Number(m[5])) - off * 6e4;
}
function csvCells(line) {
  const out2 = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out2.push(cur);
      cur = "";
    } else cur += c;
  }
  out2.push(cur);
  return out2.map((x) => x.trim());
}
var toInt = (s) => {
  const n = Number((s ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
var CursorParser = class {
  constructor(agg) {
    this.agg = agg;
  }
  agg;
  /** sessions de l’IDE : leurs transcripts ne sont pas recomptés */
  composers = /* @__PURE__ */ new Set();
  seenBubble = /* @__PURE__ */ new Set();
  seenTool = /* @__PURE__ */ new Set();
  /** lignes de l’export CSV importées */
  csvRows = 0;
  /** la base de l’IDE existe mais n’a pas pu être lue (Node trop ancien, base verrouillée) */
  dbSkipped = false;
  async parse(file) {
    if (file.path.endsWith(".vscdb")) {
      this.agg.fileScanned("cursor");
      if (!this.parseDb(file)) this.dbSkipped = true;
    } else if (file.path.endsWith(".jsonl")) {
      await this.parseTranscript(file);
    } else {
      this.agg.fileScanned("cursor");
      await this.parseCsv(file.path);
    }
  }
  parseDb(file) {
    const db = ReadOnlyDb.open(file.path);
    if (!db) return false;
    try {
      if (!db.hasTable("cursorDiskKV")) return false;
      try {
        db.all("PRAGMA busy_timeout = 2000");
      } catch {
      }
      const composers = db.all(
        `SELECT substr(k, 14) AS id,
           json_extract(j, '$.createdAt') AS created,
           json_extract(j, '$.lastUpdatedAt') AS updated,
           CAST(json_extract(j, '$.workspaceIdentifier.uri.fsPath') AS BLOB) AS fs,
           CAST(json_extract(j, '$.trackedGitRepos[0].repoPath') AS BLOB) AS repo,
           json_extract(j, '$.headerLog.chunkCount') AS chunks,
           CAST(json_extract(j, '$.fullConversationHeadersOnly') AS BLOB) AS headers,
           json_extract(j, '$.subagentInfo') IS NOT NULL OR json_extract(j, '$.isSubagent') = 1 AS sub
         FROM (SELECT key AS k, ${J} AS j FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;')
         WHERE json_valid(j)`
      );
      const start = this.agg.rangeStart();
      for (const c of composers) {
        const id = String(c.id);
        if (!id || id.includes("\n")) continue;
        this.composers.add(id);
        const created = when(c.created);
        const updated = when(c.updated);
        if (Number.isFinite(updated) && updated < start - 90 * 864e5) continue;
        this.composer(db, id, {
          created,
          project: projectName(text(c.fs) || text(c.repo)),
          headers: parseHeaders(c.headers),
          chunks: Number(c.chunks) || 0,
          sub: Number(c.sub) === 1
        });
      }
      return true;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }
  composer(db, id, c) {
    let headers = c.headers;
    if (!headers.length && c.chunks > 0) {
      db.each(
        `SELECT CAST(${J} AS BLOB) AS v FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key`,
        [`composerConvHeaders:${id}:`, `composerConvHeaders:${id};`],
        (row) => {
          headers = headers.concat(parseHeaders(row.v));
        }
      );
    }
    const listed = headers.length ? new Set(headers.map((h) => h.bubbleId)) : null;
    const prefix = `bubbleId:${id}:`;
    let last = Number.isFinite(c.created) ? c.created : NaN;
    db.each(
      `SELECT substr(k, ${prefix.length + 1}) AS bid,
         json_extract(j, '$.type') AS type,
         json_extract(j, '$.createdAt') AS created,
         json_extract(j, '$.timingInfo.clientRpcSendTime') AS rpc,
         json_extract(j, '$.timingInfo.clientSettleTime') AS settle,
         length(json_extract(j, '$.text')) AS chars,
         CAST(json_extract(j, '$.toolFormerData.name') AS BLOB) AS tool,
         CAST(json_extract(j, '$.toolFormerData.toolCallId') AS BLOB) AS call,
         CAST(substr(coalesce(json_extract(j, '$.toolFormerData.rawArgs'), json_extract(j, '$.toolFormerData.params')), 1, 400) AS BLOB) AS args
       FROM (SELECT key AS k, ${J} AS j FROM cursorDiskKV WHERE key >= ? AND key < ?)
       WHERE json_valid(j)`,
      [prefix, `bubbleId:${id};`],
      (b) => {
        const bid = String(b.bid);
        if (listed && !listed.has(bid)) return;
        if (this.seenBubble.has(bid)) return;
        this.seenBubble.add(bid);
        let ts = when(b.created);
        if (!Number.isFinite(ts)) ts = when(b.rpc);
        if (!Number.isFinite(ts)) ts = when(b.settle);
        if (!Number.isFinite(ts)) ts = last;
        if (!Number.isFinite(ts)) return;
        last = ts;
        const type = Number(b.type);
        if (!c.sub) this.agg.activity("cursor", ts, id);
        if (type === 1) {
          const chars = Number(b.chars) || 0;
          if (chars > 0 && !c.sub) this.agg.prompt({ tool: "cursor", ts, chars, session: id, project: c.project });
          return;
        }
        const tool = text(b.tool);
        if (!tool) return;
        const callId = text(b.call);
        if (callId) {
          if (this.seenTool.has(callId)) return;
          this.seenTool.add(callId);
        }
        const name = canon(tool);
        const file = name === "Read" || name === "Edit" || name === "Write" ? fileFromArgs(text(b.args)) : void 0;
        this.agg.call({ tool: "cursor", ts, name, file, creates: name === "Write", session: id });
      }
    );
  }
  /** Transcript du CLI : ~/.cursor/projects/<projet>/agent-transcripts/<id>/<id>.jsonl */
  async parseTranscript(file) {
    const id = import_node_path2.default.basename(file.path, ".jsonl");
    if (this.composers.has(id)) return;
    const parts = file.path.split(/[\\/]/);
    const isSub = parts.includes("subagents");
    const session = isSub ? parts[parts.indexOf("subagents") - 1] || id : id;
    this.agg.fileScanned("cursor");
    let last = NaN;
    const pending = [];
    const flush = (ts) => {
      for (const p of pending.splice(0)) this.agg.prompt({ tool: "cursor", ts, chars: p.chars, session });
    };
    await eachLine(file.path, (line) => {
      const j = safeJson(line);
      if (!j) return;
      const role = str(j.role);
      const content = obj(j.message).content ?? j.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : arr(content).map(obj);
      if (role === "user") {
        const all = blocks.map((b) => str(b.text)).join("\n");
        const ts = tagTime(all);
        if (Number.isFinite(ts)) last = ts;
        const q = /<user_query>([\s\S]*?)(?:<\/user_query>|$)/.exec(all);
        if (!q || isSub) return;
        const chars = q[1].trim().length;
        if (!chars) return;
        if (Number.isFinite(last)) this.agg.prompt({ tool: "cursor", ts: last, chars, session });
        else pending.push({ chars });
        return;
      }
      if (role !== "assistant") return;
      for (const b of blocks) {
        if (b.type !== "tool_use" && b.type !== "tool-call") continue;
        const tool = str(b.name) || str(b.toolName);
        if (!tool || !Number.isFinite(last)) continue;
        const name = canon(tool);
        const input = obj(b.input ?? b.args);
        const f = name === "Read" || name === "Edit" || name === "Write" ? str(input.path) || str(input.file_path) || str(input.target_file) || void 0 : void 0;
        this.agg.call({ tool: "cursor", ts: last, name, file: f, creates: name === "Write", session });
      }
    });
    flush(Number.isFinite(last) ? last : file.mtime);
    if (Number.isFinite(last)) this.agg.activity("cursor", last, session);
  }
  /** Export « Usage » de cursor.com/dashboard (v1, v2 ou v3 des colonnes). */
  async parseCsv(file) {
    let cols = null;
    await eachLine(file, (line) => {
      const cells = csvCells(line.replace(/^﻿/, ""));
      if (!cols) {
        const idx = {};
        cells.forEach((name, i) => idx[name.toLowerCase()] = i);
        if ("date" in idx && "model" in idx) cols = idx;
        return;
      }
      const get = (name) => cells[cols[name] ?? -1];
      const ts = Date.parse(get("date") ?? "");
      if (!Number.isFinite(ts)) return;
      const cw = toInt(get("input (w/ cache write)"));
      const inp = toInt(get("input (w/o cache write)"));
      const cr = toInt(get("cache read"));
      const out2 = toInt(get("output tokens"));
      if (inp + cw + cr + out2 === 0) return;
      let model = (get("model") || "auto").toLowerCase();
      if (model === "auto" || model === "default") model = "cursor-auto";
      this.csvRows += 1;
      const prompt = inp + cw + cr;
      const requests = Math.max(1, Math.ceil(prompt / 15e4), Math.ceil(out2 / 1e5));
      this.agg.usage({ tool: "cursor", model, ts, inp, out: out2, cw5: cw, cw1: 0, cr, rs: 0, promptSize: prompt / requests, requests, session: "" });
    });
  }
};

// src/sources.ts
var import_node_path13 = __toESM(require("node:path"));

// src/paths.ts
var import_node_os2 = __toESM(require("node:os"));
var import_node_path3 = __toESM(require("node:path"));
function home(p) {
  return p.startsWith("~") ? import_node_path3.default.join(import_node_os2.default.homedir(), p.slice(1)) : p;
}
function appData(app) {
  if (process.platform === "win32") return import_node_path3.default.join(process.env.APPDATA || import_node_path3.default.join(import_node_os2.default.homedir(), "AppData", "Roaming"), app);
  if (process.platform === "darwin") return import_node_path3.default.join(import_node_os2.default.homedir(), "Library", "Application Support", app);
  return import_node_path3.default.join(process.env.XDG_CONFIG_HOME || import_node_path3.default.join(import_node_os2.default.homedir(), ".config"), app);
}
function xdgData(app) {
  return import_node_path3.default.join(process.env.XDG_DATA_HOME || import_node_path3.default.join(import_node_os2.default.homedir(), ".local", "share"), app);
}

// src/parsers/claude.ts
var import_node_path4 = __toESM(require("node:path"));
var CANON2 = {
  Read: "Read",
  Edit: "Edit",
  MultiEdit: "Edit",
  NotebookEdit: "Edit",
  Write: "Write",
  Bash: "Bash",
  Grep: "Grep",
  Glob: "Glob",
  LS: "Glob",
  WebFetch: "WebFetch",
  WebSearch: "WebSearch",
  Task: "Task",
  Agent: "Task",
  ExitPlanMode: "Plan",
  TodoWrite: "Todo"
};
function canon2(name) {
  if (name.startsWith("mcp__")) return "MCP";
  return CANON2[name] ?? name;
}
var NOT_A_PROMPT = /^\s*(<command-name>|<command-message>|<local-command-std|<local-command-caveat>|Caveat:|\[Request interrupted|<system-reminder>|<bash-input>|<bash-stdout>|<task-notification>)/;
async function findClaudeFiles(root, since) {
  return walk(import_node_path4.default.join(root, "projects"), (n) => n.endsWith(".jsonl"), since);
}
var ClaudeParser = class {
  constructor(agg) {
    this.agg = agg;
  }
  agg;
  seenUsage = /* @__PURE__ */ new Set();
  seenPrompt = /* @__PURE__ */ new Set();
  seenTool = /* @__PURE__ */ new Set();
  async parse(file) {
    this.agg.fileScanned("claude");
    await eachLine(file.path, (line) => {
      const isAssistant = line.includes('"type":"assistant"');
      const isUser = !isAssistant && line.includes('"type":"user"') && !line.includes('"tool_use_id"');
      const isCost = !isAssistant && !isUser && line.includes('"type":"cost-state"');
      if (!isAssistant && !isUser && !isCost) return;
      const j = safeJson(line);
      if (!j) return;
      if (j.type === "assistant") this.assistant(j);
      else if (j.type === "user") this.user(j);
      else if (j.type === "cost-state") this.cost(j);
    });
  }
  assistant(j) {
    const msg = obj(j.message);
    const ts = Date.parse(str(j.timestamp));
    if (!this.agg.inRange(ts)) return;
    const session = str(j.sessionId) || "?";
    const project = projectName(str(j.cwd));
    const model = str(msg.model);
    const usage = obj(msg.usage);
    const key = `${str(msg.id)}:${str(j.requestId)}`;
    if (model && model !== "<synthetic>" && Object.keys(usage).length && !this.seenUsage.has(key)) {
      this.seenUsage.add(key);
      const inp = num(usage.input_tokens);
      const cacheCreate = num(usage.cache_creation_input_tokens);
      const split = obj(usage.cache_creation);
      const cw1 = num(split.ephemeral_1h_input_tokens);
      const cw5 = cw1 || num(split.ephemeral_5m_input_tokens) ? num(split.ephemeral_5m_input_tokens) : cacheCreate;
      const cr = num(usage.cache_read_input_tokens);
      this.agg.usage({
        tool: "claude",
        model,
        ts,
        inp,
        out: num(usage.output_tokens),
        cw5,
        cw1,
        cr,
        rs: 0,
        promptSize: inp + cacheCreate + cr,
        fast: str(usage.speed) === "fast",
        session,
        project
      });
    }
    for (const block of arr(msg.content)) {
      const b = obj(block);
      if (b.type !== "tool_use") continue;
      const id = str(b.id);
      if (id) {
        if (this.seenTool.has(id)) continue;
        this.seenTool.add(id);
      }
      const name = canon2(str(b.name));
      const input = obj(b.input);
      const file = str(input.file_path) || str(input.notebook_path) || void 0;
      this.agg.call({ tool: "claude", ts, name, file, creates: name === "Write", session });
    }
  }
  user(j) {
    if (j.isMeta === true || j.isSidechain === true) return;
    const kind = str(obj(j.origin).kind);
    if (kind && kind !== "human") return;
    const uuid = str(j.uuid);
    if (uuid) {
      if (this.seenPrompt.has(uuid)) return;
      this.seenPrompt.add(uuid);
    }
    const msg = obj(j.message);
    let text2 = "";
    if (typeof msg.content === "string") text2 = msg.content;
    else {
      for (const part of arr(msg.content)) {
        const p = obj(part);
        if (p.type === "tool_result") return;
        if (p.type === "text") text2 += str(p.text);
      }
    }
    if (!text2.trim() || NOT_A_PROMPT.test(text2)) return;
    const ts = Date.parse(str(j.timestamp));
    const typed = text2.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, "").trim();
    const chars = Math.max(1, typed.length || Math.min(text2.length, 2e3));
    this.agg.prompt({ tool: "claude", ts, chars, session: str(j.sessionId) || "?", project: projectName(str(j.cwd)) });
  }
  cost(j) {
    const session = str(j.sessionId);
    if (!session) return;
    const start = num(j.startTime);
    if (start && !this.agg.inRange(start)) return;
    this.agg.lines(session, num(j.totalLinesAdded), num(j.totalLinesRemoved));
  }
};

// src/parsers/codex.ts
var import_node_path5 = __toESM(require("node:path"));
async function findCodexFiles(root, since) {
  const a = await walk(import_node_path5.default.join(root, "sessions"), (n) => n.endsWith(".jsonl"), since);
  const b = await walk(import_node_path5.default.join(root, "archived_sessions"), (n) => n.endsWith(".jsonl"), since, 1);
  const seen = /* @__PURE__ */ new Set();
  return [...a, ...b].filter((f) => {
    const k = import_node_path5.default.basename(f.path);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
function patchFiles(patch) {
  const out2 = [];
  for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    if (m[1] !== "Delete") out2.push({ file: m[2].trim(), creates: m[1] === "Add" });
  }
  return out2;
}
var CodexParser = class {
  constructor(agg) {
    this.agg = agg;
  }
  agg;
  seenResponse = /* @__PURE__ */ new Set();
  async parse(file) {
    this.agg.fileScanned("codex");
    let session = import_node_path5.default.basename(file.path, ".jsonl");
    let project;
    let model = "gpt-5-codex";
    let hasRecords = false;
    let lastTotal = -1;
    const pendingCounts = [];
    const userMsgs = [];
    const itemUserMsgs = [];
    await eachLine(file.path, (line) => {
      const j = safeJson(line);
      if (!j) return;
      const type = str(j.type);
      const p = obj(j.payload);
      const ts = Date.parse(str(j.timestamp));
      if (type === "session_meta") {
        session = str(p.id) || str(p.session_id) || session;
        project = projectName(str(p.cwd)) ?? project;
        return;
      }
      if (type === "turn_context") {
        model = str(p.model) || model;
        project = projectName(str(p.cwd)) ?? project;
        return;
      }
      if (type === "token_usage_record") {
        hasRecords = true;
        const rid = str(p.response_id);
        if (rid) {
          if (this.seenResponse.has(rid)) return;
          this.seenResponse.add(rid);
        }
        this.usage(ts, obj(p.usage), model, session, project);
        return;
      }
      if (type === "event_msg") {
        const t = str(p.type);
        if (t === "token_count") {
          const info = obj(p.info);
          const total = num(obj(info.total_token_usage).total_tokens);
          const last = obj(info.last_token_usage);
          if (total && total !== lastTotal && Object.keys(last).length) {
            lastTotal = total;
            pendingCounts.push({ ts, usage: last, model });
          }
        } else if (t === "user_message") {
          const msg = str(p.message);
          if (msg.trim()) userMsgs.push({ ts, chars: msg.length });
        } else if (t === "item_completed") {
          this.item(ts, obj(p.item), session, itemUserMsgs);
        }
        return;
      }
      if (type === "response_item") {
        const t = str(p.type);
        if (t === "function_call" || t === "custom_tool_call" || t === "local_shell_call") this.legacyCall(ts, p, session);
      }
    });
    if (!hasRecords) for (const c of pendingCounts) this.usage(c.ts, c.usage, c.model, session, project);
    for (const m of userMsgs.length ? userMsgs : itemUserMsgs) {
      this.agg.prompt({ tool: "codex", ts: m.ts, chars: m.chars, session, project });
    }
  }
  usage(ts, u, model, session, project) {
    const input = num(u.input_tokens);
    const cached = num(u.cached_input_tokens);
    const write = num(u.cache_write_input_tokens);
    this.agg.usage({
      tool: "codex",
      model,
      ts,
      inp: Math.max(0, input - cached - write),
      out: num(u.output_tokens),
      cw5: write,
      cw1: 0,
      cr: cached,
      rs: num(u.reasoning_output_tokens),
      promptSize: input,
      session,
      project
    });
  }
  item(ts, item, session, userMsgs) {
    const t = str(item.type);
    if (t === "UserMessage") {
      const text2 = arr(item.content).map((c) => str(obj(c).text)).join("");
      if (text2.trim()) userMsgs.push({ ts, chars: text2.length });
    } else if (t === "CommandExecution") {
      const parsed = arr(item.parsed_cmd).map((c) => str(obj(c).type));
      const name = parsed.includes("read") ? "Read" : parsed.includes("search") ? "Grep" : parsed.includes("list_files") ? "Glob" : "Bash";
      this.agg.call({ tool: "codex", ts, name, session });
    } else if (t === "FileChange") {
      for (const [file, change] of Object.entries(obj(item.changes))) {
        const kind = str(obj(change).type);
        if (kind === "delete") continue;
        this.agg.call({ tool: "codex", ts, name: kind === "add" ? "Write" : "Edit", file, creates: kind === "add", session });
      }
    } else if (t === "WebSearch") {
      this.agg.call({ tool: "codex", ts, name: "WebSearch", session });
    }
  }
  legacyCall(ts, p, session) {
    const name = str(p.name);
    if (name === "exec") return;
    if (name === "shell" || name === "exec_command" || str(p.type) === "local_shell_call") {
      this.agg.call({ tool: "codex", ts, name: "Bash", session });
    } else if (name === "apply_patch") {
      const raw = str(p.input) || str(p.arguments);
      const files = patchFiles(raw);
      if (!files.length) this.agg.call({ tool: "codex", ts, name: "Edit", session });
      for (const f of files) this.agg.call({ tool: "codex", ts, name: f.creates ? "Write" : "Edit", file: f.file, creates: f.creates, session });
    } else if (name === "update_plan") {
      this.agg.call({ tool: "codex", ts, name: "Todo", session });
    } else if (name === "web_search") {
      this.agg.call({ tool: "codex", ts, name: "WebSearch", session });
    } else if (name === "view_image" || name === "read_file") {
      this.agg.call({ tool: "codex", ts, name: "Read", session });
    }
  }
};

// src/parsers/antigravity.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_path6 = __toESM(require("node:path"));

// src/proto.ts
function varint(data, at) {
  let value = 0n;
  let shift = 0n;
  let i = at;
  while (i < data.length) {
    const byte = BigInt(data[i]);
    i += 1;
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return [value, i];
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}
function fields(data) {
  const out2 = [];
  if (!data) return out2;
  let i = 0;
  while (i < data.length) {
    const key = varint(data, i);
    if (!key) break;
    i = key[1];
    const n = Number(key[0] >> 3n);
    const wire = Number(key[0] & 7n);
    if (!Number.isSafeInteger(n) || n <= 0) break;
    if (wire === 0) {
      const v = varint(data, i);
      if (!v) break;
      out2.push({ n, v: v[0] });
      i = v[1];
    } else if (wire === 2) {
      const len = varint(data, i);
      if (!len) break;
      i = len[1];
      const size = Number(len[0]);
      if (!Number.isSafeInteger(size) || size < 0 || i + size > data.length) break;
      out2.push({ n, b: data.subarray(i, i + size) });
      i += size;
    } else if (wire === 1) {
      if (i + 8 > data.length) break;
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > data.length) break;
      i += 4;
    } else break;
  }
  return out2;
}
function first(fs9, n) {
  return fs9.find((f) => f.n === n);
}
function sub(fs9, n) {
  return fields(first(fs9, n)?.b);
}
function int(f) {
  if (f?.v === void 0) return 0;
  const n = Number(f.v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}
var decoder = new TextDecoder("utf-8", { fatal: false });
function str2(f) {
  if (!f?.b || f.b.length === 0) return void 0;
  const s = decoder.decode(f.b);
  return /[\u0000-\u0008\u000E-\u001F\u007F�]/.test(s) ? void 0 : s;
}
function packed(f) {
  const out2 = [];
  const data = f?.b;
  if (!data) return out2;
  let i = 0;
  while (i < data.length) {
    const v = varint(data, i);
    if (!v) break;
    out2.push(Number(v[0]));
    i = v[1];
  }
  return out2;
}
function timestamp(f) {
  if (!f) return NaN;
  if (f.b) {
    const t = fields(f.b);
    const s = first(t, 1)?.v;
    if (s !== void 0) {
      const ms = Number(s) * 1e3 + Math.floor(Number(first(t, 2)?.v ?? 0n) / 1e6);
      return ms > 0 ? ms : NaN;
    }
    const text2 = str2(f);
    return text2 ? Date.parse(text2) : NaN;
  }
  if (f.v !== void 0) {
    const raw = Number(f.v);
    return raw > 0 ? raw < 1e12 ? raw * 1e3 : raw : NaN;
  }
  return NaN;
}

// src/parsers/antigravity.ts
var ANTIGRAVITY_APPS = ["antigravity", "antigravity-ide", "antigravity-cli"];
var CANON3 = {
  view_file: "Read",
  read_file: "Read",
  view_file_outline: "Read",
  view_code_item: "Read",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  edit_file: "Edit",
  write_to_file: "Write",
  write_file: "Write",
  create_file: "Write",
  run_command: "Bash",
  run_shell_command: "Bash",
  execute_command: "Bash",
  send_command_input: "Bash",
  grep_search: "Grep",
  search_files: "Grep",
  codebase_search: "Grep",
  find_by_name: "Glob",
  list_dir: "Glob",
  list_directory: "Glob",
  read_url_content: "WebFetch",
  search_web: "WebSearch",
  invoke_subagent: "Task",
  manage_task: "Todo"
};
function canon3(name) {
  if (name === "call_mcp_tool" || name.startsWith("mcp_")) return "MCP";
  return CANON3[name] ?? name;
}
var PLACEHOLDERS = {
  M16: "gemini-3.1-pro",
  M37: "gemini-3.1-pro",
  M36: "gemini-3.1-pro",
  M84: "gemini-3.5-flash",
  M18: "gemini-3-flash",
  M318: "gemini-3.8-flash",
  M319: "gemini-3.8-flash",
  M320: "gemini-3.8-flash",
  M35: "claude-sonnet-4-6",
  M26: "claude-opus-4-6",
  M417: "gemini-4-argon",
  M418: "gemini-4-argon",
  M419: "gemini-4-argon",
  M427: "gemini-4-carbon",
  M437: "gemini-4-carbon",
  M438: "gemini-4-carbon",
  M525: "gemini-4-hydrogen",
  M526: "gemini-4-hydrogen",
  M527: "gemini-4-hydrogen",
  M528: "gemini-4-hydrogen"
};
async function findAntigravityFiles(root, since) {
  const out2 = [];
  for (const app of ANTIGRAVITY_APPS) {
    const base = import_node_path6.default.join(root, app);
    const dbs = await walk(import_node_path6.default.join(base, "conversations"), (n) => n.endsWith(".db"), 0, 0);
    const withDb = new Set(dbs.map((f) => import_node_path6.default.basename(f.path, ".db")));
    for (const f of dbs) {
      let mtime = f.mtime;
      try {
        mtime = Math.max(mtime, import_node_fs3.default.statSync(`${f.path}-wal`).mtimeMs);
      } catch {
      }
      if (mtime >= since) out2.push({ ...f, mtime });
    }
    const pbs = await walk(import_node_path6.default.join(base, "conversations"), (n) => n.endsWith(".pb"), 0, 0);
    for (const pb of pbs) {
      const id = import_node_path6.default.basename(pb.path, ".pb");
      if (withDb.has(id)) continue;
      const tr = import_node_path6.default.join(base, "brain", id, ".system_generated", "logs", "transcript.jsonl");
      try {
        const st = import_node_fs3.default.statSync(tr);
        if (st.isFile() && st.mtimeMs >= since) out2.push({ path: tr, size: st.size, mtime: st.mtimeMs });
      } catch {
      }
    }
  }
  return out2.sort((a, b) => b.mtime - a.mtime);
}
function typedLength(raw) {
  const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/i.exec(raw);
  return (m ? m[1] : raw).trim().length;
}
function blob(v) {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return Buffer.from(v, "utf8");
  return void 0;
}
function fileArg(args) {
  for (const k of ["AbsolutePath", "TargetFile", "file_path", "path", "AbsolutePathURI"]) {
    const v = args[k];
    if (typeof v === "string" && v) return v.replace(/^file:\/\//, "");
  }
  return void 0;
}
var AntigravityParser = class {
  constructor(agg) {
    this.agg = agg;
  }
  agg;
  seenSession = /* @__PURE__ */ new Set();
  seenCall = /* @__PURE__ */ new Set();
  /** conversations dont les tokens n’ont pas pu être lus (Node sans node:sqlite) */
  missedTokens = 0;
  async parse(file) {
    if (file.path.endsWith(".db")) {
      const id2 = import_node_path6.default.basename(file.path, ".db");
      if (this.seenSession.has(id2)) return;
      this.seenSession.add(id2);
      this.agg.fileScanned("antigravity");
      if (this.parseDb(file, id2)) return;
      if (!sqliteAvailable()) this.missedTokens += 1;
      const tr = import_node_path6.default.join(import_node_path6.default.dirname(import_node_path6.default.dirname(file.path)), "brain", id2, ".system_generated", "logs", "transcript.jsonl");
      if (import_node_fs3.default.existsSync(tr)) await this.parseTranscript(tr, id2);
      return;
    }
    const id = import_node_path6.default.basename(import_node_path6.default.dirname(import_node_path6.default.dirname(import_node_path6.default.dirname(file.path))));
    if (this.seenSession.has(id)) return;
    this.seenSession.add(id);
    this.agg.fileScanned("antigravity");
    await this.parseTranscript(file.path, id);
  }
  parseDb(file, id) {
    const db = ReadOnlyDb.open(file.path);
    if (!db) return false;
    try {
      if (!db.hasTable("gen_metadata") || !db.hasTable("steps")) return false;
      let started = NaN;
      let project;
      let parent;
      if (db.hasTable("trajectory_metadata_blob")) {
        for (const row of db.all("SELECT data FROM trajectory_metadata_blob")) {
          const meta = fields(blob(row.data));
          started = timestamp(first(meta, 2));
          parent = str2(first(meta, 5)) || void 0;
          if (parent === id) parent = void 0;
          const uri = str2(first(meta, 7)) ?? str2(first(sub(meta, 1), 1));
          if (uri) project = projectName(decodeURIComponent(uri.replace(/^file:\/\/\/?/, "")));
          break;
        }
      }
      const session = parent ?? id;
      const fallbackTs = Number.isFinite(started) ? started : file.mtime;
      const stepTs = /* @__PURE__ */ new Map();
      db.each("SELECT idx, step_type, metadata FROM steps ORDER BY idx", [], (row) => {
        const meta = fields(blob(row.metadata));
        const ts = timestamp(first(meta, 1));
        const idx = Number(row.idx);
        if (Number.isFinite(ts)) {
          stepTs.set(idx, ts);
          this.agg.activity("antigravity", ts, session);
        }
        const call = sub(meta, 4);
        const name = str2(first(call, 2));
        if (name && name !== "send_message") {
          const c = canon3(name);
          let args = {};
          const raw = str2(first(call, 3));
          if (raw) args = obj(safeJson(raw));
          const fileName = c === "Read" || c === "Edit" || c === "Write" ? fileArg(args) : void 0;
          this.agg.call({ tool: "antigravity", ts: Number.isFinite(ts) ? ts : fallbackTs, name: c, file: fileName, creates: c === "Write", session });
        }
      });
      if (!parent) {
        db.each("SELECT idx, metadata, step_payload FROM steps WHERE step_type = 14 ORDER BY idx", [], (row) => {
          const meta = fields(blob(row.metadata));
          const source = int(first(meta, 3));
          if (source && source !== 4) return;
          const input = sub(fields(blob(row.step_payload)), 19);
          let text2 = str2(first(input, 2)) ?? "";
          if (!text2) for (const item of input.filter((f) => f.n === 3)) text2 += str2(first(fields(item.b), 1)) ?? "";
          const chars = typedLength(text2);
          if (!chars) return;
          const ts = stepTs.get(Number(row.idx)) ?? fallbackTs;
          this.agg.prompt({ tool: "antigravity", ts, chars, session, project });
        });
      }
      db.each("SELECT idx, data FROM gen_metadata ORDER BY idx", [], (row) => {
        const root = fields(blob(row.data));
        const chat = sub(root, 1);
        const usage = sub(chat, 4);
        if (!usage.length) return;
        const input = int(first(usage, 2));
        const hasTotal = first(usage, 3)?.v !== void 0;
        const total = int(first(usage, 3));
        let thinking = int(first(usage, 9));
        const response = int(first(usage, 10));
        if (hasTotal && thinking + response !== total) thinking = Math.min(thinking, total);
        const out2 = hasTotal ? total : thinking + response;
        const cw = int(first(usage, 4));
        const cr = int(first(usage, 5));
        if (input + out2 + cw + cr === 0) return;
        const rid = str2(first(usage, 11));
        const key = `${id}:${rid && !/\s/.test(rid) ? rid : `#${row.idx}`}`;
        if (this.seenCall.has(key)) return;
        this.seenCall.add(key);
        const steps = packed(first(root, 2));
        let ts = timestamp(first(sub(chat, 9), 4));
        if (!Number.isFinite(ts) && steps.length) ts = stepTs.get(steps[0]) ?? NaN;
        if (!Number.isFinite(ts)) ts = fallbackTs;
        this.agg.usage({
          tool: "antigravity",
          model: modelOf(chat),
          ts,
          inp: input,
          out: out2,
          cw5: cw,
          cw1: 0,
          cr,
          rs: thinking,
          promptSize: input + cw + cr,
          session,
          project
        });
      });
      return true;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }
  async parseTranscript(file, session) {
    await eachLine(file, (line) => {
      const j = safeJson(line);
      if (!j) return;
      const ts = Date.parse(str(j.created_at));
      if (!Number.isFinite(ts)) return;
      this.agg.activity("antigravity", ts, session);
      if (j.type === "USER_INPUT" && (j.source === "USER_EXPLICIT" || !j.source)) {
        let text2 = "";
        if (typeof j.content === "string") text2 = j.content;
        else for (const c of arr(j.content)) text2 += typeof c === "string" ? c : str(obj(c).text);
        const chars = typedLength(text2);
        if (chars) this.agg.prompt({ tool: "antigravity", ts, chars, session });
        return;
      }
      for (const call of arr(j.tool_calls)) {
        const name = str(obj(call).name);
        if (!name || name === "send_message") continue;
        const c = canon3(name);
        const fileName = c === "Read" || c === "Edit" || c === "Write" ? fileArg(obj(obj(call).args)) : void 0;
        this.agg.call({ tool: "antigravity", ts, name: c, file: fileName, creates: c === "Write", session });
      }
    });
  }
};
function modelOf(chat) {
  const display = str2(first(chat, 21));
  const response = str2(first(chat, 19));
  let placeholder = "";
  for (const f of chat) {
    if (f.n !== 20) continue;
    const pair = fields(f.b);
    if (str2(first(pair, 1)) === "model_enum") placeholder = str2(first(pair, 2)) ?? "";
  }
  if (display) return display;
  const known = PLACEHOLDERS[placeholder.replace(/^MODEL_PLACEHOLDER_/, "")];
  if (known) return known;
  if (response && !/-default$/.test(response)) return response;
  return response || "antigravity";
}

// src/parsers/cline.ts
var import_node_fs4 = __toESM(require("node:fs"));
var import_node_os3 = __toESM(require("node:os"));
var import_node_path7 = __toESM(require("node:path"));
var EXT = "saoudrizwan.claude-dev";
var EDITORS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];
var TOOLS = {
  readFile: "Read",
  editedExistingFile: "Edit",
  appliedDiff: "Edit",
  newFileCreated: "Write",
  searchFiles: "Grep",
  codebaseSearch: "Grep",
  listFilesTopLevel: "Glob",
  listFilesRecursive: "Glob",
  listCodeDefinitionNames: "Glob",
  webFetch: "WebFetch",
  newTask: "Task"
};
function clineTaskDirs(dir) {
  if (dir) return [import_node_path7.default.join(dir, "tasks")];
  return [
    ...EDITORS.map((e) => import_node_path7.default.join(appData(e), "User", "globalStorage", EXT, "tasks")),
    import_node_path7.default.join(import_node_os3.default.homedir(), ".vscode-server", "data", "User", "globalStorage", EXT, "tasks"),
    import_node_path7.default.join(import_node_os3.default.homedir(), ".cline", "data", "tasks")
  ];
}
async function findClineFiles(dirs, since) {
  const out2 = [];
  for (const tasks of dirs) {
    let ids = [];
    try {
      ids = import_node_fs4.default.readdirSync(tasks);
    } catch {
      continue;
    }
    for (const id of ids) {
      const p = import_node_path7.default.join(tasks, id, "ui_messages.json");
      try {
        const st = import_node_fs4.default.statSync(p);
        if (st.isFile() && st.mtimeMs >= since) out2.push({ path: p, size: st.size, mtime: st.mtimeMs });
      } catch {
      }
    }
  }
  return out2;
}
function historyHead(dir) {
  try {
    const fd = import_node_fs4.default.openSync(import_node_path7.default.join(dir, "api_conversation_history.json"), "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = import_node_fs4.default.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      import_node_fs4.default.closeSync(fd);
    }
  } catch {
    return "";
  }
}
var ClineParser = class {
  constructor(agg) {
    this.agg = agg;
  }
  agg;
  seenTask = /* @__PURE__ */ new Set();
  async parse(file) {
    const dir = import_node_path7.default.dirname(file.path);
    const task = import_node_path7.default.basename(dir);
    if (this.seenTask.has(task)) return;
    this.seenTask.add(task);
    this.agg.fileScanned("cline");
    let msgs;
    try {
      msgs = JSON.parse(await import_node_fs4.default.promises.readFile(file.path, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(msgs)) return;
    const head = historyHead(dir);
    const fallbackModel = /<model>([^<]{1,80})<\/model>/.exec(head)?.[1]?.trim() ?? "";
    const cwd = /Current Workspace Directory \(([^)]+)\)/.exec(head)?.[1];
    const project = cwd ? projectName(cwd.replace(/\\\\/g, "\\")) : void 0;
    const session = task;
    let first2 = true;
    for (const raw of msgs) {
      const m = obj(raw);
      const ts = num(m.ts);
      if (!ts) continue;
      this.agg.activity("cline", ts, session);
      if (m.partial === true) continue;
      const say = str(m.say);
      const ask = str(m.ask);
      if (m.type === "say" && (say === "task" || say === "user_feedback" || say === "user_feedback_diff" || first2 && say === "text")) {
        const chars = str(m.text).trim().length;
        if (chars > 0) this.agg.prompt({ tool: "cline", ts, chars, session, project });
      }
      first2 = false;
      if (m.type === "ask" && ask === "tool") {
        const t = obj(safeJson(str(m.text)));
        const name = TOOLS[str(t.tool)] ?? (str(t.tool) || "Tool");
        const f = name === "Read" || name === "Edit" || name === "Write" ? str(t.path) || void 0 : void 0;
        this.agg.call({ tool: "cline", ts, name, file: f, creates: name === "Write", session });
        continue;
      }
      if (m.type === "ask" && ask === "command") {
        this.agg.call({ tool: "cline", ts, name: "Bash", session });
        continue;
      }
      if (m.type === "ask" && ask === "use_mcp_server") {
        this.agg.call({ tool: "cline", ts, name: "MCP", session });
        continue;
      }
      if (m.type !== "say" || say !== "api_req_started") continue;
      const j = obj(safeJson(str(m.text)));
      if (typeof j.tokensIn !== "number" && typeof j.tokensOut !== "number") continue;
      const inp = num(j.tokensIn);
      const out2 = num(j.tokensOut);
      const cr = num(j.cacheReads);
      const cw = num(j.cacheWrites);
      if (inp + out2 + cr + cw === 0) continue;
      this.agg.usage({
        tool: "cline",
        model: str(obj(m.modelInfo).modelId) || fallbackModel || "unknown",
        ts,
        inp,
        out: out2,
        cw5: cw,
        cw1: 0,
        cr,
        rs: 0,
        promptSize: inp + cr + cw,
        session,
        project
      });
    }
  }
};

// src/parsers/copilot.ts
var import_node_fs5 = __toESM(require("node:fs"));
var import_node_path8 = __toESM(require("node:path"));
var CANON4 = {
  bash: "Bash",
  powershell: "Bash",
  shell: "Bash",
  view: "Read",
  read: "Read",
  read_file: "Read",
  edit: "Edit",
  str_replace: "Edit",
  str_replace_editor: "Edit",
  apply_patch: "Edit",
  create: "Write",
  write: "Write",
  grep: "Grep",
  rg: "Grep",
  glob: "Glob",
  list: "Glob",
  web_fetch: "WebFetch",
  fetch: "WebFetch",
  web_search: "WebSearch",
  task: "Task",
  update_todo: "Todo"
};
function canon4(name) {
  const n = name.toLowerCase();
  if (CANON4[n]) return CANON4[n];
  if (n.includes("-") && n.includes("_")) return "MCP";
  return name;
}
async function findCopilotFiles(root, since) {
  return walk(import_node_path8.default.join(root, "session-state"), (n) => n === "events.jsonl", since, 2);
}
var FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"];
var CopilotParser = class {
  constructor(agg) {
    this.agg = agg;
  }
  agg;
  seen = /* @__PURE__ */ new Set();
  async parse(file) {
    this.agg.fileScanned("copilot");
    let session = import_node_path8.default.basename(import_node_path8.default.dirname(file.path));
    let project;
    try {
      const yaml = import_node_fs5.default.readFileSync(import_node_path8.default.join(import_node_path8.default.dirname(file.path), "workspace.yaml"), "utf8");
      const m = /^cwd:\s*(.+)$/m.exec(yaml);
      if (m) project = projectName(m[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
    }
    let model = "";
    const records = [];
    const shutdowns = [];
    await eachLine(file.path, (line) => {
      const j = safeJson(line);
      if (!j) return;
      const type = str(j.type);
      const d = obj(j.data);
      const ts = Date.parse(str(j.timestamp));
      if (!Number.isFinite(ts)) return;
      if (type === "session.start") {
        session = str(d.sessionId) || session;
        model = str(d.selectedModel) || model;
        const ctx = obj(d.context);
        project = projectName(str(ctx.cwd) || str(ctx.gitRoot)) ?? project;
        return;
      }
      if (type === "session.model_change") {
        model = str(d.newModel) || model;
        return;
      }
      this.agg.activity("copilot", ts, session);
      if (type === "user.message") {
        const content = str(d.content);
        if (!content.trim() || str(d.source).startsWith("skill-") || content.startsWith("<skill-context")) return;
        this.agg.prompt({ tool: "copilot", ts, chars: content.length, session, project });
        return;
      }
      if (type === "assistant.message") {
        for (const r of arr(d.toolRequests)) {
          const req = obj(r);
          const name = str(req.name) || str(req.toolName);
          if (!name || name === "report_intent") continue;
          const id = str(req.toolCallId);
          if (id) {
            if (this.seen.has(`tool:${id}`)) continue;
            this.seen.add(`tool:${id}`);
          }
          const c = canon4(name);
          const args = obj(typeof req.arguments === "string" ? safeJson(req.arguments) : req.arguments);
          const f = c === "Read" || c === "Edit" || c === "Write" ? str(args.path) || str(args.file_path) || void 0 : void 0;
          this.agg.call({ tool: "copilot", ts, name: c, file: f, creates: c === "Write", session });
        }
        return;
      }
      if (type === "session.usage_record") {
        const u = obj(d.usage);
        const acc = obj(u.accounting);
        const key = str(acc.sourceSessionId) && acc.sequence !== void 0 ? `${str(acc.sourceSessionId)}:${acc.sequence}` : `${session}:${str(j.id)}`;
        records.push({ ts, u: { ...u, model: str(u.model) || model }, key });
        return;
      }
      if (type === "session.shutdown") {
        const marks = obj(d.usageAccountingWatermarks);
        if (Object.values(marks).some((v) => typeof v === "number" && v > 0)) return;
        shutdowns.push({ ts, metrics: obj(d.modelMetrics) });
      }
    });
    if (records.length) {
      for (const r of records) {
        if (this.seen.has(r.key)) continue;
        this.seen.add(r.key);
        this.emit(r.ts, r.u, session, project);
      }
      return;
    }
    const prev = /* @__PURE__ */ new Map();
    for (const s of shutdowns) {
      for (const [m, raw] of Object.entries(s.metrics)) {
        const cur = obj(obj(raw).usage);
        const count = num(obj(obj(raw).requests).count);
        const before = prev.get(m);
        prev.set(m, { u: cur, requests: count });
        let delta = cur;
        let requests = count;
        if (before) {
          const diff = {};
          let negative = false;
          for (const f of FIELDS) {
            const v = num(cur[f]) - num(before.u[f]);
            if (v < 0) negative = true;
            diff[f] = v;
          }
          delta = negative ? cur : diff;
          requests = negative ? count : count - before.requests;
        }
        this.emit(s.ts, { ...delta, model: m }, session, project, requests);
      }
    }
  }
  /** `requests` : nombre d’appels d’un bilan cumulé (inconnu : estimé à un appel par 150k tokens d’entrée). */
  emit(ts, u, session, project, requests) {
    const cr = num(u.cacheReadTokens);
    const cw = num(u.cacheWriteTokens);
    const input = num(u.inputTokens);
    const out2 = num(u.outputTokens);
    const inp = Math.max(0, input - cr - cw);
    if (inp + out2 + cr + cw === 0) return;
    const n = requests === void 0 ? 1 : Math.max(requests, Math.ceil(Math.max(input, inp + cr + cw) / 15e4), 1);
    this.agg.usage({
      tool: "copilot",
      model: (u.model || "copilot").replace(/-1m(-internal)?$/, ""),
      ts,
      inp,
      out: out2,
      cw5: cw,
      cw1: 0,
      cr,
      rs: num(u.reasoningTokens),
      promptSize: Math.max(input, inp + cr + cw) / n,
      requests: n,
      session,
      project
    });
  }
};

// src/parsers/opencode.ts
var import_node_fs6 = __toESM(require("node:fs"));
var import_node_path9 = __toESM(require("node:path"));
var CANON5 = {
  bash: "Bash",
  shell: "Bash",
  read: "Read",
  edit: "Edit",
  patch: "Edit",
  multiedit: "Edit",
  write: "Write",
  grep: "Grep",
  glob: "Glob",
  list: "Glob",
  webfetch: "WebFetch",
  websearch: "WebSearch",
  codesearch: "WebSearch",
  task: "Task",
  subagent: "Task",
  todowrite: "Todo",
  todoread: "Todo",
  plan_enter: "Plan",
  plan_exit: "Plan"
};
function canon5(name) {
  const n = name.toLowerCase();
  if (CANON5[n]) return CANON5[n];
  if (n.includes("_") && !["todo_write", "web_fetch", "web_search"].includes(n)) return "MCP";
  return name;
}
function fileOf(input) {
  const m = /"(?:filePath|file_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
  return m ? m[1].replace(/\\\\/g, "\\") : void 0;
}
async function findOpencodeFiles(root, since) {
  const out2 = [];
  let names = [];
  try {
    names = import_node_fs6.default.readdirSync(root).filter((n) => /^opencode(-[A-Za-z0-9_-]+)?\.db$/.test(n));
  } catch {
  }
  if (names.includes("opencode.db")) names = names.filter((n) => n !== "opencode-next.db");
  for (const n of names.sort()) {
    const p = import_node_path9.default.join(root, n);
    try {
      const st = import_node_fs6.default.statSync(p);
      let mtime = st.mtimeMs;
      try {
        mtime = Math.max(mtime, import_node_fs6.default.statSync(`${p}-wal`).mtimeMs);
      } catch {
      }
      if (mtime >= since) out2.push({ path: p, size: st.size, mtime });
    } catch {
    }
  }
  out2.push(...await walk(import_node_path9.default.join(root, "storage", "message"), (n) => n.endsWith(".json"), since, 2));
  return out2;
}
var OpencodeParser = class {
  constructor(agg, tool = "opencode") {
    this.agg = agg;
    this.tool = tool;
  }
  agg;
  tool;
  seen = /* @__PURE__ */ new Set();
  seenTool = /* @__PURE__ */ new Set();
  projects = /* @__PURE__ */ new Map();
  async parse(file) {
    if (file.path.endsWith(".db")) {
      this.agg.fileScanned(this.tool);
      this.parseDb(file.path);
      return;
    }
    this.parseLegacy(file);
  }
  usage(o) {
    if (o.provider === "claude-agent") return;
    const inp = num(o.t.input);
    const rs = num(o.t.reasoning);
    const out2 = num(o.t.output) + rs;
    const cr = num(o.t.cache?.read);
    const cw = num(o.t.cache?.write);
    if (inp + out2 + cr + cw === 0) return;
    this.agg.usage({
      tool: this.tool,
      model: o.model || o.provider || "unknown",
      ts: o.ts,
      inp,
      out: out2,
      cw5: cw,
      cw1: 0,
      cr,
      rs,
      promptSize: inp + cr + cw,
      session: o.session,
      project: o.project
    });
  }
  call(name, callId, input, ts, session) {
    if (!name) return;
    if (callId) {
      if (this.seenTool.has(callId)) return;
      this.seenTool.add(callId);
    }
    const c = canon5(name);
    const file = c === "Read" || c === "Edit" || c === "Write" ? fileOf(input) : void 0;
    this.agg.call({ tool: this.tool, ts, name: c, file, creates: c === "Write", session });
    this.agg.activity(this.tool, ts, session);
  }
  parseDb(file) {
    const db = ReadOnlyDb.open(file);
    if (!db) return;
    try {
      if (db.hasTable("session_message")) this.v2(db);
      if (db.hasTable("message") && db.hasTable("part")) this.v1(db);
    } catch {
    } finally {
      db.close();
    }
  }
  /** v1 : message(id, session_id, time_created, data) + part(message_id, data). */
  v1(db) {
    const dirs = /* @__PURE__ */ new Map();
    if (db.hasTable("session")) {
      db.each("SELECT id, CAST(directory AS BLOB) AS dir FROM session", [], (r) => dirs.set(String(r.id), projectName(text(r.dir))));
    }
    const roles = /* @__PURE__ */ new Map();
    db.each("SELECT id, session_id, time_created, CAST(data AS BLOB) AS data FROM message ORDER BY time_created", [], (r) => {
      const d = obj(safeJson(text(r.data)));
      const id = String(r.id);
      const session = String(r.session_id ?? d.sessionID ?? "");
      const time = obj(d.time);
      const ts = num(time.created) || Number(r.time_created) || NaN;
      const p = obj(d.path);
      const project = projectName(str(p.cwd) || str(p.root)) ?? dirs.get(session);
      roles.set(id, { role: str(d.role), session, ts, project });
      if (this.seen.has(id)) return;
      this.seen.add(id);
      if (!Number.isFinite(ts)) return;
      this.agg.activity(this.tool, ts, session);
      if (str(d.role) === "assistant" && d.tokens) {
        this.usage({ id, session, ts, model: str(d.modelID), provider: str(d.providerID), t: d.tokens, project });
      }
    });
    const typed = /* @__PURE__ */ new Map();
    db.each(
      `SELECT message_id AS mid,
         json_extract(data, '$.type') AS type,
         length(json_extract(data, '$.text')) AS chars,
         json_extract(data, '$.synthetic') AS synthetic,
         CAST(json_extract(data, '$.tool') AS BLOB) AS tool,
         CAST(json_extract(data, '$.callID') AS BLOB) AS call,
         CAST(substr(json_extract(data, '$.state.input'), 1, 400) AS BLOB) AS input
       FROM part WHERE json_valid(data)`,
      [],
      (r) => {
        const m = roles.get(String(r.mid));
        if (!m || !Number.isFinite(m.ts)) return;
        if (r.type === "text" && m.role === "user" && !r.synthetic) {
          typed.set(String(r.mid), (typed.get(String(r.mid)) ?? 0) + (Number(r.chars) || 0));
        } else if (r.type === "tool") {
          this.call(text(r.tool), text(r.call), text(r.input), m.ts, m.session);
        }
      }
    );
    for (const [mid, chars] of typed) {
      const m = roles.get(mid);
      if (!m || !chars || this.seen.has(`prompt:${mid}`)) continue;
      this.seen.add(`prompt:${mid}`);
      this.agg.prompt({ tool: this.tool, ts: m.ts, chars, session: m.session, project: m.project });
    }
  }
  /** v2 : session_message(type, seq, data), avec copies des messages du parent dans les sessions dérivées. */
  v2(db) {
    const table = db.hasTable("session_v2") ? "session_v2" : db.hasTable("session") ? "session" : "";
    const dirs = /* @__PURE__ */ new Map();
    const cutoff = /* @__PURE__ */ new Map();
    if (table) {
      const cols = db.columns(table);
      const pick = (c) => cols.has(c) ? `CAST(${c} AS BLOB) AS ${c}` : `NULL AS ${c}`;
      db.each(`SELECT id, ${pick("directory")}, ${pick("fork_session_id")}, ${pick("fork_boundary")} FROM ${table}`, [], (r) => {
        const id = String(r.id);
        dirs.set(id, projectName(text(r.directory)));
        const parent = text(r.fork_session_id);
        const boundary = obj(safeJson(text(r.fork_boundary)));
        const mid = str(boundary.messageID);
        if (!parent || !mid) return;
        const row = db.all("SELECT seq FROM session_message WHERE session_id = ? AND id = ? LIMIT 1", parent, mid)[0];
        if (!row) return;
        const seq = Number(row.seq);
        if (boundary.type === "through") cutoff.set(id, seq);
        else if (boundary.type === "before") {
          const prev = db.all("SELECT MAX(seq) AS s FROM session_message WHERE session_id = ? AND seq < ?", parent, seq)[0];
          if (prev && prev.s !== null) cutoff.set(id, Number(prev.s));
        }
      });
    }
    const copied = (session, seq) => cutoff.has(session) && seq <= (cutoff.get(session) ?? -1);
    db.each(
      `SELECT id, session_id AS sid, type, seq, time_created AS tc,
         json_extract(data, '$.time.created') AS created,
         length(json_extract(data, '$.text')) AS chars,
         CAST(json_extract(data, '$.model.id') AS BLOB) AS model,
         CAST(json_extract(data, '$.model.providerID') AS BLOB) AS provider,
         CAST(json_extract(data, '$.status') AS BLOB) AS status,
         CAST(json_extract(data, '$.tokens') AS BLOB) AS tokens
       FROM session_message WHERE type IN ('user', 'assistant', 'compaction') AND json_valid(data)`,
      [],
      (r) => {
        const id = String(r.id);
        const session = String(r.sid);
        if (this.seen.has(id) || copied(session, Number(r.seq))) return;
        this.seen.add(id);
        const ts = num(r.created) || Number(r.tc) || NaN;
        if (!Number.isFinite(ts)) return;
        const project = dirs.get(session);
        this.agg.activity(this.tool, ts, session);
        if (r.type === "user") {
          const chars = Number(r.chars) || 0;
          if (chars > 0) this.agg.prompt({ tool: this.tool, ts, chars, session, project });
          return;
        }
        if (r.type === "compaction" && text(r.status) !== "completed") return;
        const t = obj(safeJson(text(r.tokens)));
        this.usage({ id, session, ts, model: text(r.model), provider: text(r.provider), t, project });
      }
    );
    db.each(
      `SELECT m.session_id AS sid, m.seq, m.time_created AS tc,
         CAST(json_extract(c.value, '$.name') AS BLOB) AS name,
         CAST(json_extract(c.value, '$.id') AS BLOB) AS call,
         CAST(substr(json_extract(c.value, '$.state.input'), 1, 400) AS BLOB) AS input
       FROM session_message m, json_each(m.data, '$.content') c
       WHERE m.type = 'assistant' AND json_valid(m.data) AND json_extract(c.value, '$.type') = 'tool'`,
      [],
      (r) => {
        if (copied(String(r.sid), Number(r.seq))) return;
        const ts = Number(r.tc);
        if (Number.isFinite(ts)) this.call(text(r.name), text(r.call), text(r.input), ts, String(r.sid));
      }
    );
  }
  /** Ancien format : storage/message/<session>/<message>.json, texte dans storage/part/<message>/*.json. */
  parseLegacy(file) {
    let d;
    try {
      d = obj(safeJson(import_node_fs6.default.readFileSync(file.path, "utf8")));
    } catch {
      return;
    }
    const id = str(d.id) || import_node_path9.default.basename(file.path, ".json");
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.agg.fileScanned(this.tool);
    const session = str(d.sessionID) || import_node_path9.default.basename(import_node_path9.default.dirname(file.path));
    const ts = num(obj(d.time).created);
    if (!ts) return;
    const p = obj(d.path);
    const project = projectName(str(p.cwd) || str(p.root));
    this.agg.activity(this.tool, ts, session);
    if (str(d.role) === "assistant") {
      if (d.tokens) this.usage({ id, session, ts, model: str(d.modelID), provider: str(d.providerID), t: d.tokens, project });
    }
    const partsDir = import_node_path9.default.join(import_node_path9.default.dirname(import_node_path9.default.dirname(import_node_path9.default.dirname(file.path))), "part", id);
    let parts = [];
    try {
      parts = import_node_fs6.default.readdirSync(partsDir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    let chars = 0;
    for (const n of parts) {
      let part;
      try {
        part = obj(safeJson(import_node_fs6.default.readFileSync(import_node_path9.default.join(partsDir, n), "utf8")));
      } catch {
        continue;
      }
      if (part.type === "text" && str(d.role) === "user" && !part.synthetic) chars += str(part.text).length;
      else if (part.type === "tool") this.call(str(part.tool), str(part.callID), JSON.stringify(obj(obj(part.state).input)), ts, session);
    }
    if (chars > 0 && !this.seen.has(`prompt:${id}`)) {
      this.seen.add(`prompt:${id}`);
      this.agg.prompt({ tool: this.tool, ts, chars, session, project });
    }
  }
};

// src/parsers/pi.ts
var import_node_path10 = __toESM(require("node:path"));
var CANON6 = {
  read: "Read",
  bash: "Bash",
  edit: "Edit",
  write: "Write",
  grep: "Grep",
  find: "Glob",
  ls: "Glob",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  subagent: "Task",
  task: "Task"
};
async function findPiFiles(root, since) {
  const files = await walk(import_node_path10.default.join(root, "sessions"), (n) => n.endsWith(".jsonl"), since, 3);
  return files.filter((f) => !f.path.split(/[\\/]/).includes("subagent-artifacts"));
}
function textLength(content) {
  if (typeof content === "string") return content.length;
  return arr(content).reduce((a, c) => obj(c).type === "text" ? a + str(obj(c).text).length : a, 0);
}
var PiParser = class {
  constructor(agg) {
    this.agg = agg;
  }
  agg;
  seen = /* @__PURE__ */ new Set();
  async parse(file) {
    this.agg.fileScanned("pi");
    let session = import_node_path10.default.basename(file.path, ".jsonl").replace(/^.*_/, "");
    let project;
    let model = "";
    await eachLine(file.path, (line) => {
      const j = safeJson(line);
      if (!j) return;
      const type = str(j.type);
      if (type === "session") {
        session = str(j.id) || session;
        project = projectName(str(j.cwd));
        return;
      }
      if (type === "model_change") {
        model = str(j.modelId) || model;
        return;
      }
      if (type !== "message") return;
      const m = obj(j.message);
      const ts = Date.parse(str(j.timestamp)) || num(m.timestamp);
      if (!ts) return;
      const id = `${session}:${str(j.id)}`;
      const role = str(m.role);
      if (role === "user") {
        if (this.seen.has(id)) return;
        this.seen.add(id);
        const chars = textLength(m.content);
        if (chars > 0) this.agg.prompt({ tool: "pi", ts, chars, session, project });
        return;
      }
      if (role !== "assistant") return;
      this.agg.activity("pi", ts, session);
      const key = str(m.responseId) || id;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      for (const c of arr(m.content)) {
        const b = obj(c);
        if (b.type !== "toolCall") continue;
        const name = str(b.name);
        const canonical = CANON6[name.toLowerCase()] ?? (name.includes("_") ? "MCP" : name);
        const args = obj(b.arguments);
        const f = canonical === "Read" || canonical === "Edit" || canonical === "Write" ? str(args.path) || str(args.file_path) || void 0 : void 0;
        this.agg.call({ tool: "pi", ts, name: canonical, file: f, creates: canonical === "Write", session });
      }
      const u = obj(m.usage);
      const inp = num(u.input);
      const out2 = num(u.output);
      const cr = num(u.cacheRead);
      const cw = num(u.cacheWrite);
      if (inp + out2 + cr + cw === 0) return;
      const cw1 = Math.min(num(u.cacheWrite1h), cw);
      this.agg.usage({
        tool: "pi",
        model: str(m.model) || model || "unknown",
        ts,
        inp,
        out: out2,
        cw5: cw - cw1,
        cw1,
        cr,
        rs: Math.min(num(u.reasoning), out2),
        promptSize: inp + cr + cw,
        session,
        project
      });
    });
  }
};

// src/parsers/qwen.ts
var import_node_path11 = __toESM(require("node:path"));
var CANON7 = {
  read_file: "Read",
  read_many_files: "Read",
  write_file: "Write",
  replace: "Edit",
  edit: "Edit",
  run_shell_command: "Bash",
  glob: "Glob",
  list_directory: "Glob",
  search_file_content: "Grep",
  grep_search: "Grep",
  grep: "Grep",
  web_fetch: "WebFetch",
  web_search: "WebSearch",
  google_web_search: "WebSearch",
  task: "Task",
  todo_write: "Todo",
  exit_plan_mode: "Plan"
};
async function findQwenFiles(root, since) {
  const files = await walk(import_node_path11.default.join(root, "projects"), (n) => n.endsWith(".jsonl"), since, 4);
  return files.filter((f) => f.path.split(/[\\/]/).includes("chats"));
}
var QwenParser = class {
  constructor(agg) {
    this.agg = agg;
  }
  agg;
  seen = /* @__PURE__ */ new Set();
  async parse(file) {
    this.agg.fileScanned("qwen");
    await eachLine(file.path, (line) => {
      const j = safeJson(line);
      if (!j) return;
      const type = str(j.type);
      if (type !== "user" && type !== "assistant") return;
      const ts = Date.parse(str(j.timestamp));
      if (!Number.isFinite(ts)) return;
      const session = str(j.sessionId) || import_node_path11.default.basename(file.path, ".jsonl");
      const key = str(j.uuid) || `${session}:${str(j.timestamp)}:${type}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      const project = projectName(str(j.cwd));
      const parts = arr(obj(j.message).parts).map(obj);
      if (type === "user") {
        if (j.subtype) return;
        const chars = parts.reduce((a, p) => p.thought ? a : a + str(p.text).length, 0);
        if (chars > 0) this.agg.prompt({ tool: "qwen", ts, chars, session, project });
        return;
      }
      this.agg.activity("qwen", ts, session);
      for (const p of parts) {
        const call = obj(p.functionCall);
        const name = str(call.name);
        if (!name) continue;
        const c = CANON7[name] ?? (name.includes("__") ? "MCP" : name);
        const args = obj(call.args);
        const f = c === "Read" || c === "Edit" || c === "Write" ? str(args.file_path) || str(args.absolute_path) || str(args.path) || void 0 : void 0;
        this.agg.call({ tool: "qwen", ts, name: c, file: f, creates: c === "Write", session });
      }
      const u = obj(j.usageMetadata);
      const prompt = num(u.promptTokenCount);
      const cand = num(u.candidatesTokenCount);
      const thoughts = num(u.thoughtsTokenCount);
      const cr = Math.min(num(u.cachedContentTokenCount), prompt);
      if (prompt + cand + thoughts === 0) return;
      const total = typeof u.totalTokenCount === "number" ? u.totalTokenCount : void 0;
      const inCandidates = thoughts > 0 && total !== void 0 && (total === 0 ? cand > 0 : total === prompt + cand);
      const out2 = inCandidates ? cand : cand + thoughts;
      this.agg.usage({
        tool: "qwen",
        model: str(j.model) || "qwen",
        ts,
        inp: prompt - cr,
        out: out2,
        cw5: 0,
        cw1: 0,
        cr,
        rs: inCandidates ? Math.min(thoughts, cand) : thoughts,
        promptSize: prompt,
        session,
        project
      });
    });
  }
};

// src/parsers/gemini.ts
var import_node_fs7 = __toESM(require("node:fs"));
var import_node_path12 = __toESM(require("node:path"));
var CANON8 = {
  read_file: "Read",
  read_many_files: "Read",
  write_file: "Write",
  replace: "Edit",
  edit: "Edit",
  run_shell_command: "Bash",
  glob: "Glob",
  list_directory: "Glob",
  search_file_content: "Grep",
  grep: "Grep",
  web_fetch: "WebFetch",
  google_web_search: "WebSearch",
  save_memory: "Memory"
};
async function findGeminiFiles(root, since) {
  return walk(import_node_path12.default.join(root, "tmp"), (n) => /\.(json|jsonl)$/.test(n) && (n.startsWith("session-") || /^[0-9a-f-]{20,}\.jsonl$/.test(n)), since, 5);
}
function projectFromPath(file) {
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf("chats");
  const dir = i > 0 ? parts[i - 1] : "";
  if (!dir || /^[0-9a-f]{40,}$/.test(dir)) return void 0;
  return dir;
}
function textOf(content) {
  if (typeof content === "string") return content;
  return arr(content).map((c) => str(obj(c).text)).join("");
}
var GeminiParser = class {
  constructor(agg) {
    this.agg = agg;
  }
  agg;
  messages = /* @__PURE__ */ new Map();
  async parse(file) {
    this.agg.fileScanned("gemini");
    const project = projectFromPath(file.path);
    let session = import_node_path12.default.basename(file.path).replace(/\.(json|jsonl)$/, "");
    const put = (m) => {
      if (!m.id) return;
      const prev = this.messages.get(m.id);
      this.messages.set(m.id, { ...prev ?? {}, ...m, session, project });
    };
    if (file.path.endsWith(".json")) {
      let data = null;
      try {
        data = safeJson(await import_node_fs7.default.promises.readFile(file.path, "utf8"));
      } catch {
        return;
      }
      if (!data) return;
      session = str(data.sessionId) || session;
      for (const m of arr(data.messages)) put(obj(m));
      return;
    }
    await eachLine(file.path, (line) => {
      const j = safeJson(line);
      if (!j) return;
      if (typeof j.sessionId === "string" && !("id" in j)) {
        session = j.sessionId;
        return;
      }
      const patch = obj(j.$patch);
      if (patch.id) {
        const updates = obj(patch.updates);
        put({ ...patch, ...updates, id: str(patch.id) });
        return;
      }
      if (typeof j.id === "string") put(j);
    });
  }
  /** À appeler une fois tous les fichiers lus (dédoublonnage global par id). */
  flush() {
    let lastModel = "gemini-2.5-pro";
    const sorted = [...this.messages.values()].sort((a, b) => Date.parse(a.timestamp ?? "") - Date.parse(b.timestamp ?? ""));
    for (const m of sorted) {
      const ts = Date.parse(m.timestamp ?? "");
      if (!Number.isFinite(ts)) continue;
      if (m.type === "user") {
        const text2 = textOf(m.content);
        if (text2.trim() && !text2.startsWith("/")) this.agg.prompt({ tool: "gemini", ts, chars: text2.length, session: m.session, project: m.project });
        continue;
      }
      if (m.type !== "gemini") continue;
      if (m.model) lastModel = m.model;
      const t = obj(m.tokens);
      const input = num(t.input);
      const cached = num(t.cached);
      const thoughts = num(t.thoughts);
      this.agg.usage({
        tool: "gemini",
        model: m.model || lastModel,
        ts,
        inp: Math.max(0, input - cached) + num(t.tool),
        out: num(t.output) + thoughts,
        cw5: 0,
        cw1: 0,
        cr: cached,
        rs: thoughts,
        promptSize: input,
        session: m.session,
        project: m.project
      });
      for (const call of arr(m.toolCalls)) {
        const c = obj(call);
        const raw = str(c.name);
        const name = CANON8[raw] ?? (raw.includes("__") ? "MCP" : raw || "Other");
        const args = obj(c.args);
        const file = str(args.file_path) || str(args.absolute_path) || str(args.path) || void 0;
        this.agg.call({ tool: "gemini", ts, name, file: name === "Read" || name === "Edit" || name === "Write" ? file : void 0, creates: name === "Write", session: m.session });
      }
    }
    this.messages.clear();
  }
};

// src/sources.ts
var options = {};
var SOURCES = [
  {
    id: "claude",
    name: "Claude Code",
    root: (dir) => home(dir ?? process.env.CLAUDE_CONFIG_DIR ?? "~/.claude"),
    probe: (root) => import_node_path13.default.join(root, "projects"),
    find: findClaudeFiles,
    parser: (agg) => new ClaudeParser(agg)
  },
  {
    id: "codex",
    name: "Codex",
    root: (dir) => home(dir ?? process.env.CODEX_HOME ?? "~/.codex"),
    probe: (root) => import_node_path13.default.join(root, "sessions"),
    find: findCodexFiles,
    parser: (agg) => new CodexParser(agg)
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    root: (dir) => home(dir ?? "~/.gemini"),
    probe: (root) => import_node_path13.default.join(root, "tmp"),
    find: findGeminiFiles,
    parser: (agg) => new GeminiParser(agg)
  },
  {
    id: "antigravity",
    name: "Antigravity",
    root: (dir) => home(dir ?? "~/.gemini"),
    // IDE, application 2.0 et CLI agy ont chacun leur dossier : on affiche le premier présent.
    probe: (root) => ANTIGRAVITY_APPS.map((a) => import_node_path13.default.join(root, a)).find((p) => exists(p)) ?? import_node_path13.default.join(root, "antigravity"),
    sqlite: true,
    find: findAntigravityFiles,
    parser: (agg) => new AntigravityParser(agg)
  },
  {
    id: "cursor",
    name: "Cursor",
    root: (dir) => home(dir ?? appData("Cursor")),
    // L’IDE, sinon le CLI cursor-agent, sinon l’export CSV passé avec --cursor-csv.
    probe: (root) => [import_node_path13.default.dirname(cursorDb(root)), import_node_path13.default.join(cursorHome(), "projects")].find((p) => exists(p)) ?? (options.cursorCsv ? import_node_path13.default.dirname(import_node_path13.default.resolve(options.cursorCsv)) : import_node_path13.default.dirname(cursorDb(root))),
    sqlite: true,
    find: (root, since) => findCursorFiles(root, since, options.cursorCsv),
    parser: (agg) => new CursorParser(agg)
  },
  {
    id: "opencode",
    name: "OpenCode",
    root: (dir) => home(dir ?? process.env.OPENCODE_DATA_DIR ?? xdgData("opencode")),
    probe: (root) => root,
    sqlite: true,
    find: findOpencodeFiles,
    parser: (agg) => new OpencodeParser(agg)
  },
  {
    id: "copilot",
    name: "Copilot CLI",
    root: (dir) => home(dir ?? (process.env.COPILOT_HOME?.trim() || "~/.copilot")),
    probe: (root) => import_node_path13.default.join(root, "session-state"),
    find: findCopilotFiles,
    parser: (agg) => new CopilotParser(agg)
  },
  {
    id: "pi",
    name: "Pi",
    root: (dir) => home(dir ?? process.env.PI_CODING_AGENT_DIR ?? "~/.pi/agent"),
    probe: (root) => import_node_path13.default.join(root, "sessions"),
    find: findPiFiles,
    parser: (agg) => new PiParser(agg)
  },
  {
    id: "qwen",
    name: "Qwen Code",
    root: (dir) => home(dir ?? process.env.QWEN_HOME ?? "~/.qwen"),
    probe: (root) => import_node_path13.default.join(root, "projects"),
    find: findQwenFiles,
    parser: (agg) => new QwenParser(agg)
  },
  {
    id: "cline",
    name: "Cline",
    // --cline-dir : le dossier de stockage de l’extension (celui qui contient tasks/).
    root: (dir) => dir ? home(dir) : "",
    probe: (root) => {
      const dirs = clineTaskDirs(root || void 0);
      return dirs.find((p) => exists(p)) ?? dirs[0];
    },
    find: (root, since) => findClineFiles(clineTaskDirs(root || void 0), since),
    parser: (agg) => new ClineParser(agg)
  }
];

// src/ui.ts
var env = process.env;
var isTTY = !!process.stdout.isTTY;
var noColor = "NO_COLOR" in env || env.TERM === "dumb" || !isTTY;
var truecolor = env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || process.platform === "win32" || !!env.WT_SESSION;
function rgb(r, g, b, c256) {
  return (s) => {
    if (noColor) return s;
    return truecolor ? `\x1B[38;2;${r};${g};${b}m${s}\x1B[39m` : `\x1B[38;5;${c256}m${s}\x1B[39m`;
  };
}
var yellow = rgb(242, 233, 78, 221);
var claude = rgb(229, 135, 95, 173);
var codex = rgb(94, 209, 162, 79);
var gemini = rgb(142, 166, 255, 111);
var antigravity = rgb(201, 155, 255, 141);
var cursorTool = rgb(92, 200, 230, 81);
var opencode = rgb(242, 141, 181, 211);
var copilot = rgb(240, 112, 112, 203);
var pi = rgb(179, 217, 100, 149);
var qwen = rgb(229, 138, 224, 176);
var cline = rgb(163, 182, 204, 146);
var danger = rgb(255, 107, 90, 203);
var dim = (s) => noColor ? s : `\x1B[2m${s}\x1B[22m`;
var bold = (s) => noColor ? s : `\x1B[1m${s}\x1B[22m`;
var underline = (s) => noColor ? s : `\x1B[4m${s}\x1B[24m`;
var TOOL_PAINT = { claude, codex, gemini, antigravity, cursor: cursorTool, opencode, copilot, pi, qwen, cline };
function cursor() {
  return noColor ? "|" : yellow("\u2588");
}
function out(line = "") {
  process.stdout.write(`${line}
`);
}
function err(line) {
  process.stderr.write(`${line}
`);
}
function progressLine(text2) {
  if (!isTTY) return;
  const width = process.stdout.columns || 80;
  process.stdout.write(`\r${text2.slice(0, width - 1).padEnd(Math.min(width - 1, 90))}`);
}
function clearLine() {
  if (!isTTY) return;
  process.stdout.write("\r\x1B[2K");
}
function bar(ratio, width = 10) {
  const full = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return "\u2501".repeat(full) + dim("\u2501".repeat(width - full));
}

// src/index.ts
var VERSION = "0.2.0";
var DEFAULT_URL = "https://wrapped.mazaki.fr";
var ALL_TOOLS = [...TOOL_IDS];
function parseArgs(argv) {
  const a = {
    all: false,
    only: ALL_TOOLS,
    hideProjects: false,
    noStats: false,
    noOpen: false,
    json: false,
    dirs: {},
    url: process.env.WRAPPEDAI_URL || DEFAULT_URL,
    help: false,
    version: false
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2);
    const next = () => inline ?? argv[++i] ?? "";
    switch (flag) {
      case "--year":
        a.year = Number(next());
        break;
      case "--since":
        a.since = next();
        break;
      case "--all":
        a.all = true;
        break;
      case "--only":
        a.only = next().split(",").map((s) => s.trim()).filter((s) => ALL_TOOLS.includes(s));
        break;
      case "--hide-projects":
        a.hideProjects = true;
        break;
      case "--no-stats":
        a.noStats = true;
        break;
      case "--no-open":
        a.noOpen = true;
        break;
      case "--json":
        a.json = true;
        break;
      case "--lang":
        a.lang = next();
        break;
      case "--cursor-csv":
        options.cursorCsv = next();
        break;
      case "--url":
        a.url = next();
        break;
      case "-h":
      case "--help":
        a.help = true;
        break;
      case "-v":
      case "--version":
        a.version = true;
        break;
      default: {
        const dir = /^--([a-z]+)-dir$/.exec(flag);
        if (dir && ALL_TOOLS.includes(dir[1])) {
          a.dirs[dir[1]] = next();
          break;
        }
        err(danger(`Option inconnue / unknown option: ${argv[i]}`));
        a.help = true;
      }
    }
  }
  return a;
}
function pretty(p) {
  const h = import_node_os4.default.homedir();
  return p.startsWith(h) ? `~${p.slice(h.length)}`.replace(/\\/g, "/") : p;
}
function installId() {
  const dir = import_node_path14.default.join(import_node_os4.default.homedir(), ".wrappedai");
  const file = import_node_path14.default.join(dir, "id");
  try {
    const existing = import_node_fs8.default.readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{16,32}$/.test(existing)) return existing;
  } catch {
  }
  const id = (0, import_node_crypto.randomBytes)(16).toString("base64url");
  try {
    import_node_fs8.default.mkdirSync(dir, { recursive: true });
    import_node_fs8.default.writeFileSync(file, id, { mode: 384 });
  } catch {
  }
  return id;
}
function encode(p) {
  return `v1.${(0, import_node_zlib.deflateRawSync)(Buffer.from(JSON.stringify(p)), { level: 9 }).toString("base64url")}`;
}
function openBrowser(url) {
  try {
    let cmd;
    let args;
    if (process.platform === "win32") {
      cmd = "rundll32";
      args = ["url.dll,FileProtocolHandler", url];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (process.env.WSL_DISTRO_NAME) {
      cmd = "wslview";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = (0, import_node_child_process.spawn)(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => void 0);
    child.unref();
    return true;
  } catch {
    return false;
  }
}
function fmtInt(n, lang) {
  return new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-US").format(Math.round(n));
}
function fmtCompact(n, lang) {
  const units = [
    [1e12, lang === "fr" ? " Bn" : "T"],
    [1e9, lang === "fr" ? " Md" : "B"],
    [1e6, lang === "fr" ? " M" : "M"],
    [1e3, lang === "fr" ? " k" : "k"]
  ];
  for (const [base, unit] of units) {
    if (n >= base) {
      const v = n / base;
      return `${new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: v >= 100 ? 0 : 1 }).format(v)}${unit}`;
    }
  }
  return fmtInt(n, lang);
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lang = detectLang(args.lang);
  const t = TEXT[lang];
  if (args.version) {
    out(VERSION);
    return;
  }
  if (args.help) {
    out(t.help);
    return;
  }
  const now = /* @__PURE__ */ new Date();
  let scope = "year";
  let start;
  let end = now.getTime();
  let year;
  if (args.all) {
    scope = "all";
    start = 0;
  } else if (args.since && /^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
    scope = "since";
    start = (/* @__PURE__ */ new Date(`${args.since}T00:00:00`)).getTime();
  } else {
    year = args.year && args.year > 2e3 && args.year < 3e3 ? args.year : now.getFullYear();
    start = new Date(year, 0, 1).getTime();
    end = Math.min(end, new Date(year + 1, 0, 1).getTime() - 1);
  }
  const agg = new Aggregator({ start, end });
  if (!args.json) {
    out();
    out(`  ${cursor()} ${bold("wrapped")} ${dim(`${VERSION} \xB7 ${t.tagline}`)}`);
    out();
  }
  const nameW = Math.max(...SOURCES.map((s) => s.name.length));
  const pathW = 26;
  for (const src of SOURCES) {
    const root = src.root(args.dirs[src.id]);
    const probe = src.probe(root);
    const shown = pretty(probe);
    const label = `  ${TOOL_PAINT[src.id](src.name.padEnd(nameW))}  ${dim((shown.length > pathW ? `\u2026${shown.slice(-(pathW - 1))}` : shown).padEnd(pathW))}`;
    if (!args.only.includes(src.id)) {
      if (!args.json) out(`${label} ${dim(t.skipped)}`);
      continue;
    }
    if (!exists(probe)) {
      if (!args.json) out(`${label} ${dim(t.notFound)}`);
      continue;
    }
    const parser = src.parser(agg);
    const files = await src.find(root, start - 864e5);
    const total = files.reduce((a, f) => a + f.size, 0) || 1;
    let done = 0;
    for (const f of files) {
      if (!args.json) progressLine(`${label} ${t.files(fmtInt(files.length, lang)).padStart(16)}  ${bar(done / total)}`);
      try {
        await parser.parse(f);
      } catch {
      }
      done += f.size;
    }
    parser.flush?.();
    if (!args.json) {
      clearLine();
      out(`${label} ${t.files(fmtInt(files.length, lang)).padStart(16)}  ${bar(1)} ok`);
      const pad = `  ${" ".repeat(nameW)}  `;
      if (src.sqlite && files.length > 0 && !sqliteAvailable()) out(`${pad}${dim(t.needsSqlite(process.versions.node))}`);
      else if (parser instanceof CursorParser && files.length > 0) {
        out(`${pad}${dim(parser.csvRows > 0 ? t.cursorCsv(fmtInt(parser.csvRows, lang)) : t.cursorNoTokens)}`);
      }
    }
  }
  if (!agg.hasActivity()) {
    out();
    out(`  ${t.noData}`);
    out(`  ${dim(t.noDataHint)}`);
    out();
    process.exitCode = 1;
    return;
  }
  const payload = agg.build({
    id: installId(),
    noStats: args.noStats,
    cli: VERSION,
    lang,
    scope,
    year,
    hideProjects: args.hideProjects,
    tools: args.only
  });
  if (args.json) {
    out(JSON.stringify(payload, null, 2));
    return;
  }
  const days = Math.round(((/* @__PURE__ */ new Date(`${payload.to}T00:00:00`)).getTime() - (/* @__PURE__ */ new Date(`${payload.from}T00:00:00`)).getTime()) / 864e5) + 1;
  const tokens = payload.models.reduce((a, m) => a + m.u[0] + m.u[1] + m.u[2] + m.u[3] + m.u[4], 0);
  out();
  out(`  ${bold(t.summary(fmtInt(days, lang), fmtInt(payload.sessions, lang)))}${yellow(bold(t.tokens(fmtCompact(tokens, lang))))}`);
  const claudeFirst = payload.tools.claude?.first;
  if (claudeFirst && scope !== "since") {
    const claudeDays = Math.round(((/* @__PURE__ */ new Date(`${payload.to}T00:00:00`)).getTime() - (/* @__PURE__ */ new Date(`${claudeFirst}T00:00:00`)).getTime()) / 864e5) + 1;
    if (claudeDays <= 32) out(`  ${dim(t.retention(claudeDays))}`);
  }
  const base = args.url.replace(/\/+$/, "");
  const url = `${base}/${lang}/w#${encode(payload)}`;
  const shortUrl = url.length > 70 ? `${url.slice(0, 66)}\u2026` : url;
  out();
  const opened = !args.noOpen && openBrowser(url);
  if (opened) {
    out(`  ${yellow("\u2192")} ${underline(shortUrl)}`);
    out(`    ${dim(t.opened)}`);
    out(`    ${dim(t.opened2)}`);
  } else {
    out(`  ${yellow("\u2192")} ${t.notOpened}`);
    out();
    out(url);
  }
  out();
  out(`  ${dim(args.noStats ? t.noStats : t.stats)}`);
  out();
}
process.stdout.on("error", (e) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});
main().catch((e) => {
  err(danger(`wrappedai: ${e instanceof Error ? e.message : String(e)}`));
  process.exitCode = 1;
});
