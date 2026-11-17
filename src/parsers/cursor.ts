import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Aggregator } from "../collect";
import { arr, eachLine, obj, projectName, safeJson, str, walk, type FoundFile } from "../files";
import { ReadOnlyDb, text } from "../sqlite";

/**
 * Cursor : l’IDE (base SQLite state.vscdb), le CLI cursor-agent (~/.cursor/projects/<projet>/agent-transcripts)
 * et, en option, l’export CSV du tableau de bord (--cursor-csv).
 *
 * - Depuis début 2026, Cursor n’enregistre plus les tokens en local (tokenCount reste à 0, usageData vide).
 *   La base donne les sessions, les messages tapés, les heures et les outils ; les tokens exacts ne viennent
 *   que de l’export CSV, que la personne télécharge elle-même sur cursor.com/dashboard.
 * - Une session = composerData:<id>. Ses messages = bubbleId:<id>:<bulle>, mais seulement ceux listés dans
 *   ses en-têtes (fullConversationHeadersOnly, ou composerConvHeaders:<id>:NNNNNN depuis _v 18) : Cursor stocke
 *   des copies des bulles quand l’agent se relance, et les compter gonflerait tout.
 * - La base peut peser des dizaines de Go : requêtes par plage de clés, aucun texte lu (seulement des longueurs),
 *   jamais la clé cursorAuth/accessToken.
 * - node:sqlite s’arrête net sur un TEXT en UTF-8 invalide : toute valeur texte remonte en BLOB.
 * Références : getagentseal/codeburn src/providers/cursor.ts et cursor-agent.ts, kenn-io/agentsview cursor_ide.go.
 */

const CANON: Record<string, string> = {
  run_terminal_cmd: "Bash",
  run_terminal_command: "Bash",
  run_terminal_command_v2: "Bash",
  shell: "Bash",
  read_file: "Read",
  read_file_v2: "Read",
  readfile: "Read",
  read: "Read",
  edit_file: "Edit",
  edit_file_v2: "Edit",
  search_replace: "Edit",
  apply_patch: "Edit",
  strreplace: "Edit",
  editfile: "Edit",
  edit: "Edit",
  multiedit: "Edit",
  multi_edit: "Edit",
  write_file: "Write",
  write_file_v2: "Write",
  writefile: "Write",
  write: "Write",
  grep: "Grep",
  grep_search: "Grep",
  ripgrep: "Grep",
  ripgrep_raw_search: "Grep",
  rg: "Grep",
  codebase_search: "Grep",
  semantic_search_full: "Grep",
  glob_file_search: "Glob",
  file_search: "Glob",
  list_dir: "Glob",
  list_dir_v2: "Glob",
  ls: "Glob",
  glob: "Glob",
  web_search: "WebSearch",
  web_fetch: "WebFetch",
  webfetch: "WebFetch",
  task: "Task",
  task_v2: "Task",
  subagent: "Task",
  todo_write: "Todo",
  create_plan: "Plan",
};

function canon(name: string): string {
  const n = name.toLowerCase();
  if (n.startsWith("mcp_") || n.startsWith("mcp-") || n.startsWith("mcp__")) return "MCP";
  return CANON[n] ?? name;
}

/** Chemin de fichier dans les arguments JSON d’un outil (souvent tronqués : on cherche, on ne parse pas). */
function fileFromArgs(raw: string): string | undefined {
  const m = /"(?:target_file|targetFile|file_path|filePath|relativeWorkspacePath|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  return m ? m[1].replace(/\\\\/g, "\\") : undefined;
}

/** createdAt en ISO ou en millisecondes. */
function when(v: unknown): number {
  if (typeof v === "number") return v > 1e12 ? v : v > 1e9 ? v * 1000 : NaN;
  const s = text(v);
  if (!s) return NaN;
  if (/^\d{10,13}$/.test(s)) return when(Number(s));
  return Date.parse(s);
}

/** Dossier ~/.cursor (transcripts du CLI et des agents de l’IDE). */
export function cursorHome(): string {
  return path.join(os.homedir(), ".cursor");
}

export function cursorDb(root: string): string {
  return path.join(root, "User", "globalStorage", "state.vscdb");
}

