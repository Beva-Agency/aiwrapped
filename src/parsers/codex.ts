import path from "node:path";
import type { Aggregator } from "../collect";
import { arr, eachLine, num, obj, projectName, safeJson, str, walk, type FoundFile } from "../files";

/**
 * Codex CLI : ~/.codex/sessions/AAAA/MM/JJ/rollout-*.jsonl (+ ~/.codex/archived_sessions).
 * Deux générations de format :
 * - récent : `token_usage_record` (usage par response_id) et `event_msg/item_completed` (UserMessage,
 *   CommandExecution, FileChange) ;
 * - ancien : `event_msg/token_count` (usage cumulé + dernier appel), `event_msg/user_message`,
 *   `response_item/function_call` (shell, apply_patch, update_plan…).
 * input_tokens inclut les lectures et écritures de cache ; output_tokens inclut le raisonnement.
 */

export async function findCodexFiles(root: string, since: number): Promise<FoundFile[]> {
  const a = await walk(path.join(root, "sessions"), (n) => n.endsWith(".jsonl"), since);
  const b = await walk(path.join(root, "archived_sessions"), (n) => n.endsWith(".jsonl"), since, 1);
  const seen = new Set<string>();
  return [...a, ...b].filter((f) => {
    const k = path.basename(f.path);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

interface Usage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

function patchFiles(patch: string): { file: string; creates: boolean }[] {
  const out: { file: string; creates: boolean }[] = [];
  for (const m of patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    if (m[1] !== "Delete") out.push({ file: m[2].trim(), creates: m[1] === "Add" });
  }
  return out;
}

export class CodexParser {
  private seenResponse = new Set<string>();

  constructor(private agg: Aggregator) {}

  async parse(file: FoundFile) {
    this.agg.fileScanned("codex");
    let session = path.basename(file.path, ".jsonl");
    let project: string | undefined;
    let model = "gpt-5-codex";
    let hasRecords = false;
    let lastTotal = -1;
    const pendingCounts: { ts: number; usage: Usage; model: string }[] = [];
    const userMsgs: { ts: number; chars: number }[] = [];
    const itemUserMsgs: { ts: number; chars: number }[] = [];

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
        this.usage(ts, obj(p.usage) as Usage, model, session, project);
        return;
      }
      if (type === "event_msg") {
        const t = str(p.type);
        if (t === "token_count") {
          const info = obj(p.info);
          const total = num(obj(info.total_token_usage).total_tokens);
          const last = obj(info.last_token_usage) as Usage;
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

    // Ancien format : pas de token_usage_record, on prend le dernier appel de chaque token_count.
    if (!hasRecords) for (const c of pendingCounts) this.usage(c.ts, c.usage, c.model, session, project);
    // Messages tapés par l'utilisateur : un seul des deux formats est présent par fichier.
    for (const m of userMsgs.length ? userMsgs : itemUserMsgs) {
      this.agg.prompt({ tool: "codex", ts: m.ts, chars: m.chars, session, project });
    }
  }

  private usage(ts: number, u: Usage, model: string, session: string, project?: string) {
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
      project,
    });
  }

  private item(ts: number, item: Record<string, unknown>, session: string, userMsgs: { ts: number; chars: number }[]) {
    const t = str(item.type);
    if (t === "UserMessage") {
      const text = arr(item.content)
        .map((c) => str(obj(c).text))
        .join("");
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

  private legacyCall(ts: number, p: Record<string, unknown>, session: string) {
    const name = str(p.name);
    if (name === "exec") return; // nouveau format : compté via CommandExecution
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
}
