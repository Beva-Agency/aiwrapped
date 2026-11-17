import fs from "node:fs";
import path from "node:path";
import type { Aggregator } from "../collect";
import { num, obj, projectName, safeJson, str, walk, type FoundFile } from "../files";
import { ReadOnlyDb, text } from "../sqlite";

/**
 * OpenCode : ${XDG_DATA_HOME:-~/.local/share}/opencode (même chemin sous Windows).
 * - Depuis la v1.2, tout est dans opencode.db : tables session, message(data JSON), part(data JSON).
 *   La v2 (préversion) écrit session_message(type, seq, data) ; les deux sont lues.
 * - Les fichiers JSON d’avant la migration (storage/message, storage/part) restent sur le disque :
 *   on déduplique par identifiant de message.
 * - Jetons : input = hors cache, output = SANS le raisonnement (champ reasoning à part), cache.read, cache.write.
 * - Le fournisseur « claude-agent » fait tourner Claude Code, déjà compté par ses propres logs : ignoré.
 * Références : getagentseal/codeburn src/providers/opencode.ts, ryoppippi/ccusage rust/adapters/opencode.
 */

const CANON: Record<string, string> = {
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
  plan_exit: "Plan",
};

function canon(name: string): string {
  const n = name.toLowerCase();
  if (CANON[n]) return CANON[n];
  // Outils MCP : « serveur_outil ».
  if (n.includes("_") && !["todo_write", "web_fetch", "web_search"].includes(n)) return "MCP";
  return name;
}

function fileOf(input: string): string | undefined {
  const m = /"(?:filePath|file_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(input);
  return m ? m[1].replace(/\\\\/g, "\\") : undefined;
}

export async function findOpencodeFiles(root: string, since: number): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  // Bases : opencode.db, puis les canaux (opencode-beta.db…) ; opencode-next.db est importée dans opencode.db.
  let names: string[] = [];
  try {
    names = fs.readdirSync(root).filter((n) => /^opencode(-[A-Za-z0-9_-]+)?\.db$/.test(n));
  } catch {
    /* dossier absent */
  }
  if (names.includes("opencode.db")) names = names.filter((n) => n !== "opencode-next.db");
  for (const n of names.sort()) {
    const p = path.join(root, n);
    try {
      const st = fs.statSync(p);
      let mtime = st.mtimeMs;
      try {
        mtime = Math.max(mtime, fs.statSync(`${p}-wal`).mtimeMs);
      } catch {
        /* pas de -wal */
      }
      if (mtime >= since) out.push({ path: p, size: st.size, mtime });
    } catch {
      /* disparu */
    }
  }
  // Anciens fichiers, lus après les bases (déduplication par identifiant).
  out.push(...(await walk(path.join(root, "storage", "message"), (n) => n.endsWith(".json"), since, 2)));
  return out;
}

interface Tokens {
  input?: number;
  output?: number;
  reasoning?: number;
  cache?: { read?: number; write?: number };
}

export class OpencodeParser {
  private seen = new Set<string>();
  private seenTool = new Set<string>();
  private projects = new Map<string, string | undefined>();

  constructor(
    private agg: Aggregator,
    private tool: "opencode" = "opencode",
  ) {}

  async parse(file: FoundFile) {
    if (file.path.endsWith(".db")) {
      this.agg.fileScanned(this.tool);
      this.parseDb(file.path);
      return;
    }
    this.parseLegacy(file);
  }

  private usage(o: {
    id: string;
    session: string;
    ts: number;
    model: string;
    provider: string;
    t: Tokens;
    project?: string;
  }) {
    if (o.provider === "claude-agent") return;
    const inp = num(o.t.input);
    const rs = num(o.t.reasoning);
    const out = num(o.t.output) + rs;
    const cr = num(o.t.cache?.read);
    const cw = num(o.t.cache?.write);
    if (inp + out + cr + cw === 0) return;
    this.agg.usage({
      tool: this.tool,
      model: o.model || o.provider || "unknown",
      ts: o.ts,
      inp,
      out,
      cw5: cw,
      cw1: 0,
      cr,
      rs,
      promptSize: inp + cr + cw,
      session: o.session,
      project: o.project,
    });
  }

  private call(name: string, callId: string, input: string, ts: number, session: string) {
    if (!name) return;
    if (callId) {
      if (this.seenTool.has(callId)) return;
      this.seenTool.add(callId);
    }
    const c = canon(name);
    const file = c === "Read" || c === "Edit" || c === "Write" ? fileOf(input) : undefined;
    this.agg.call({ tool: this.tool, ts, name: c, file, creates: c === "Write", session });
    this.agg.activity(this.tool, ts, session);
  }

