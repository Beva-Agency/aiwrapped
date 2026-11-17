import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Aggregator } from "../collect";
import { num, obj, projectName, safeJson, str, type FoundFile } from "../files";
import { appData } from "../paths";

/**
 * Cline (extension VS Code saoudrizwan.claude-dev, et son CLI) :
 * <éditeur>/User/globalStorage/saoudrizwan.claude-dev/tasks/<tâche>/ui_messages.json, ~/.cline/data/tasks/<tâche>/…
 * - Fichier JSON réécrit en entier ; l’usage est dans les entrées say: "api_req_started" dont le texte est du JSON :
 *   {tokensIn, tokensOut, cacheWrites, cacheReads, cost}. Chez Cline, les quatre compteurs sont disjoints.
 * - Pas de champ de raisonnement (inclus dans tokensOut).
 * - Messages tapés : la tâche (say: "task") et les relances (say: "user_feedback").
 * Références : junhoyeo/tokscale sessions/roocode.rs et cline.rs, getagentseal/codeburn vscode-cline-parser.ts.
 */

const EXT = "saoudrizwan.claude-dev";
const EDITORS = ["Code", "Code - Insiders", "VSCodium", "Cursor", "Windsurf"];

const TOOLS: Record<string, string> = {
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
  newTask: "Task",
};

/** Dossiers de tâches de l’extension dans chaque éditeur, puis celui du CLI. */
export function clineTaskDirs(dir?: string): string[] {
  if (dir) return [path.join(dir, "tasks")];
  return [
    ...EDITORS.map((e) => path.join(appData(e), "User", "globalStorage", EXT, "tasks")),
    path.join(os.homedir(), ".vscode-server", "data", "User", "globalStorage", EXT, "tasks"),
    path.join(os.homedir(), ".cline", "data", "tasks"),
  ];
}

export async function findClineFiles(dirs: string[], since: number): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  for (const tasks of dirs) {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(tasks);
    } catch {
      continue;
    }
    for (const id of ids) {
      const p = path.join(tasks, id, "ui_messages.json");
      try {
        const st = fs.statSync(p);
        if (st.isFile() && st.mtimeMs >= since) out.push({ path: p, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* tâche sans messages */
      }
    }
  }
  return out;
}

/** Début de api_conversation_history.json : modèle (<model>) et dossier de travail des anciennes tâches. */
function historyHead(dir: string): string {
  try {
    const fd = fs.openSync(path.join(dir, "api_conversation_history.json"), "r");
    try {
      const buf = Buffer.alloc(256 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

export class ClineParser {
  private seenTask = new Set<string>();

  constructor(private agg: Aggregator) {}

  async parse(file: FoundFile) {
    const dir = path.dirname(file.path);
    const task = path.basename(dir);
    // Même tâche copiée dans deux éditeurs : une seule fois.
    if (this.seenTask.has(task)) return;
    this.seenTask.add(task);
    this.agg.fileScanned("cline");
    let msgs: unknown;
    try {
      msgs = JSON.parse(await fs.promises.readFile(file.path, "utf8"));
    } catch {
      return;
    }
    if (!Array.isArray(msgs)) return;
    const head = historyHead(dir);
    const fallbackModel = /<model>([^<]{1,80})<\/model>/.exec(head)?.[1]?.trim() ?? "";
    const cwd = /Current Workspace Directory \(([^)]+)\)/.exec(head)?.[1];
    const project = cwd ? projectName(cwd.replace(/\\\\/g, "\\")) : undefined;
    const session = task;
    let first = true;
    for (const raw of msgs) {
      const m = obj(raw);
      const ts = num(m.ts);
      if (!ts) continue;
      this.agg.activity("cline", ts, session);
      if (m.partial === true) continue;
      const say = str(m.say);
      const ask = str(m.ask);
      if (m.type === "say" && (say === "task" || say === "user_feedback" || say === "user_feedback_diff" || (first && say === "text"))) {
        const chars = str(m.text).trim().length;
        if (chars > 0) this.agg.prompt({ tool: "cline", ts, chars, session, project });
      }
      first = false;
      if (m.type === "ask" && ask === "tool") {
        const t = obj(safeJson(str(m.text)));
        const name = TOOLS[str(t.tool)] ?? (str(t.tool) || "Tool");
        const f = name === "Read" || name === "Edit" || name === "Write" ? str(t.path) || undefined : undefined;
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
      const out = num(j.tokensOut);
      const cr = num(j.cacheReads);
      const cw = num(j.cacheWrites);
      if (inp + out + cr + cw === 0) continue;
      this.agg.usage({
        tool: "cline",
        model: str(obj(m.modelInfo).modelId) || fallbackModel || "unknown",
        ts,
        inp,
        out,
        cw5: cw,
        cw1: 0,
        cr,
        rs: 0,
        promptSize: inp + cr + cw,
        session,
        project,
      });
    }
  }
}
