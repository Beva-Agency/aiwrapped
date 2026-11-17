import path from "node:path";
import type { Aggregator, ToolId } from "./collect";
import { exists, type FoundFile } from "./files";
import { appData, home, xdgData } from "./paths";
import { ClaudeParser, findClaudeFiles } from "./parsers/claude";
import { CodexParser, findCodexFiles } from "./parsers/codex";
import { ANTIGRAVITY_APPS, AntigravityParser, findAntigravityFiles } from "./parsers/antigravity";
import { clineTaskDirs, ClineParser, findClineFiles } from "./parsers/cline";
import { CopilotParser, findCopilotFiles } from "./parsers/copilot";
import { cursorDb, cursorHome, CursorParser, findCursorFiles } from "./parsers/cursor";
import { findOpencodeFiles, OpencodeParser } from "./parsers/opencode";
import { findPiFiles, PiParser } from "./parsers/pi";
import { findQwenFiles, QwenParser } from "./parsers/qwen";
import { findGeminiFiles, GeminiParser } from "./parsers/gemini";

/**
 * Registre des outils lus par le CLI. Ajouter un outil : un parseur dans src/parsers, une entrée ici,
 * et le même identifiant dans TOOL_IDS (src/collect.ts) et côté site (src/lib/payload/schema.ts).
 */

export interface Parser {
  parse(file: FoundFile): Promise<void>;
  /** appelé une fois tous les fichiers lus (dédoublonnage global) */
  flush?(): void;
}

export interface Source {
  id: ToolId;
  /** nom affiché */
  name: string;
  /** dossier racine : option --<id>-dir, puis variable d’environnement, puis emplacement par défaut */
  root(dir?: string): string;
  /** dossier qui doit exister pour que l’outil soit lu (affiché dans le terminal) */
  probe(root: string): string;
  /** l’outil a besoin de node:sqlite (Node 22.13+) pour les tokens */
  sqlite?: boolean;
  find(root: string, since: number): Promise<FoundFile[]>;
  parser(agg: Aggregator): Parser;
}

/** Options de la ligne de commande utiles à certains outils. */
export const options: { cursorCsv?: string } = {};

export const SOURCES: Source[] = [
  {
    id: "claude",
    name: "Claude Code",
    root: (dir) => home(dir ?? process.env.CLAUDE_CONFIG_DIR ?? "~/.claude"),
    probe: (root) => path.join(root, "projects"),
    find: findClaudeFiles,
    parser: (agg) => new ClaudeParser(agg),
  },
  {
    id: "codex",
    name: "Codex",
    root: (dir) => home(dir ?? process.env.CODEX_HOME ?? "~/.codex"),
    probe: (root) => path.join(root, "sessions"),
    find: findCodexFiles,
    parser: (agg) => new CodexParser(agg),
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    root: (dir) => home(dir ?? "~/.gemini"),
    probe: (root) => path.join(root, "tmp"),
    find: findGeminiFiles,
    parser: (agg) => new GeminiParser(agg),
  },
  {
    id: "antigravity",
    name: "Antigravity",
    root: (dir) => home(dir ?? "~/.gemini"),
    // IDE, application 2.0 et CLI agy ont chacun leur dossier : on affiche le premier présent.
    probe: (root) => ANTIGRAVITY_APPS.map((a) => path.join(root, a)).find((p) => exists(p)) ?? path.join(root, "antigravity"),
    sqlite: true,
    find: findAntigravityFiles,
    parser: (agg) => new AntigravityParser(agg),
  },
  {
    id: "cursor",
    name: "Cursor",
    root: (dir) => home(dir ?? appData("Cursor")),
    // L’IDE, sinon le CLI cursor-agent, sinon l’export CSV passé avec --cursor-csv.
    probe: (root) =>
      [path.dirname(cursorDb(root)), path.join(cursorHome(), "projects")].find((p) => exists(p)) ??
      (options.cursorCsv ? path.dirname(path.resolve(options.cursorCsv)) : path.dirname(cursorDb(root))),
    sqlite: true,
    find: (root, since) => findCursorFiles(root, since, options.cursorCsv),
    parser: (agg) => new CursorParser(agg),
  },
  {
    id: "opencode",
    name: "OpenCode",
    root: (dir) => home(dir ?? process.env.OPENCODE_DATA_DIR ?? xdgData("opencode")),
    probe: (root) => root,
    sqlite: true,
    find: findOpencodeFiles,
    parser: (agg) => new OpencodeParser(agg),
  },
  {
    id: "copilot",
    name: "Copilot CLI",
    root: (dir) => home(dir ?? (process.env.COPILOT_HOME?.trim() || "~/.copilot")),
    probe: (root) => path.join(root, "session-state"),
    find: findCopilotFiles,
    parser: (agg) => new CopilotParser(agg),
  },
  {
    id: "pi",
    name: "Pi",
    root: (dir) => home(dir ?? process.env.PI_CODING_AGENT_DIR ?? "~/.pi/agent"),
    probe: (root) => path.join(root, "sessions"),
    find: findPiFiles,
    parser: (agg) => new PiParser(agg),
  },
  {
    id: "qwen",
    name: "Qwen Code",
    root: (dir) => home(dir ?? process.env.QWEN_HOME ?? "~/.qwen"),
    probe: (root) => path.join(root, "projects"),
    find: findQwenFiles,
    parser: (agg) => new QwenParser(agg),
  },
  {
    id: "cline",
    name: "Cline",
    // --cline-dir : le dossier de stockage de l’extension (celui qui contient tasks/).
    root: (dir) => (dir ? home(dir) : ""),
    probe: (root) => {
      const dirs = clineTaskDirs(root || undefined);
      return dirs.find((p) => exists(p)) ?? dirs[0];
    },
    find: (root, since) => findClineFiles(clineTaskDirs(root || undefined), since),
    parser: (agg) => new ClineParser(agg),
  },
];