  private parseDb(file: string) {
    const db = ReadOnlyDb.open(file);
    if (!db) return;
    try {
      if (db.hasTable("session_message")) this.v2(db);
      if (db.hasTable("message") && db.hasTable("part")) this.v1(db);
    } catch {
      /* base verrouillée ou schéma inattendu : on garde ce qui a été lu */
    } finally {
      db.close();
    }
  }

  /** v1 : message(id, session_id, time_created, data) + part(message_id, data). */
  private v1(db: ReadOnlyDb) {
    const dirs = new Map<string, string | undefined>();
    if (db.hasTable("session")) {
      db.each("SELECT id, CAST(directory AS BLOB) AS dir FROM session", [], (r) => dirs.set(String(r.id), projectName(text(r.dir))));
    }
    const roles = new Map<string, { role: string; session: string; ts: number; project?: string }>();
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
        this.usage({ id, session, ts, model: str(d.modelID), provider: str(d.providerID), t: d.tokens as Tokens, project });
      }
    });
    // Parties : texte des messages de l’utilisateur (longueur seulement) et appels d’outils.
    const typed = new Map<string, number>();
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
      },
    );
    for (const [mid, chars] of typed) {
      const m = roles.get(mid);
      if (!m || !chars || this.seen.has(`prompt:${mid}`)) continue;
      this.seen.add(`prompt:${mid}`);
      this.agg.prompt({ tool: this.tool, ts: m.ts, chars, session: m.session, project: m.project });
    }
  }

  /** v2 : session_message(type, seq, data), avec copies des messages du parent dans les sessions dérivées. */
  private v2(db: ReadOnlyDb) {
    const table = db.hasTable("session_v2") ? "session_v2" : db.hasTable("session") ? "session" : "";
    const dirs = new Map<string, string | undefined>();
    const cutoff = new Map<string, number>();
    if (table) {
      // Colonnes choisies une à une : un titre en UTF-8 invalide ferait planter node:sqlite.
      const cols = db.columns(table);
      const pick = (c: string) => (cols.has(c) ? `CAST(${c} AS BLOB) AS ${c}` : `NULL AS ${c}`);
      db.each(`SELECT id, ${pick("directory")}, ${pick("fork_session_id")}, ${pick("fork_boundary")} FROM ${table}`, [], (r) => {
        const id = String(r.id);
        dirs.set(id, projectName(text(r.directory)));
        // Session dérivée : ses premiers messages recopient ceux du parent jusqu’à fork_boundary.
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
    const copied = (session: string, seq: number) => cutoff.has(session) && seq <= (cutoff.get(session) ?? -1);

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
        const t = obj(safeJson(text(r.tokens))) as Tokens;
        this.usage({ id, session, ts, model: text(r.model), provider: text(r.provider), t, project });
      },
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
      },
    );
  }

  /** Ancien format : storage/message/<session>/<message>.json, texte dans storage/part/<message>/*.json. */
  private parseLegacy(file: FoundFile) {
    let d: Record<string, unknown>;
    try {
      d = obj(safeJson(fs.readFileSync(file.path, "utf8")));
    } catch {
      return;
    }
    const id = str(d.id) || path.basename(file.path, ".json");
    if (this.seen.has(id)) return;
    this.seen.add(id);
    this.agg.fileScanned(this.tool);
    const session = str(d.sessionID) || path.basename(path.dirname(file.path));
    const ts = num(obj(d.time).created);
    if (!ts) return;
    const p = obj(d.path);
    const project = projectName(str(p.cwd) || str(p.root));
    this.agg.activity(this.tool, ts, session);
    if (str(d.role) === "assistant") {
      if (d.tokens) this.usage({ id, session, ts, model: str(d.modelID), provider: str(d.providerID), t: d.tokens as Tokens, project });
    }
    // Parties du message : storage/part/<message>/*.json
    const partsDir = path.join(path.dirname(path.dirname(path.dirname(file.path))), "part", id);
    let parts: string[] = [];
    try {
      parts = fs.readdirSync(partsDir).filter((n) => n.endsWith(".json"));
    } catch {
      return;
    }
    let chars = 0;
    for (const n of parts) {
      let part: Record<string, unknown>;
      try {
        part = obj(safeJson(fs.readFileSync(path.join(partsDir, n), "utf8")));
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
}

