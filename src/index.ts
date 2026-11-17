import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { Aggregator, TOOL_IDS, type Payload, type ToolId } from "./collect";
import { exists } from "./files";
import { detectLang, TEXT } from "./i18n";
import { CursorParser } from "./parsers/cursor";
import { options, SOURCES } from "./sources";
import { sqliteAvailable } from "./sqlite";
import { bar, bold, clearLine, cursor, danger, dim, err, out, progressLine, TOOL_PAINT, underline, yellow } from "./ui";

const VERSION = "0.2.0";
const DEFAULT_URL = "https://wrapped.mazaki.fr";
const ALL_TOOLS: ToolId[] = [...TOOL_IDS];

interface Args {
  year?: number;
  since?: string;
  all: boolean;
  only: ToolId[];
  hideProjects: boolean;
  noStats: boolean;
  noOpen: boolean;
  json: boolean;
  lang?: string;
  dirs: Partial<Record<ToolId, string>>;
  url: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    all: false,
    only: ALL_TOOLS,
    hideProjects: false,
    noStats: false,
    noOpen: false,
    json: false,
    dirs: {},
    url: process.env.WRAPPEDAI_URL || DEFAULT_URL,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split("=", 2) as [string, string | undefined];
    const next = () => inline ?? argv[++i] ?? "";
    switch (flag) {
      case "--year": a.year = Number(next()); break;
      case "--since": a.since = next(); break;
      case "--all": a.all = true; break;
      case "--only": a.only = next().split(",").map((s) => s.trim()).filter((s): s is ToolId => (ALL_TOOLS as string[]).includes(s)); break;
      case "--hide-projects": a.hideProjects = true; break;
      case "--no-stats": a.noStats = true; break;
      case "--no-open": a.noOpen = true; break;
      case "--json": a.json = true; break;
      case "--lang": a.lang = next(); break;
      case "--cursor-csv": options.cursorCsv = next(); break;
      case "--url": a.url = next(); break;
      case "-h": case "--help": a.help = true; break;
      case "-v": case "--version": a.version = true; break;
      default: {
        // --claude-dir, --cursor-dir… : un dossier par outil.
        const dir = /^--([a-z]+)-dir$/.exec(flag);
        if (dir && (ALL_TOOLS as string[]).includes(dir[1])) {
          a.dirs[dir[1] as ToolId] = next();
          break;
        }
        err(danger(`Option inconnue / unknown option: ${argv[i]}`));
        a.help = true;
      }
    }
  }
  return a;
}

function pretty(p: string): string {
  const h = os.homedir();
  return p.startsWith(h) ? `~${p.slice(h.length)}`.replace(/\\/g, "/") : p;
}

/** Identifiant anonyme et aléatoire de l'installation, pour ne compter chaque personne qu'une fois. */
function installId(): string {
  const dir = path.join(os.homedir(), ".wrappedai");
  const file = path.join(dir, "id");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[A-Za-z0-9_-]{16,32}$/.test(existing)) return existing;
  } catch {
    /* première exécution */
  }
  const id = randomBytes(16).toString("base64url");
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, id, { mode: 0o600 });
  } catch {
    /* lecture seule : identifiant éphémère */
  }
  return id;
}

function encode(p: Payload): string {
  return `v1.${deflateRawSync(Buffer.from(JSON.stringify(p)), { level: 9 }).toString("base64url")}`;
}

