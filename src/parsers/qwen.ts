import path from "node:path";
import type { Aggregator } from "../collect";
import { arr, eachLine, num, obj, projectName, safeJson, str, walk, type FoundFile } from "../files";

/**
 * Qwen Code (fork de Gemini CLI) : ${QWEN_HOME:-~/.qwen}/projects/<dossier>/chats/<session>.jsonl (+ chats/archive).
 * - Une ligne par enregistrement ; les réponses portent usageMetadata (format Gemini) :
 *   promptTokenCount INCLUT le cache (cachedContentTokenCount) ; pas d’écriture de cache.
 * - Réflexion (thoughtsTokenCount) : déjà dans candidatesTokenCount avec les API compatibles OpenAI,
 *   à part avec l’API Gemini. On tranche avec totalTokenCount, comme tokscale.
 * - Seuls les messages « user » sans sous-type sont tapés par la personne.
 * Références : junhoyeo/tokscale sessions/qwen.rs, getagentseal/codeburn src/providers/qwen.ts.
 */

const CANON: Record<string, string> = {
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
  exit_plan_mode: "Plan",
};

export async function findQwenFiles(root: string, since: number): Promise<FoundFile[]> {
  const files = await walk(path.join(root, "projects"), (n) => n.endsWith(".jsonl"), since, 4);
  return files.filter((f) => f.path.split(/[\\/]/).includes("chats"));
}

export class QwenParser {
  private seen = new Set<string>();

  constructor(private agg: Aggregator) {}

  async parse(file: FoundFile) {
    this.agg.fileScanned("qwen");
    await eachLine(file.path, (line) => {
      const j = safeJson(line);
      if (!j) return;
      const type = str(j.type);
      if (type !== "user" && type !== "assistant") return;
      const ts = Date.parse(str(j.timestamp));
      if (!Number.isFinite(ts)) return;
      const session = str(j.sessionId) || path.basename(file.path, ".jsonl");
      // Un enregistrement peut exister dans chats/ et chats/archive/.
      const key = str(j.uuid) || `${session}:${str(j.timestamp)}:${type}`;
      if (this.seen.has(key)) return;
      this.seen.add(key);
      const project = projectName(str(j.cwd));
      const parts = arr(obj(j.message).parts).map(obj);
      if (type === "user") {
        if (j.subtype) return;
        const chars = parts.reduce((a, p) => (p.thought ? a : a + str(p.text).length), 0);
        if (chars > 0) this.agg.prompt({ tool: "qwen", ts, chars, session, project });
        return;
      }
      this.agg.activity("qwen", ts, session);
      for (const p of parts) {
        const call = obj(p.functionCall);
        const name = str(call.name);
        if (!name) continue;
        const c = CANON[name] ?? (name.includes("__") ? "MCP" : name);
        const args = obj(call.args);
        const f = c === "Read" || c === "Edit" || c === "Write" ? str(args.file_path) || str(args.absolute_path) || str(args.path) || undefined : undefined;
        this.agg.call({ tool: "qwen", ts, name: c, file: f, creates: c === "Write", session });
      }
      const u = obj(j.usageMetadata);
      const prompt = num(u.promptTokenCount);
      const cand = num(u.candidatesTokenCount);
      const thoughts = num(u.thoughtsTokenCount);
      const cr = Math.min(num(u.cachedContentTokenCount), prompt);
      if (prompt + cand + thoughts === 0) return;
      const total = typeof u.totalTokenCount === "number" ? u.totalTokenCount : undefined;
      const inCandidates = thoughts > 0 && total !== undefined && (total === 0 ? cand > 0 : total === prompt + cand);
      const out = inCandidates ? cand : cand + thoughts;
      this.agg.usage({
        tool: "qwen",
        model: str(j.model) || "qwen",
        ts,
        inp: prompt - cr,
        out,
        cw5: 0,
        cw1: 0,
        cr,
        rs: inCandidates ? Math.min(thoughts, cand) : thoughts,
        promptSize: prompt,
        session,
        project,
      });
    });
  }
}
