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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/index.ts
var import_node_child_process = require("node:child_process");
var import_node_crypto = require("node:crypto");
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path5 = __toESM(require("node:path"));
var import_node_zlib = require("node:zlib");

// src/collect.ts
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
  toolStats = {
    claude: { files: 0, sessions: /* @__PURE__ */ new Set(), prompts: 0, first: Infinity },
    codex: { files: 0, sessions: /* @__PURE__ */ new Set(), prompts: 0, first: Infinity },
    gemini: { files: 0, sessions: /* @__PURE__ */ new Set(), prompts: 0, first: Infinity }
  };
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
  inRange(ts) {
    return Number.isFinite(ts) && ts >= this.range.start && ts <= this.range.end;
  }
  fileScanned(tool) {
    this.toolStats[tool].files += 1;
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
    if (ts < this.toolStats[tool].first) this.toolStats[tool].first = ts;
    if (ts < this.minTs) this.minTs = ts;
    if (ts > this.maxTs) this.maxTs = ts;
    return s;
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
    row.n += 1;
    const day = localDay(e.ts);
    const d = this.daily.get(day) ?? [0, 0];
    d[1] += total;
    this.daily.set(day, d);
    if (e.project) {
      const p = this.projects.get(e.project) ?? [0, 0];
      p[0] += total;
      this.projects.set(e.project, p);
    }
    this.touch(e.tool, e.ts, e.session);
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
  noData: "Aucune activit\xE9 trouv\xE9e sur cette p\xE9riode.",
  noDataHint: "Essaie --all pour tout l\u2019historique, ou v\xE9rifie que Claude Code, Codex ou Gemini CLI tournent sur cette machine.",
  summary: (days, sessions) => `${days} jours \xB7 ${sessions} sessions \xB7 `,
  tokens: (t) => `${t} tokens`,
  opened: "ouvert dans ton navigateur. Tout est apr\xE8s le #,",
  opened2: "et ton navigateur ne l\u2019envoie jamais au serveur.",
  notOpened: "copie ce lien dans ton navigateur :",
  stats: "Tes totaux anonymes alimentent le compteur global. Pour refuser : --no-stats",
  noStats: "Stats globales d\xE9sactiv\xE9es (--no-stats).",
  retention: (d) => `Claude Code n\u2019a gard\xE9 que ${d} jours de logs. Pour une ann\xE9e enti\xE8re : "cleanupPeriodDays": 365 dans ~/.claude/settings.json`,
  period: { year: (y) => `ann\xE9e ${y}`, since: (d) => `depuis le ${d}`, all: "tout l\u2019historique" },
  help: `Usage : npx aiwrapped [options]

Lit en local les logs de Claude Code, Codex et Gemini CLI, calcule ton Wrapped
et l\u2019ouvre sur wrapped.mazaki.fr. Tes prompts et ton code ne quittent pas ta machine.

Options
  --year <AAAA>          une ann\xE9e pr\xE9cise (d\xE9faut : l\u2019ann\xE9e en cours)
  --since <AAAA-MM-JJ>   depuis une date
  --all                  tout l\u2019historique
  --only <outils>        claude,codex,gemini
  --hide-projects        remplace les noms de projets par projet-1, projet-2\u2026
  --no-stats             ne pas compter ce Wrapped dans les statistiques globales
  --no-open              affiche le lien sans ouvrir le navigateur
  --json                 affiche les donn\xE9es qui seraient envoy\xE9es, et c\u2019est tout
  --lang <fr|en>         langue du terminal et du site
  --claude-dir <chemin>  dossier Claude Code (d\xE9faut : ~/.claude)
  --codex-dir <chemin>   dossier Codex (d\xE9faut : ~/.codex)
  --gemini-dir <chemin>  dossier Gemini CLI (d\xE9faut : ~/.gemini)
  -v, --version          version
  -h, --help             cette aide`
};
var en = {
  tagline: "local read, nothing is sent",
  files: (n) => `${n} files`,
  notFound: "not found",
  skipped: "skipped",
  noData: "No activity found for this period.",
  noDataHint: "Try --all for your whole history, or check that Claude Code, Codex or Gemini CLI run on this machine.",
  summary: (days, sessions) => `${days} days \xB7 ${sessions} sessions \xB7 `,
  tokens: (t) => `${t} tokens`,
  opened: "opened in your browser. Everything is after the #,",
  opened2: "and your browser never sends that part to the server.",
  notOpened: "paste this link in your browser:",
  stats: "Your anonymous totals feed the global counter. To opt out: --no-stats",
  noStats: "Global stats disabled (--no-stats).",
  retention: (d) => `Claude Code only kept ${d} days of logs. For a full year: "cleanupPeriodDays": 365 in ~/.claude/settings.json`,
  period: { year: (y) => `year ${y}`, since: (d) => `since ${d}`, all: "full history" },
  help: `Usage: npx aiwrapped [options]

Reads your Claude Code, Codex and Gemini CLI logs locally, computes your Wrapped
and opens it on wrapped.mazaki.fr. Your prompts and code never leave your machine.

Options
  --year <YYYY>          a specific year (default: the current year)
  --since <YYYY-MM-DD>   from a date
  --all                  your whole history
  --only <tools>         claude,codex,gemini
  --hide-projects        replace project names with projet-1, projet-2\u2026
  --no-stats             don\u2019t count this Wrapped in the global stats
  --no-open              print the link without opening the browser
  --json                 print the data that would be sent, and stop
  --lang <fr|en>         terminal and website language
  --claude-dir <path>    Claude Code folder (default: ~/.claude)
  --codex-dir <path>     Codex folder (default: ~/.codex)
  --gemini-dir <path>    Gemini CLI folder (default: ~/.gemini)
  -v, --version          version
  -h, --help             this help`
};
var TEXT = { fr, en };

