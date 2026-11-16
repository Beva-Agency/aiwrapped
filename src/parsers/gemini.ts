import fs from "node:fs";
import path from "node:path";
import type { Aggregator } from "../collect";
import { arr, eachLine, num, obj, safeJson, str, walk, type FoundFile } from "../files";

/**
 * Gemini CLI : ~/.gemini/tmp/<projet>/chats/session-*.json (ancien) ou session-*.jsonl (depuis 0.39),
 * sous-agents dans chats/<session>/<id>.jsonl.
 * - Un message est réécrit à chaque ajout de tokens ou d'appels d'outils : on garde la dernière version par id.
 * - tokens.input inclut la partie en cache ; tokens.output exclut la réflexion (thoughts).
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
  grep: "Grep",
  web_fetch: "WebFetch",
  google_web_search: "WebSearch",
  save_memory: "Memory",
};

export async function findGeminiFiles(root: string, since: number): Promise<FoundFile[]> {
  return walk(path.join(root, "tmp"), (n) => /\.(json|jsonl)$/.test(n) && (n.startsWith("session-") || /^[0-9a-f-]{20,}\.jsonl$/.test(n)), since, 5);
}

interface Msg {
  id: string;
  type?: string;
  timestamp?: string;
  content?: unknown;
  tokens?: Record<string, unknown>;
  model?: string;
  toolCalls?: unknown[];
}

function projectFromPath(file: string): string | undefined {
  // .../tmp/<projet>/chats/...
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf("chats");
  const dir = i > 0 ? parts[i - 1] : "";
  if (!dir || /^[0-9a-f]{40,}$/.test(dir)) return undefined;
  return dir;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return arr(content)
    .map((c) => str(obj(c).text))
    .join("");
}

export class GeminiParser {
  private messages = new Map<string, Msg & { session: string; project?: string }>();

  constructor(private agg: Aggregator) {}

  async parse(file: FoundFile) {
    this.agg.fileScanned("gemini");
    const project = projectFromPath(file.path);
    let session = path.basename(file.path).replace(/\.(json|jsonl)$/, "");
    const put = (m: Msg) => {
      if (!m.id) return;
      const prev = this.messages.get(m.id);
      this.messages.set(m.id, { ...(prev ?? {}), ...m, session, project });
    };

    if (file.path.endsWith(".json")) {
      let data: Record<string, unknown> | null = null;
      try {
        data = safeJson(await fs.promises.readFile(file.path, "utf8"));
      } catch {
        return;
      }
      if (!data) return;
      session = str(data.sessionId) || session;
      for (const m of arr(data.messages)) put(obj(m) as unknown as Msg);
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
        put({ ...(patch as unknown as Msg), ...(updates as unknown as Msg), id: str(patch.id) });
        return;
      }
      if (typeof j.id === "string") put(j as unknown as Msg);
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
        project: m.project,
      });
      for (const call of arr(m.toolCalls)) {
        const c = obj(call);
        const raw = str(c.name);
        const name = CANON[raw] ?? (raw.includes("__") ? "MCP" : raw || "Other");
        const args = obj(c.args);
        const file = str(args.file_path) || str(args.absolute_path) || str(args.path) || undefined;
        this.agg.call({ tool: "gemini", ts, name, file: name === "Read" || name === "Edit" || name === "Write" ? file : undefined, creates: name === "Write", session: m.session });
      }
    }
    this.messages.clear();
  }
}
