import path from "node:path";
import type { Aggregator } from "../collect";
import { arr, eachLine, num, obj, projectName, safeJson, str, walk, type FoundFile } from "../files";

/**
 * Claude Code : ~/.claude/projects/<projet>/<session>.jsonl (+ sous-agents dans des sous-dossiers).
 * - L'usage est porté par les lignes « assistant » ; une même réponse est écrite sur plusieurs lignes
 *   (un bloc de contenu par ligne) : on déduplique l'usage par message.id + requestId.
 * - Les sessions reprises recopient l'historique : on déduplique les prompts par uuid et les outils par id de bloc.
 */

const CANON: Record<string, string> = {
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
  TodoWrite: "Todo",
};

function canon(name: string): string {
  if (name.startsWith("mcp__")) return "MCP";
  return CANON[name] ?? name;
}

const NOT_A_PROMPT = /^\s*(<command-name>|<command-message>|<local-command-std|<local-command-caveat>|Caveat:|\[Request interrupted|<system-reminder>|<bash-input>|<bash-stdout>|<task-notification>)/;

export async function findClaudeFiles(root: string, since: number): Promise<FoundFile[]> {
  return walk(path.join(root, "projects"), (n) => n.endsWith(".jsonl"), since);
}

export class ClaudeParser {
  private seenUsage = new Set<string>();
  private seenPrompt = new Set<string>();
  private seenTool = new Set<string>();

  constructor(private agg: Aggregator) {}

  async parse(file: FoundFile) {
    this.agg.fileScanned("claude");
    await eachLine(file.path, (line) => {
      // Filtre rapide avant JSON.parse : les fichiers peuvent peser des Go.
      const isAssistant = line.includes('"type":"assistant"');
      const isUser = !isAssistant && line.includes('"type":"user"') && !line.includes('"tool_use_id"');
      const isCost = !isAssistant && !isUser && line.includes('"type":"cost-state"');
      if (!isAssistant && !isUser && !isCost) return;
      const j = safeJson(line);
      if (!j) return;
      // Le filtre texte peut se tromper (un prompt qui cite un log) : on se fie au vrai type.
      if (j.type === "assistant") this.assistant(j);
      else if (j.type === "user") this.user(j);
      else if (j.type === "cost-state") this.cost(j);
    });
  }

  private assistant(j: Record<string, unknown>) {
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
        project,
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
      const file = str(input.file_path) || str(input.notebook_path) || undefined;
      this.agg.call({ tool: "claude", ts, name, file, creates: name === "Write", session });
    }
  }

  private user(j: Record<string, unknown>) {
    if (j.isMeta === true || j.isSidechain === true) return;
    // Versions récentes : origin.kind distingue ce que tu tapes des notifications injectées.
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
    // Longueur de ce que tu as écrit, sans les blocs collés.
    const typed = text.replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, "").trim();
    const chars = Math.max(1, typed.length || Math.min(text.length, 2000));
    this.agg.prompt({ tool: "claude", ts, chars, session: str(j.sessionId) || "?", project: projectName(str(j.cwd)) });
  }

  private cost(j: Record<string, unknown>) {
    const session = str(j.sessionId);
    if (!session) return;
    const start = num(j.startTime);
    if (start && !this.agg.inRange(start)) return;
    this.agg.lines(session, num(j.totalLinesAdded), num(j.totalLinesRemoved));
  }
}
