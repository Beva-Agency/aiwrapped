/**
 * Agrégation : les parseurs envoient des événements normalisés, on en tire le payload v1.
 * Seuls des totaux sortent d'ici : jamais un prompt, un chemin complet ou une ligne de code.
 */

export type ToolId = "claude" | "codex" | "gemini";

export interface UsageEvent {
  tool: ToolId;
  model: string;
  ts: number;
  /** entrée hors cache */
  inp: number;
  /** sortie facturée, raisonnement compris */
  out: number;
  cw5: number;
  cw1: number;
  cr: number;
  /** dont raisonnement (information) */
  rs: number;
  /** taille du prompt de la requête, cache compris (pour les paliers de prix) */
  promptSize: number;
  fast?: boolean;
  session: string;
  project?: string;
}

export interface PromptEvent {
  tool: ToolId;
  ts: number;
  chars: number;
  session: string;
  project?: string;
}

export interface CallEvent {
  tool: ToolId;
  ts: number;
  name: string;
  /** chemin du fichier concerné (gardé en mémoire uniquement, pour compter les fichiers distincts) */
  file?: string;
  /** l'appel crée un fichier */
  creates?: boolean;
  session: string;
}

export interface Range {
  start: number;
  end: number;
}

const DAY = 86_400_000;
const IDLE_GAP = 15 * 60_000;

export function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function bucketOf(promptSize: number): number {
  if (promptSize > 272_000) return 3;
  if (promptSize > 200_000) return 2;
  if (promptSize > 100_000) return 1;
  return 0;
}

interface SessionAcc {
  times: number[];
  prompts: number;
}

export class Aggregator {
  private models = new Map<string, { t: ToolId; m: string; b: number; f: boolean; u: number[]; n: number }>();
  private daily = new Map<string, [number, number]>();
  private hours = new Array<number>(24).fill(0);
  private week = new Array<number>(168).fill(0);
  private sessions = new Map<string, SessionAcc>();
  private projects = new Map<string, [number, number]>();
  private calls = new Map<string, number>();
  private filesRead = new Set<string>();
  private filesEdited = new Set<string>();
  private filesCreated = new Set<string>();
  private toolStats: Record<ToolId, { files: number; sessions: Set<string>; prompts: number; first: number }> = {
    claude: { files: 0, sessions: new Set(), prompts: 0, first: Infinity },
    codex: { files: 0, sessions: new Set(), prompts: 0, first: Infinity },
    gemini: { files: 0, sessions: new Set(), prompts: 0, first: Infinity },
  };
  private promptCount = 0;
  private promptChars = 0;
  private longestPrompt = 0;
  private plan = 0;
  private subagents = 0;
  private web = 0;
  private linesAdded = new Map<string, number>();
  private linesRemoved = new Map<string, number>();
  private minTs = Infinity;
  private maxTs = -Infinity;

  constructor(private range: Range) {}

  inRange(ts: number): boolean {
    return Number.isFinite(ts) && ts >= this.range.start && ts <= this.range.end;
  }

  fileScanned(tool: ToolId) {
    this.toolStats[tool].files += 1;
  }

  private touch(tool: ToolId, ts: number, session: string) {
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

  usage(e: UsageEvent) {
    if (!this.inRange(e.ts)) return;
    const vals = [e.inp, e.out, e.cw5, e.cw1, e.cr, e.rs].map((v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0));
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

  prompt(e: PromptEvent) {
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

  call(e: CallEvent) {
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
  lines(session: string, added: number, removed: number) {
    if (added > (this.linesAdded.get(session) ?? 0)) this.linesAdded.set(session, added);
    if (removed > (this.linesRemoved.get(session) ?? 0)) this.linesRemoved.set(session, removed);
  }

  hasActivity(): boolean {
    return this.models.size > 0 || this.promptCount > 0;
  }

  firstDay(tool: ToolId): string | undefined {
    const f = this.toolStats[tool].first;
    return Number.isFinite(f) ? localDay(f) : undefined;
  }

  build(opts: { id: string; noStats: boolean; cli: string; lang: string; scope: "year" | "since" | "all"; year?: number; hideProjects: boolean; tools: ToolId[] }) {
    const from = localDay(this.minTs);
    const to = localDay(this.maxTs);
    const fromDate = new Date(`${from}T00:00:00`);

    // Sessions : temps actif (pauses de plus de 15 min exclues).
    const durations: number[] = [];
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
      const m = active / 60_000;
      minutes += m;
      if (s.prompts > 0 || s.times.length > 1) {
        sessionCount += 1;
        durations.push(m);
        if (m >= 120) longSessions += 1;
      }
    }
    durations.sort((a, b) => a - b);
    const medianSession = durations.length ? durations[Math.floor(durations.length / 2)] : 0;

    const daily: [number, number, number][] = [];
    for (const [day, [prompts, tokens]] of this.daily) {
      const idx = Math.round((new Date(`${day}T00:00:00`).getTime() - fromDate.getTime()) / DAY);
      if (idx >= 0) daily.push([idx, prompts, Math.round(tokens / 1000)]);
    }
    daily.sort((a, b) => a[0] - b[0]);

    const projects = [...this.projects.entries()]
      .filter(([, [tokens]]) => tokens > 0)
      .sort((a, b) => b[1][0] - a[1][0])
      .slice(0, 4)
      .map(([name, [tokens, prompts]], i) => [opts.hideProjects ? `projet-${i + 1}` : name.slice(0, 60), tokens, prompts] as [string, number, number]);

    const calls = [...this.calls.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([name, n]) => [name.slice(0, 40), n] as [string, number]);

    const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);

    const tools: Record<string, { files: number; sessions: number; prompts: number; minutes: number; first?: string }> = {};
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
        minutes: Math.round(tm / 60_000),
        ...(this.firstDay(t) ? { first: this.firstDay(t) } : {}),
      };
    }

    return {
      v: 1 as const,
      id: opts.id,
      ...(opts.noStats ? { ns: true } : {}),
      cli: opts.cli,
      gen: new Date().toISOString(),
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      lang: opts.lang,
      from,
      to,
      scope: opts.scope,
      ...(opts.year ? { year: opts.year } : {}),
      tools,
      models: [...this.models.values()]
        .sort((a, b) => b.u.reduce((x, y) => x + y, 0) - a.u.reduce((x, y) => x + y, 0))
        .slice(0, 300)
        .map((r) => ({ t: r.t, m: r.m, b: r.b, ...(r.f ? { f: true } : {}), u: r.u, n: r.n })),
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
      ...(this.linesAdded.size ? { lines: { added: sum(this.linesAdded), removed: sum(this.linesRemoved) } } : {}),
      projects,
    };
  }
}

export type Payload = ReturnType<Aggregator["build"]>;