// src/parsers/claude.ts
var import_node_path2 = __toESM(require("node:path"));
var CANON = {
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
function canon(name) {
  if (name.startsWith("mcp__")) return "MCP";
  return CANON[name] ?? name;
}
var NOT_A_PROMPT = /^\s*(<command-name>|<command-message>|<local-command-std|<local-command-caveat>|Caveat:|\[Request interrupted|<system-reminder>|<bash-input>|<bash-stdout>|<task-notification>)/;
async function findClaudeFiles(root, since) {
  return walk(import_node_path2.default.join(root, "projects"), (n) => n.endsWith(".jsonl"), since);
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
      const name = canon(str(b.name));
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
    let text = "";
    if (typeof msg.content === "string") text = msg.content;
    else {
      for (const part of arr(msg.content)) {
        const p = obj(part);
        if (p.type === "tool_result") return;
        if (p.type === "text") text += str(p.text);
      }
    }
    if (!text.trim() || NOT_A_PROMPT.test(text)) return;
    const ts = Date.parse(str(j.timestamp));
    const typed = text.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, "").trim();
    const chars = Math.max(1, typed.length || Math.min(text.length, 2e3));
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
var import_node_path3 = __toESM(require("node:path"));
async function findCodexFiles(root, since) {
  const a = await walk(import_node_path3.default.join(root, "sessions"), (n) => n.endsWith(".jsonl"), since);
  const b = await walk(import_node_path3.default.join(root, "archived_sessions"), (n) => n.endsWith(".jsonl"), since, 1);
  const seen = /* @__PURE__ */ new Set();
  return [...a, ...b].filter((f) => {
    const k = import_node_path3.default.basename(f.path);
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
    let session = import_node_path3.default.basename(file.path, ".jsonl");
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
      const text = arr(item.content).map((c) => str(obj(c).text)).join("");
      if (text.trim()) userMsgs.push({ ts, chars: text.length });
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

// src/parsers/gemini.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path4 = __toESM(require("node:path"));
var CANON2 = {
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
  return walk(import_node_path4.default.join(root, "tmp"), (n) => /\.(json|jsonl)$/.test(n) && (n.startsWith("session-") || /^[0-9a-f-]{20,}\.jsonl$/.test(n)), since, 5);
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
    let session = import_node_path4.default.basename(file.path).replace(/\.(json|jsonl)$/, "");
    const put = (m) => {
      if (!m.id) return;
      const prev = this.messages.get(m.id);
      this.messages.set(m.id, { ...prev ?? {}, ...m, session, project });
    };
    if (file.path.endsWith(".json")) {
      let data = null;
      try {
        data = safeJson(await import_node_fs2.default.promises.readFile(file.path, "utf8"));
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
        const text = textOf(m.content);
        if (text.trim() && !text.startsWith("/")) this.agg.prompt({ tool: "gemini", ts, chars: text.length, session: m.session, project: m.project });
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
        const name = CANON2[raw] ?? (raw.includes("__") ? "MCP" : raw || "Other");
        const args = obj(c.args);
        const file = str(args.file_path) || str(args.absolute_path) || str(args.path) || void 0;
        this.agg.call({ tool: "gemini", ts, name, file: name === "Read" || name === "Edit" || name === "Write" ? file : void 0, creates: name === "Write", session: m.session });
      }
    }
    this.messages.clear();
  }
};

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
var danger = rgb(255, 107, 90, 203);
var dim = (s) => noColor ? s : `\x1B[2m${s}\x1B[22m`;
var bold = (s) => noColor ? s : `\x1B[1m${s}\x1B[22m`;
var underline = (s) => noColor ? s : `\x1B[4m${s}\x1B[24m`;
var TOOL_PAINT = { claude, codex, gemini };
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
function progressLine(text) {
  if (!isTTY) return;
  const width = process.stdout.columns || 80;
  process.stdout.write(`\r${text.slice(0, width - 1).padEnd(Math.min(width - 1, 90))}`);
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
var VERSION = "0.1.0";
var DEFAULT_URL = "https://wrapped.mazaki.fr";
var ALL_TOOLS = ["claude", "codex", "gemini"];
function parseArgs(argv) {
  const a = {
    all: false,
    only: ALL_TOOLS,
    hideProjects: false,
    noStats: false,
    noOpen: false,
    json: false,
    dirs: {},
    url: process.env.AIWRAPPED_URL || DEFAULT_URL,
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
      case "--claude-dir":
        a.dirs.claude = next();
        break;
      case "--codex-dir":
        a.dirs.codex = next();
        break;
      case "--gemini-dir":
        a.dirs.gemini = next();
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
      default:
        err(danger(`Option inconnue / unknown option: ${argv[i]}`));
        a.help = true;
    }
  }
  return a;
}
function home(p) {
  return p.startsWith("~") ? import_node_path5.default.join(import_node_os.default.homedir(), p.slice(1)) : p;
}
function pretty(p) {
  const h = import_node_os.default.homedir();
  return p.startsWith(h) ? `~${p.slice(h.length)}`.replace(/\\/g, "/") : p;
}
function installId() {
  const dir = import_node_path5.default.join(import_node_os.default.homedir(), ".aiwrapped");
  const file = import_node_path5.default.join(dir, "id");
  try {
    const existing = import_node_fs3.default.readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{16,32}$/.test(existing)) return existing;
  } catch {
  }
  const id = (0, import_node_crypto.randomBytes)(16).toString("base64url");
  try {
    import_node_fs3.default.mkdirSync(dir, { recursive: true });
    import_node_fs3.default.writeFileSync(file, id, { mode: 384 });
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
  const roots = {
    claude: home(args.dirs.claude ?? process.env.CLAUDE_CONFIG_DIR ?? "~/.claude"),
    codex: home(args.dirs.codex ?? process.env.CODEX_HOME ?? "~/.codex"),
    gemini: home(args.dirs.gemini ?? "~/.gemini")
  };
  const subdir = { claude: "projects", codex: "sessions", gemini: "tmp" };
  if (!args.json) {
    out();
    out(`  ${cursor()} ${bold("wrapped")} ${dim(`${VERSION} \xB7 ${t.tagline}`)}`);
    out();
  }
  const claude2 = new ClaudeParser(agg);
  const codex2 = new CodexParser(agg);
  const gemini2 = new GeminiParser(agg);
  const finders = {
    claude: findClaudeFiles,
    codex: findCodexFiles,
    gemini: findGeminiFiles
  };
  const parsers = { claude: claude2, codex: codex2, gemini: gemini2 };
  for (const tool of ALL_TOOLS) {
    const paint = TOOL_PAINT[tool];
    const label = `  ${paint(tool.padEnd(6))}  ${dim(pretty(import_node_path5.default.join(roots[tool], subdir[tool])).padEnd(22))}`;
    if (!args.only.includes(tool)) {
      if (!args.json) out(`${label} ${dim(t.skipped)}`);
      continue;
    }
    if (!exists(import_node_path5.default.join(roots[tool], subdir[tool]))) {
      if (!args.json) out(`${label} ${dim(t.notFound)}`);
      continue;
    }
    const files = await finders[tool](roots[tool], start - 864e5);
    const total = files.reduce((a, f) => a + f.size, 0) || 1;
    let done = 0;
    for (const f of files) {
      if (!args.json) progressLine(`${label} ${t.files(fmtInt(files.length, lang)).padStart(16)}  ${bar(done / total)}`);
      try {
        await parsers[tool].parse(f);
      } catch {
      }
      done += f.size;
    }
    if (tool === "gemini") gemini2.flush();
    if (!args.json) {
      clearLine();
      out(`${label} ${t.files(fmtInt(files.length, lang)).padStart(16)}  ${bar(1)} ok`);
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
main().catch((e) => {
  err(danger(`aiwrapped: ${e instanceof Error ? e.message : String(e)}`));
  process.exitCode = 1;
});
