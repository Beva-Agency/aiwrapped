import fs from "node:fs";
import path from "node:path";
import type { Aggregator } from "../collect";
import { arr, eachLine, obj, projectName, safeJson, str, walk, type FoundFile } from "../files";
import { fields, first, int, packed, str as pstr, sub, timestamp, type Field } from "../proto";
import { ReadOnlyDb, sqliteAvailable } from "../sqlite";

/**
 * Google Antigravity (IDE, application 2.0 et CLI `agy`) : ~/.gemini/{antigravity,antigravity-ide,antigravity-cli}.
 *
 * - Depuis mi-2026, une conversation = une base SQLite conversations/<uuid>.db. La table gen_metadata a une ligne
 *   protobuf par appel au modèle, avec l’usage : #1 chat_model → #4 ModelUsageStats
 *   {#2 entrée hors cache, #3 sortie totale, #4 écriture cache, #5 lecture cache, #9 réflexion, #10 réponse, #11 id}.
 * - Les anciennes conversations (.pb) sont chiffrées : on n’y touche pas. Leur transcript en clair
 *   brain/<uuid>/.system_generated/logs/transcript.jsonl donne les messages et les heures, sans tokens.
 *   C’est aussi le repli quand node:sqlite manque (Node < 22.13).
 * - On ne lit jamais state.vscdb (il contient un jeton OAuth) ni les textes complets des prompts système.
 * Références : getagentseal/codeburn src/providers/antigravity.ts, mjacobs/agy-reader (descripteurs protobuf).
 */

export const ANTIGRAVITY_APPS = ["antigravity", "antigravity-ide", "antigravity-cli"];

const CANON: Record<string, string> = {
  view_file: "Read",
  read_file: "Read",
  view_file_outline: "Read",
  view_code_item: "Read",
  replace_file_content: "Edit",
  multi_replace_file_content: "Edit",
  edit_file: "Edit",
  write_to_file: "Write",
  write_file: "Write",
  create_file: "Write",
  run_command: "Bash",
  run_shell_command: "Bash",
  execute_command: "Bash",
  send_command_input: "Bash",
  grep_search: "Grep",
  search_files: "Grep",
  codebase_search: "Grep",
  find_by_name: "Glob",
  list_dir: "Glob",
  list_directory: "Glob",
  read_url_content: "WebFetch",
  search_web: "WebSearch",
  invoke_subagent: "Task",
  manage_task: "Todo",
};

function canon(name: string): string {
  if (name === "call_mcp_tool" || name.startsWith("mcp_")) return "MCP";
  return CANON[name] ?? name;
}

/**
 * L’application 2.0 n’écrit qu’un code MODEL_PLACEHOLDER_Mnn. Correspondances relevées par codeburn (app 2.19.1,
 * 2026-10-06) et Antigravity-Context-Window-Monitor (2026-10-31 à 2026-11-13). Google peut les réattribuer :
 * le site affiche alors le modèle comme estimé.
 */
const PLACEHOLDERS: Record<string, string> = {
  M16: "gemini-3.1-pro",
  M37: "gemini-3.1-pro",
  M36: "gemini-3.1-pro",
  M84: "gemini-3.5-flash",
  M18: "gemini-3-flash",
  M318: "gemini-3.8-flash",
  M319: "gemini-3.8-flash",
  M320: "gemini-3.8-flash",
  M35: "claude-sonnet-4-6",
  M26: "claude-opus-4-6",
  M417: "gemini-4-argon",
  M418: "gemini-4-argon",
  M419: "gemini-4-argon",
  M427: "gemini-4-carbon",
  M437: "gemini-4-carbon",
  M438: "gemini-4-carbon",
  M525: "gemini-4-hydrogen",
  M526: "gemini-4-hydrogen",
  M527: "gemini-4-hydrogen",
  M528: "gemini-4-hydrogen",
};

