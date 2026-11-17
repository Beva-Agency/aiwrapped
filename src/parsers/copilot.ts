import fs from "node:fs";
import path from "node:path";
import type { Aggregator } from "../collect";
import { arr, eachLine, num, obj, projectName, safeJson, str, walk, type FoundFile } from "../files";

/**
 * GitHub Copilot CLI : ${COPILOT_HOME:-~/.copilot}/session-state/<session>/events.jsonl
 * - Versions récentes : un événement session.usage_record par appel au modèle. On ne prend que ceux-là.
 * - Anciennes versions : seulement des bilans session.shutdown, cumulés par modèle (et repris tels quels quand
 *   la session reprend) : on compte l’écart entre deux bilans successifs.
 * - inputTokens INCLUT les lectures et écritures de cache ; outputTokens inclut le raisonnement.
 * - usage.cost est un multiplicateur de requêtes premium, pas des dollars : ignoré.
 * Références : ryoppippi/ccusage rust/adapters/copilot, junhoyeo/tokscale copilot_session_state.rs.
 */

const CANON: Record<string, string> = {
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
  update_todo: "Todo",
};

function canon(name: string): string {
  const n = name.toLowerCase();
  if (CANON[n]) return CANON[n];
  if (n.includes("-") && n.includes("_")) return "MCP";
  return name;
}

export async function findCopilotFiles(root: string, since: number): Promise<FoundFile[]> {
  return walk(path.join(root, "session-state"), (n) => n === "events.jsonl", since, 2);
}

interface Usage {
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

const FIELDS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"] as const;

export class CopilotParser {
  private seen = new Set<string>();

  constructor(private agg: Aggregator) {}

  async parse(file: FoundFile) {
    this.agg.fileScanned("copilot");
    let session = path.basename(path.dirname(file.path));
    let project: string | undefined;
    // workspace.yaml à côté : « cwd: <chemin> ».
    try {
      const yaml = fs.readFileSync(path.join(path.dirname(file.path), "workspace.yaml"), "utf8");
      const m = /^cwd:\s*(.+)$/m.exec(yaml);
      if (m) project = projectName(m[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      /* pas de workspace.yaml */
    }
    let model = "";
    const records: { ts: number; u: Usage; key: string }[] = [];
    const shutdowns: { ts: number; metrics: Record<string, unknown> }[] = [];

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
          const c = canon(name);
          const args = obj(typeof req.arguments === "string" ? safeJson(req.arguments) : req.arguments);
          const f = c === "Read" || c === "Edit" || c === "Write" ? str(args.path) || str(args.file_path) || undefined : undefined;
          this.agg.call({ tool: "copilot", ts, name: c, file: f, creates: c === "Write", session });
        }
        return;
      }
      if (type === "session.usage_record") {
        const u = obj(d.usage);
        const acc = obj(u.accounting);
        // Les sessions enfants recopient les reçus : clé = session source + numéro d’ordre.
        const key = str(acc.sourceSessionId) && acc.sequence !== undefined ? `${str(acc.sourceSessionId)}:${acc.sequence}` : `${session}:${str(j.id)}`;
        records.push({ ts, u: { ...(u as Usage), model: str(u.model) || model }, key });
        return;
      }
      if (type === "session.shutdown") {
        // Un bilan avec des « watermarks » positifs a déjà été compté par des reçus.
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
    // Anciennes versions : écart entre bilans cumulés, modèle par modèle.
    const prev = new Map<string, { u: Usage; requests: number }>();
    for (const s of shutdowns) {
      for (const [m, raw] of Object.entries(s.metrics)) {
        const cur = obj(obj(raw).usage) as Usage;
        const count = num(obj(obj(raw).requests).count);
        const before = prev.get(m);
        prev.set(m, { u: cur, requests: count });
        let delta: Usage = cur;
        let requests = count;
        if (before) {
          const diff: Usage = {};
          let negative = false;
          for (const f of FIELDS) {
            const v = num(cur[f]) - num(before.u[f]);
            if (v < 0) negative = true;
            diff[f] = v;
          }
          // Compteurs remis à zéro (compaction) : le bilan vaut tel quel.
          delta = negative ? cur : diff;
          requests = negative ? count : count - before.requests;
        }
        this.emit(s.ts, { ...delta, model: m }, session, project, requests);
      }
    }
  }

  /** `requests` : nombre d’appels d’un bilan cumulé (inconnu : estimé à un appel par 150k tokens d’entrée). */
  private emit(ts: number, u: Usage, session: string, project?: string, requests?: number) {
    const cr = num(u.cacheReadTokens);
    const cw = num(u.cacheWriteTokens);
    const input = num(u.inputTokens);
    const out = num(u.outputTokens);
    const inp = Math.max(0, input - cr - cw);
    if (inp + out + cr + cw === 0) return;
    // Un reçu = un appel ; un bilan cumulé = plusieurs, dont on ne garde que la moyenne pour les paliers de prix.
    const n = requests === undefined ? 1 : Math.max(requests, Math.ceil(Math.max(input, inp + cr + cw) / 150_000), 1);
    this.agg.usage({
      tool: "copilot",
      model: (u.model || "copilot").replace(/-1m(-internal)?$/, ""),
      ts,
      inp,
      out,
      cw5: cw,
      cw1: 0,
      cr,
      rs: num(u.reasoningTokens),
      promptSize: Math.max(input, inp + cr + cw) / n,
      requests: n,
      session,
      project,
    });
  }
}