function openBrowser(url: string): boolean {
  try {
    let cmd: string;
    let args: string[];
    if (process.platform === "win32") {
      // rundll32 accepte les URL longues, contrairement à `start` sous cmd.
      cmd = "rundll32";
      args = ["url.dll,FileProtocolHandler", url];
    } else if (process.platform === "darwin") {
      cmd = "open";
      args = [url];
    } else if (process.env.WSL_DISTRO_NAME) {
      cmd = "wslview";
      args = [url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function fmtInt(n: number, lang: "fr" | "en") {
  return new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-US").format(Math.round(n));
}

function fmtCompact(n: number, lang: "fr" | "en") {
  const units: [number, string][] = [
    [1e12, lang === "fr" ? " Bn" : "T"],
    [1e9, lang === "fr" ? " Md" : "B"],
    [1e6, lang === "fr" ? " M" : "M"],
    [1e3, lang === "fr" ? " k" : "k"],
  ];
  for (const [base, unit] of units) {
    if (n >= base) {
      const v = n / base;
      return `${new Intl.NumberFormat(lang === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: v >= 100 ? 0 : 1 }).format(v)}${unit}`;
    }
  }
  return fmtInt(n, lang);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lang = detectLang(args.lang);
  const t = TEXT[lang];
  if (args.version) {
    out(VERSION);
    return;
  }
  if (args.help) {
    out(t.help);
    return;
  }

  // Période : année en cours par défaut.
  const now = new Date();
  let scope: "year" | "since" | "all" = "year";
  let start: number;
  let end = now.getTime();
  let year: number | undefined;
  if (args.all) {
    scope = "all";
    start = 0;
  } else if (args.since && /^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
    scope = "since";
    start = new Date(`${args.since}T00:00:00`).getTime();
  } else {
    year = args.year && args.year > 2000 && args.year < 3000 ? args.year : now.getFullYear();
    start = new Date(year, 0, 1).getTime();
    end = Math.min(end, new Date(year + 1, 0, 1).getTime() - 1);
  }

  const agg = new Aggregator({ start, end });

  if (!args.json) {
    out();
    out(`  ${cursor()} ${bold("wrapped")} ${dim(`${VERSION} · ${t.tagline}`)}`);
    out();
  }

  const nameW = Math.max(...SOURCES.map((s) => s.name.length));
  const pathW = 26;
  for (const src of SOURCES) {
    const root = src.root(args.dirs[src.id]);
    const probe = src.probe(root);
    const shown = pretty(probe);
    const label = `  ${TOOL_PAINT[src.id](src.name.padEnd(nameW))}  ${dim((shown.length > pathW ? `…${shown.slice(-(pathW - 1))}` : shown).padEnd(pathW))}`;
    if (!args.only.includes(src.id)) {
      if (!args.json) out(`${label} ${dim(t.skipped)}`);
      continue;
    }
    if (!exists(probe)) {
      if (!args.json) out(`${label} ${dim(t.notFound)}`);
      continue;
    }
    const parser = src.parser(agg);
    // Un fichier modifié avant le début de la période ne peut rien contenir d'utile.
    const files = await src.find(root, start - 86_400_000);
    const total = files.reduce((a, f) => a + f.size, 0) || 1;
    let done = 0;
    for (const f of files) {
      if (!args.json) progressLine(`${label} ${t.files(fmtInt(files.length, lang)).padStart(16)}  ${bar(done / total)}`);
      try {
        await parser.parse(f);
      } catch {
        /* fichier illisible : ignoré */
      }
      done += f.size;
    }
    parser.flush?.();
    if (!args.json) {
      clearLine();
      out(`${label} ${t.files(fmtInt(files.length, lang)).padStart(16)}  ${bar(1)} ok`);
      const pad = `  ${" ".repeat(nameW)}  `;
      if (src.sqlite && files.length > 0 && !sqliteAvailable()) out(`${pad}${dim(t.needsSqlite(process.versions.node))}`);
      else if (parser instanceof CursorParser && files.length > 0) {
        out(`${pad}${dim(parser.csvRows > 0 ? t.cursorCsv(fmtInt(parser.csvRows, lang)) : t.cursorNoTokens)}`);
      }
    }
  }

  if (!agg.hasActivity()) {
    out();
    out(`  ${t.noData}`);
    out(`  ${dim(t.noDataHint)}`);
    out();
    process.exitCode = 1;
    return;
  }

  const payload = agg.build({
    id: installId(),
    noStats: args.noStats,
    cli: VERSION,
    lang,
    scope,
    year,
    hideProjects: args.hideProjects,
    tools: args.only,
  });

  if (args.json) {
    out(JSON.stringify(payload, null, 2));
    return;
  }

  const days = Math.round((new Date(`${payload.to}T00:00:00`).getTime() - new Date(`${payload.from}T00:00:00`).getTime()) / 86_400_000) + 1;
  const tokens = payload.models.reduce((a, m) => a + m.u[0] + m.u[1] + m.u[2] + m.u[3] + m.u[4], 0);
  out();
  out(`  ${bold(t.summary(fmtInt(days, lang), fmtInt(payload.sessions, lang)))}${yellow(bold(t.tokens(fmtCompact(tokens, lang))))}`);

  const claudeFirst = payload.tools.claude?.first;
  if (claudeFirst && scope !== "since") {
    const claudeDays = Math.round((new Date(`${payload.to}T00:00:00`).getTime() - new Date(`${claudeFirst}T00:00:00`).getTime()) / 86_400_000) + 1;
    if (claudeDays <= 32) out(`  ${dim(t.retention(claudeDays))}`);
  }

  const base = args.url.replace(/\/+$/, "");
  const url = `${base}/${lang}/w#${encode(payload)}`;
  const shortUrl = url.length > 70 ? `${url.slice(0, 66)}…` : url;
  out();
  const opened = !args.noOpen && openBrowser(url);
  if (opened) {
    out(`  ${yellow("→")} ${underline(shortUrl)}`);
    out(`    ${dim(t.opened)}`);
    out(`    ${dim(t.opened2)}`);
  } else {
    out(`  ${yellow("→")} ${t.notOpened}`);
    out();
    out(url);
  }
  out();
  out(`  ${dim(args.noStats ? t.noStats : t.stats)}`);
  out();
}

// `npx wrappedai --json | head` : le lecteur ferme le tuyau, ce n’est pas une erreur.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

main().catch((e: unknown) => {
  err(danger(`wrappedai: ${e instanceof Error ? e.message : String(e)}`));
  process.exitCode = 1;
});