export async function findCursorFiles(root: string, since: number, csv?: string): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  const db = cursorDb(root);
  try {
    const st = fs.statSync(db);
    let mtime = st.mtimeMs;
    try {
      mtime = Math.max(mtime, fs.statSync(`${db}-wal`).mtimeMs);
    } catch {
      /* pas de -wal */
    }
    if (mtime >= since) out.push({ path: db, size: st.size, mtime });
  } catch {
    /* pas d’IDE */
  }
  // Transcripts du CLI (et des agents de l’IDE, écartés plus tard s’ils existent dans la base).
  const projects = path.join(cursorHome(), "projects");
  for (const f of await walk(projects, (n) => n.endsWith(".jsonl"), since, 4)) {
    if (f.path.split(/[\\/]/).includes("agent-transcripts")) out.push(f);
  }
  if (csv) {
    try {
      const st = fs.statSync(csv);
      out.push({ path: csv, size: st.size, mtime: st.mtimeMs });
    } catch {
      /* fichier introuvable : signalé par l’appelant */
    }
  }
  return out;
}

interface Header {
  bubbleId: string;
  type?: number;
}

function parseHeaders(raw: unknown): Header[] {
  const s = text(raw);
  if (!s || s === "[]") return [];
  try {
    const list = JSON.parse(s);
    return Array.isArray(list) ? list.filter((h) => h && typeof h.bubbleId === "string") : [];
  } catch {
    return [];
  }
}

/** Valeur JSON de cursorDiskKV, qu’elle soit stockée en TEXT ou en BLOB. */
const J = "CASE WHEN typeof(value) = 'blob' THEN CAST(value AS TEXT) ELSE value END";

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** « Thursday, Sep 3, 2026, 6:52 AM (UTC-7) » → millisecondes. */
function tagTime(s: string): number {
  const m = /<timestamp>\s*\w+,\s*(\w{3})\w*\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(AM|PM)?\s*(?:\((?:UTC|GMT)\s*([+-]\d{1,2})(?::?(\d{2}))?\))?/i.exec(s);
  if (!m) return NaN;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return NaN;
  let h = Number(m[4]) % 12;
  if ((m[6] ?? "").toUpperCase() === "PM") h += 12;
  else if (!m[6]) h = Number(m[4]);
  const off = m[7] ? Number(m[7]) * 60 + Math.sign(Number(m[7]) || 1) * Number(m[8] ?? 0) : 0;
  return Date.UTC(Number(m[3]), month, Number(m[2]), h, Number(m[5])) - off * 60_000;
}

