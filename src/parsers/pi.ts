import path from "node:path";
import type { Aggregator } from "../collect";
import { arr, eachLine, num, obj, projectName, safeJson, str, walk, type FoundFile } from "../files";

/**
 * Pi (earendil-works/pi) : ${PI_CODING_AGENT_DIR:-~/.pi/agent}/sessions/--<dossier>--/<date>_<session>.jsonl
 * - Une ligne par entrée ; les réponses de l’assistant portent message.usage :
 *   input = hors cache, output = raisonnement COMPRIS (reasoning n’en est qu’une partie), cacheRead, cacheWrite.
 * - Une session dérivée (parentSession) peut recopier l’historique du parent : dédoublonnage par responseId.
 * - Les fichiers sous subagent-artifacts/ sont des copies de débogage : ignorés.
 * Références : ryoppippi/ccusage rust/adapters/pi, getagentseal/codeburn src/providers/pi.ts.
 */

const CANON: Record<string, string> = {
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
  task: "Task",
};

export async function findPiFiles(root: string, since: number): Promise<FoundFile[]> {
  const files = await walk(path.join(root, "sessions"), (n) => n.endsWith(".jsonl"), since, 3);
  return files.filter((f) => !f.path.split(/[\\/]/).includes("subagent-artifacts"));
}

function textLength(content: unknown): number {
  if (typeof content === "string") return content.length;
  return arr(content).reduce<number>((a, c) => (obj(c).type === "text" ? a + str(obj(c).text).length : a), 0);
}

export class PiParser {
  private seen = new Set<string>();

  constructor(private agg: Aggregator) {}

  async parse(file: FoundFile) {
    this.agg.fileScanned("pi");
    let session = path.basename(file.path, ".jsonl").replace(/^.*_/, "");
    let project: string | undefined;
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
      // Une session dérivée recopie les réponses du parent avec le même responseId.
      const key = str(m.responseId) || id;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      for (const c of arr(m.content)) {
        const b = obj(c);
        if (b.type !== "toolCall") continue;
        const name = str(b.name);
        const canonical = CANON[name.toLowerCase()] ?? (name.includes("_") ? "MCP" : name);
        const args = obj(b.arguments);
        const f = canonical === "Read" || canonical === "Edit" || canonical === "Write" ? str(args.path) || str(args.file_path) || undefined : undefined;
        this.agg.call({ tool: "pi", ts, name: canonical, file: f, creates: canonical === "Write", session });
      }
      const u = obj(m.usage);
      const inp = num(u.input);
      const out = num(u.output);
      const cr = num(u.cacheRead);
      const cw = num(u.cacheWrite);
      if (inp + out + cr + cw === 0) return;
      const cw1 = Math.min(num(u.cacheWrite1h), cw);
      this.agg.usage({
        tool: "pi",
        model: str(m.model) || model || "unknown",
        ts,
        inp,
        out,
        cw5: cw - cw1,
        cw1,
        cr,
        rs: Math.min(num(u.reasoning), out),
        promptSize: inp + cr + cw,
        session,
        project,
      });
    });
  }
}