export async function findAntigravityFiles(root: string, since: number): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  for (const app of ANTIGRAVITY_APPS) {
    const base = path.join(root, app);
    const dbs = await walk(path.join(base, "conversations"), (n) => n.endsWith(".db"), 0, 0);
    const withDb = new Set(dbs.map((f) => path.basename(f.path, ".db")));
    for (const f of dbs) {
      // La base garde ses dernières écritures dans le fichier -wal, souvent plus récent.
      let mtime = f.mtime;
      try {
        mtime = Math.max(mtime, fs.statSync(`${f.path}-wal`).mtimeMs);
      } catch {
        /* pas de -wal */
      }
      if (mtime >= since) out.push({ ...f, mtime });
    }
    // Anciennes conversations chiffrées : seulement leur transcript en clair.
    const pbs = await walk(path.join(base, "conversations"), (n) => n.endsWith(".pb"), 0, 0);
    for (const pb of pbs) {
      const id = path.basename(pb.path, ".pb");
      if (withDb.has(id)) continue;
      const tr = path.join(base, "brain", id, ".system_generated", "logs", "transcript.jsonl");
      try {
        const st = fs.statSync(tr);
        if (st.isFile() && st.mtimeMs >= since) out.push({ path: tr, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* pas de transcript */
      }
    }
  }
  // La copie la plus récente d’une conversation passe en premier (migrations entre dossiers).
  return out.sort((a, b) => b.mtime - a.mtime);
}

/** Longueur du texte tapé, sans l’enveloppe <USER_REQUEST> qu’ajoute Antigravity. */
function typedLength(raw: string): number {
  const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/i.exec(raw);
  return (m ? m[1] : raw).trim().length;
}

function blob(v: unknown): Uint8Array | undefined {
  if (v instanceof Uint8Array) return v;
  if (typeof v === "string") return Buffer.from(v, "utf8");
  return undefined;
}

function fileArg(args: Record<string, unknown>): string | undefined {
  for (const k of ["AbsolutePath", "TargetFile", "file_path", "path", "AbsolutePathURI"]) {
    const v = args[k];
    if (typeof v === "string" && v) return v.replace(/^file:\/\//, "");
  }
  return undefined;
}

export class AntigravityParser {
  private seenSession = new Set<string>();
  private seenCall = new Set<string>();
  /** conversations dont les tokens n’ont pas pu être lus (Node sans node:sqlite) */
  missedTokens = 0;

  constructor(private agg: Aggregator) {}

  async parse(file: FoundFile) {
    if (file.path.endsWith(".db")) {
      const id = path.basename(file.path, ".db");
      if (this.seenSession.has(id)) return;
      this.seenSession.add(id);
      this.agg.fileScanned("antigravity");
      if (this.parseDb(file, id)) return;
      // Base illisible ou Node trop ancien : le transcript donne au moins les messages et les heures.
      if (!sqliteAvailable()) this.missedTokens += 1;
      const tr = path.join(path.dirname(path.dirname(file.path)), "brain", id, ".system_generated", "logs", "transcript.jsonl");
      if (fs.existsSync(tr)) await this.parseTranscript(tr, id);
      return;
    }
    // transcript.jsonl d’une ancienne conversation : .../brain/<uuid>/.system_generated/logs/transcript.jsonl
    const id = path.basename(path.dirname(path.dirname(path.dirname(file.path))));
    if (this.seenSession.has(id)) return;
    this.seenSession.add(id);
    this.agg.fileScanned("antigravity");
    await this.parseTranscript(file.path, id);
  }

  private parseDb(file: FoundFile, id: string): boolean {
    const db = ReadOnlyDb.open(file.path);
    if (!db) return false;
    try {
      if (!db.hasTable("gen_metadata") || !db.hasTable("steps")) return false;

      // Métadonnées de la conversation : début, dossier de travail, conversation parente (sous-agent).
      let started = NaN;
      let project: string | undefined;
      let parent: string | undefined;
      if (db.hasTable("trajectory_metadata_blob")) {
        for (const row of db.all("SELECT data FROM trajectory_metadata_blob")) {
          const meta = fields(blob(row.data));
          started = timestamp(first(meta, 2));
          parent = pstr(first(meta, 5)) || undefined;
          if (parent === id) parent = undefined;
          const uri = pstr(first(meta, 7)) ?? pstr(first(sub(meta, 1), 1));
          if (uri) project = projectName(decodeURIComponent(uri.replace(/^file:\/\/\/?/, "")));
          break;
        }
      }
      // Un sous-agent est une conversation à part : ses tokens comptent, dans la session de son parent.
      const session = parent ?? id;
      const fallbackTs = Number.isFinite(started) ? started : file.mtime;

      // Étapes : horodatage, appel d’outil, messages tapés.
      const stepTs = new Map<number, number>();
      db.each("SELECT idx, step_type, metadata FROM steps ORDER BY idx", [], (row) => {
        const meta = fields(blob(row.metadata));
        const ts = timestamp(first(meta, 1));
        const idx = Number(row.idx);
        if (Number.isFinite(ts)) {
          stepTs.set(idx, ts);
          this.agg.activity("antigravity", ts, session);
        }
        const call = sub(meta, 4);
        const name = pstr(first(call, 2));
        if (name && name !== "send_message") {
          const c = canon(name);
          let args: Record<string, unknown> = {};
          const raw = pstr(first(call, 3));
          if (raw) args = obj(safeJson(raw));
          const fileName = c === "Read" || c === "Edit" || c === "Write" ? fileArg(args) : undefined;
          this.agg.call({ tool: "antigravity", ts: Number.isFinite(ts) ? ts : fallbackTs, name: c, file: fileName, creates: c === "Write", session });
        }
      });

      if (!parent) {
        db.each("SELECT idx, metadata, step_payload FROM steps WHERE step_type = 14 ORDER BY idx", [], (row) => {
          const meta = fields(blob(row.metadata));
          // 4 = USER_EXPLICIT : ce que la personne a tapé (pas les relances système).
          const source = int(first(meta, 3));
          if (source && source !== 4) return;
          const input = sub(fields(blob(row.step_payload)), 19);
          let text = pstr(first(input, 2)) ?? "";
          if (!text) for (const item of input.filter((f) => f.n === 3)) text += pstr(first(fields(item.b), 1)) ?? "";
          const chars = typedLength(text);
          if (!chars) return;
          const ts = stepTs.get(Number(row.idx)) ?? fallbackTs;
          this.agg.prompt({ tool: "antigravity", ts, chars, session, project });
        });
      }

      // Appels au modèle.
      db.each("SELECT idx, data FROM gen_metadata ORDER BY idx", [], (row) => {
        const root = fields(blob(row.data));
        const chat = sub(root, 1);
        const usage = sub(chat, 4);
        if (!usage.length) return;
        const input = int(first(usage, 2));
        const hasTotal = first(usage, 3)?.v !== undefined;
        const total = int(first(usage, 3));
        let thinking = int(first(usage, 9));
        const response = int(first(usage, 10));
        // La sortie totale (#3) fait foi ; la répartition réflexion / réponse peut manquer ou déborder.
        if (hasTotal && thinking + response !== total) thinking = Math.min(thinking, total);
        const out = hasTotal ? total : thinking + response;
        const cw = int(first(usage, 4));
        const cr = int(first(usage, 5));
        if (input + out + cw + cr === 0) return;

        const rid = pstr(first(usage, 11));
        const key = `${id}:${rid && !/\s/.test(rid) ? rid : `#${row.idx}`}`;
        if (this.seenCall.has(key)) return;
        this.seenCall.add(key);

        const steps = packed(first(root, 2));
        let ts = timestamp(first(sub(chat, 9), 4));
        if (!Number.isFinite(ts) && steps.length) ts = stepTs.get(steps[0]) ?? NaN;
        if (!Number.isFinite(ts)) ts = fallbackTs;

        this.agg.usage({
          tool: "antigravity",
          model: modelOf(chat),
          ts,
          inp: input,
          out,
          cw5: cw,
          cw1: 0,
          cr,
          rs: thinking,
          promptSize: input + cw + cr,
          session,
          project,
        });
      });
      return true;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  private async parseTranscript(file: string, session: string) {
    await eachLine(file, (line) => {
      const j = safeJson(line);
      if (!j) return;
      const ts = Date.parse(str(j.created_at));
      if (!Number.isFinite(ts)) return;
      this.agg.activity("antigravity", ts, session);
      if (j.type === "USER_INPUT" && (j.source === "USER_EXPLICIT" || !j.source)) {
        let text = "";
        if (typeof j.content === "string") text = j.content;
        else for (const c of arr(j.content)) text += typeof c === "string" ? c : str(obj(c).text);
        const chars = typedLength(text);
        if (chars) this.agg.prompt({ tool: "antigravity", ts, chars, session });
        return;
      }
      for (const call of arr(j.tool_calls)) {
        const name = str(obj(call).name);
        if (!name || name === "send_message") continue;
        const c = canon(name);
        const fileName = c === "Read" || c === "Edit" || c === "Write" ? fileArg(obj(obj(call).args)) : undefined;
        this.agg.call({ tool: "antigravity", ts, name: c, file: fileName, creates: c === "Write", session });
      }
    });
  }
}

/** Nom du modèle : nom affiché (#21), puis identifiant (#19), puis code MODEL_PLACEHOLDER. */
function modelOf(chat: Field[]): string {
  const display = pstr(first(chat, 21));
  const response = pstr(first(chat, 19));
  let placeholder = "";
  for (const f of chat) {
    if (f.n !== 20) continue;
    const pair = fields(f.b);
    if (pstr(first(pair, 1)) === "model_enum") placeholder = pstr(first(pair, 2)) ?? "";
  }
  if (display) return display;
  const known = PLACEHOLDERS[placeholder.replace(/^MODEL_PLACEHOLDER_/, "")];
  if (known) return known;
  if (response && !/-default$/.test(response)) return response;
  return response || "antigravity";
}
