export type Lang = "fr" | "en";

export function detectLang(forced?: string): Lang {
  if (forced === "fr" || forced === "en") return forced;
  const env = process.env;
  const candidates = [env.LC_ALL, env.LC_MESSAGES, env.LANG, env.LANGUAGE];
  try {
    candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    /* rien */
  }
  for (const c of candidates) {
    if (c && /^fr([_-]|$)/i.test(c)) return "fr";
  }
  return "en";
}

const fr = {
  tagline: "lecture locale, rien n’est envoyé",
  files: (n: string) => `${n} fichiers`,
  notFound: "introuvable",
  skipped: "ignoré",
  cursorCsv: (n: string) => `${n} lignes importées de l’export Cursor`,
  cursorNoTokens: "Cursor ne garde plus ses tokens en local : ajoute --cursor-csv <export> pour les avoir",
  needsSqlite: (v: string) => `base SQLite non lue : il faut Node 22.13 ou plus (tu as ${v})`,
  noData: "Aucune activité trouvée sur cette période.",
  noDataHint: "Essaie --all pour tout l’historique, ou vérifie qu’un de tes agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode…) tourne sur cette machine.",
  summary: (days: string, sessions: string) => `${days} jours · ${sessions} sessions · `,
  tokens: (t: string) => `${t} tokens`,
  opened: "ouvert dans ton navigateur. Tout est après le #,",
  opened2: "et ton navigateur ne l’envoie jamais au serveur.",
  notOpened: "copie ce lien dans ton navigateur :",
  stats: "Tes totaux anonymes alimentent le compteur global. Pour refuser : --no-stats",
  noStats: "Stats globales désactivées (--no-stats).",
  retention: (d: number) =>
    `Claude Code n’a gardé que ${d} jours de logs. Pour une année entière : "cleanupPeriodDays": 365 dans ~/.claude/settings.json`,
  period: { year: (y: number) => `année ${y}`, since: (d: string) => `depuis le ${d}`, all: "tout l’historique" },
  help: `Usage : npx wrappedai [options]

Lit en local les logs de tes agents IA, calcule ton Wrapped et l’ouvre sur
wrapped.mazaki.fr. Tes prompts et ton code ne quittent pas ta machine.

Outils lus : claude (Claude Code), codex, gemini (Gemini CLI), antigravity, cursor,
opencode, copilot (Copilot CLI), pi, qwen (Qwen Code), cline.
Cursor, Antigravity et OpenCode demandent Node 22.13 ou plus (base SQLite).

Options
  --year <AAAA>          une année précise (défaut : l’année en cours)
  --since <AAAA-MM-JJ>   depuis une date
  --all                  tout l’historique
  --only <outils>        seulement ces outils, par exemple claude,cursor
  --cursor-csv <fichier> tokens exacts de Cursor : l’export Usage de cursor.com/dashboard
  --hide-projects        remplace les noms de projets par projet-1, projet-2…
  --no-stats             ne pas compter ce Wrapped dans les statistiques globales
  --no-open              affiche le lien sans ouvrir le navigateur
  --json                 affiche les données qui seraient envoyées, et c’est tout
  --lang <fr|en>         langue du terminal et du site
  --<outil>-dir <chemin> dossier d’un outil s’il n’est pas à sa place habituelle,
                         par exemple --claude-dir ~/.claude ou --opencode-dir ~/.local/share/opencode
  -v, --version          version
  -h, --help             cette aide`,
};

const en: typeof fr = {
  tagline: "local read, nothing is sent",
  files: (n: string) => `${n} files`,
  notFound: "not found",
  skipped: "skipped",
  cursorCsv: (n: string) => `${n} rows imported from the Cursor export`,
  cursorNoTokens: "Cursor no longer keeps its tokens locally: add --cursor-csv <export> to get them",
  needsSqlite: (v: string) => `SQLite database not read: needs Node 22.13 or later (you have ${v})`,
  noData: "No activity found for this period.",
  noDataHint: "Try --all for your whole history, or check that one of your agents (Claude Code, Codex, Cursor, Gemini CLI, OpenCode…) runs on this machine.",
  summary: (days: string, sessions: string) => `${days} days · ${sessions} sessions · `,
  tokens: (t: string) => `${t} tokens`,
  opened: "opened in your browser. Everything is after the #,",
  opened2: "and your browser never sends that part to the server.",
  notOpened: "paste this link in your browser:",
  stats: "Your anonymous totals feed the global counter. To opt out: --no-stats",
  noStats: "Global stats disabled (--no-stats).",
  retention: (d: number) =>
    `Claude Code only kept ${d} days of logs. For a full year: "cleanupPeriodDays": 365 in ~/.claude/settings.json`,
  period: { year: (y: number) => `year ${y}`, since: (d: string) => `since ${d}`, all: "full history" },
  help: `Usage: npx wrappedai [options]

Reads your AI agents’ logs locally, computes your Wrapped and opens it on
wrapped.mazaki.fr. Your prompts and code never leave your machine.

Tools read: claude (Claude Code), codex, gemini (Gemini CLI), antigravity, cursor,
opencode, copilot (Copilot CLI), pi, qwen (Qwen Code), cline.
Cursor, Antigravity and OpenCode need Node 22.13 or later (SQLite database).

Options
  --year <YYYY>          a specific year (default: the current year)
  --since <YYYY-MM-DD>   from a date
  --all                  your whole history
  --only <tools>         only these tools, for example claude,cursor
  --cursor-csv <file>    exact Cursor tokens: the Usage export from cursor.com/dashboard
  --hide-projects        replace project names with projet-1, projet-2…
  --no-stats             don’t count this Wrapped in the global stats
  --no-open              print the link without opening the browser
  --json                 print the data that would be sent, and stop
  --lang <fr|en>         terminal and website language
  --<tool>-dir <path>    a tool’s folder if it is not in its usual place,
                         for example --claude-dir ~/.claude or --opencode-dir ~/.local/share/opencode
  -v, --version          version
  -h, --help             this help`,
};

export const TEXT = { fr, en };