/** Une ligne CSV avec guillemets. */
function csvCells(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

const toInt = (s: string | undefined) => {
  const n = Number((s ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};

export class CursorParser {
  /** sessions de l’IDE : leurs transcripts ne sont pas recomptés */
  private composers = new Set<string>();
  private seenBubble = new Set<string>();
  private seenTool = new Set<string>();
  /** lignes de l’export CSV importées */
  csvRows = 0;
  /** la base de l’IDE existe mais n’a pas pu être lue (Node trop ancien, base verrouillée) */
  dbSkipped = false;

  constructor(private agg: Aggregator) {}

  async parse(file: FoundFile) {
    if (file.path.endsWith(".vscdb")) {
      this.agg.fileScanned("cursor");
      if (!this.parseDb(file)) this.dbSkipped = true;
    } else if (file.path.endsWith(".jsonl")) {
      await this.parseTranscript(file);
    } else {
      this.agg.fileScanned("cursor");
      await this.parseCsv(file.path);
    }
  }

  private parseDb(file: FoundFile): boolean {
    const db = ReadOnlyDb.open(file.path);
    if (!db) return false;
    try {
      if (!db.hasTable("cursorDiskKV")) return false;
      try {
        db.all("PRAGMA busy_timeout = 2000");
      } catch {
        /* lecture seule stricte */
      }
      const composers = db.all(
        `SELECT substr(k, 14) AS id,
           json_extract(j, '$.createdAt') AS created,
           json_extract(j, '$.lastUpdatedAt') AS updated,
           CAST(json_extract(j, '$.workspaceIdentifier.uri.fsPath') AS BLOB) AS fs,
           CAST(json_extract(j, '$.trackedGitRepos[0].repoPath') AS BLOB) AS repo,
           json_extract(j, '$.headerLog.chunkCount') AS chunks,
           CAST(json_extract(j, '$.fullConversationHeadersOnly') AS BLOB) AS headers,
           json_extract(j, '$.subagentInfo') IS NOT NULL OR json_extract(j, '$.isSubagent') = 1 AS sub
         FROM (SELECT key AS k, ${J} AS j FROM cursorDiskKV WHERE key >= 'composerData:' AND key < 'composerData;')
         WHERE json_valid(j)`,
      );
      const start = this.agg.rangeStart();
      for (const c of composers) {
        const id = String(c.id);
        if (!id || id.includes("\n")) continue;
        this.composers.add(id);
        const created = when(c.created);
        const updated = when(c.updated);
        // lastUpdatedAt peut retarder sur les bulles : on garde une large marge avant d’écarter une session.
        if (Number.isFinite(updated) && updated < start - 90 * 86_400_000) continue;
        this.composer(db, id, {
          created,
          project: projectName(text(c.fs) || text(c.repo)),
          headers: parseHeaders(c.headers),
          chunks: Number(c.chunks) || 0,
          sub: Number(c.sub) === 1,
        });
      }
      return true;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  private composer(db: ReadOnlyDb, id: string, c: { created: number; project?: string; headers: Header[]; chunks: number; sub: boolean }) {
    let headers = c.headers;
    if (!headers.length && c.chunks > 0) {
      db.each(
        `SELECT CAST(${J} AS BLOB) AS v FROM cursorDiskKV WHERE key >= ? AND key < ? ORDER BY key`,
        [`composerConvHeaders:${id}:`, `composerConvHeaders:${id};`],
        (row) => {
          headers = headers.concat(parseHeaders(row.v));
        },
      );
    }
    // Sans en-têtes (très anciennes versions), toutes les bulles de la session comptent.
    const listed = headers.length ? new Set(headers.map((h) => h.bubbleId)) : null;
    const prefix = `bubbleId:${id}:`;
    let last = Number.isFinite(c.created) ? c.created : NaN;
    db.each(
      `SELECT substr(k, ${prefix.length + 1}) AS bid,
         json_extract(j, '$.type') AS type,
         json_extract(j, '$.createdAt') AS created,
         json_extract(j, '$.timingInfo.clientRpcSendTime') AS rpc,
         json_extract(j, '$.timingInfo.clientSettleTime') AS settle,
         length(json_extract(j, '$.text')) AS chars,
         CAST(json_extract(j, '$.toolFormerData.name') AS BLOB) AS tool,
         CAST(json_extract(j, '$.toolFormerData.toolCallId') AS BLOB) AS call,
         CAST(substr(coalesce(json_extract(j, '$.toolFormerData.rawArgs'), json_extract(j, '$.toolFormerData.params')), 1, 400) AS BLOB) AS args
       FROM (SELECT key AS k, ${J} AS j FROM cursorDiskKV WHERE key >= ? AND key < ?)
       WHERE json_valid(j)`,
      [prefix, `bubbleId:${id};`],
      (b) => {
        const bid = String(b.bid);
        if (listed && !listed.has(bid)) return;
        if (this.seenBubble.has(bid)) return;
        this.seenBubble.add(bid);
        let ts = when(b.created);
        if (!Number.isFinite(ts)) ts = when(b.rpc);
        if (!Number.isFinite(ts)) ts = when(b.settle);
        if (!Number.isFinite(ts)) ts = last;
        if (!Number.isFinite(ts)) return;
        last = ts;
        const type = Number(b.type);
        if (!c.sub) this.agg.activity("cursor", ts, id);
        if (type === 1) {
          const chars = Number(b.chars) || 0;
          if (chars > 0 && !c.sub) this.agg.prompt({ tool: "cursor", ts, chars, session: id, project: c.project });
          return;
        }
        const tool = text(b.tool);
        if (!tool) return;
        const callId = text(b.call);
        if (callId) {
          if (this.seenTool.has(callId)) return;
          this.seenTool.add(callId);
        }
        const name = canon(tool);
        const file = name === "Read" || name === "Edit" || name === "Write" ? fileFromArgs(text(b.args)) : undefined;
        this.agg.call({ tool: "cursor", ts, name, file, creates: name === "Write", session: id });
      },
    );
  }

  /** Transcript du CLI : ~/.cursor/projects/<projet>/agent-transcripts/<id>/<id>.jsonl */
  private async parseTranscript(file: FoundFile) {
    const id = path.basename(file.path, ".jsonl");
    // Session de l’IDE déjà lue dans la base.
    if (this.composers.has(id)) return;
    const parts = file.path.split(/[\\/]/);
    const isSub = parts.includes("subagents");
    const session = isSub ? parts[parts.indexOf("subagents") - 1] || id : id;
    this.agg.fileScanned("cursor");
    let last = NaN;
    const pending: { chars: number }[] = [];
    const flush = (ts: number) => {
      for (const p of pending.splice(0)) this.agg.prompt({ tool: "cursor", ts, chars: p.chars, session });
    };
    await eachLine(file.path, (line) => {
      const j = safeJson(line);
      if (!j) return;
      const role = str(j.role);
      const content = obj(j.message).content ?? j.content;
      const blocks = typeof content === "string" ? [{ type: "text", text: content }] : arr(content).map(obj);
      if (role === "user") {
        const all = blocks.map((b) => str(b.text)).join("\n");
        const ts = tagTime(all);
        if (Number.isFinite(ts)) last = ts;
        const q = /<user_query>([\s\S]*?)(?:<\/user_query>|$)/.exec(all);
        if (!q || isSub) return;
        const chars = q[1].trim().length;
        if (!chars) return;
        if (Number.isFinite(last)) this.agg.prompt({ tool: "cursor", ts: last, chars, session });
        else pending.push({ chars });
        return;
      }
      if (role !== "assistant") return;
      for (const b of blocks) {
        if (b.type !== "tool_use" && b.type !== "tool-call") continue;
        const tool = str(b.name) || str(b.toolName);
        if (!tool || !Number.isFinite(last)) continue;
        const name = canon(tool);
        const input = obj(b.input ?? b.args);
        const f = name === "Read" || name === "Edit" || name === "Write" ? str(input.path) || str(input.file_path) || str(input.target_file) || undefined : undefined;
        this.agg.call({ tool: "cursor", ts: last, name, file: f, creates: name === "Write", session });
      }
    });
    // Messages sans horodatage : rattachés à la date du fichier.
    flush(Number.isFinite(last) ? last : file.mtime);
    if (Number.isFinite(last)) this.agg.activity("cursor", last, session);
  }

  /** Export « Usage » de cursor.com/dashboard (v1, v2 ou v3 des colonnes). */
  private async parseCsv(file: string) {
    let cols: Record<string, number> | null = null;
    await eachLine(file, (line) => {
      const cells = csvCells(line.replace(/^﻿/, ""));
      if (!cols) {
        const idx: Record<string, number> = {};
        cells.forEach((name, i) => (idx[name.toLowerCase()] = i));
        if ("date" in idx && "model" in idx) cols = idx;
        return;
      }
      const get = (name: string) => cells[cols![name] ?? -1];
      const ts = Date.parse(get("date") ?? "");
      if (!Number.isFinite(ts)) return;
      // « Input (w/ Cache Write) » = tokens écrits en cache ; « Input (w/o Cache Write) » = entrée hors cache.
      const cw = toInt(get("input (w/ cache write)"));
      const inp = toInt(get("input (w/o cache write)"));
      const cr = toInt(get("cache read"));
      const out = toInt(get("output tokens"));
      if (inp + cw + cr + out === 0) return;
      let model = (get("model") || "auto").toLowerCase();
      if (model === "auto" || model === "default") model = "cursor-auto";
      this.csvRows += 1;
      // Une ligne facturée couvre souvent tout un tour d’agent (des dizaines d’appels au modèle) : on estime
      // le nombre d’appels pour garder une taille de prompt moyenne réaliste (paliers de prix, contrôles du site).
      const prompt = inp + cw + cr;
      const requests = Math.max(1, Math.ceil(prompt / 150_000), Math.ceil(out / 100_000));
      this.agg.usage({ tool: "cursor", model, ts, inp, out, cw5: cw, cw1: 0, cr, rs: 0, promptSize: prompt / requests, requests, session: "" });
    });
  }
}
