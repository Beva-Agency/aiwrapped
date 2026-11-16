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
  noData: "Aucune activité trouvée sur cette période.",
  noDataHint: "Essaie --all pour tout l’historique, ou vérifie que Claude Code, Codex ou Gemini CLI tournent sur cette machine.",
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

Lit en local les logs de Claude Code, Codex et Gemini CLI, calcule ton Wrapped
et l’ouvre sur wrapped.mazaki.fr. Tes prompts et ton code ne quittent pas ta machine.

Options
  --year <AAAA>          une année précise (défaut : l’année en cours)
  --since <AAAA-MM-JJ>   depuis une date
  --all                  tout l’historique
  --only <outils>        claude,codex,gemini
  --hide-projects        remplace les noms de projets par projet-1, projet-2…
  --no-stats             ne pas compter ce Wrapped dans les statistiques globales
  --no-open              affiche le lien sans ouvrir le navigateur
  --json                 affiche les données qui seraient envoyées, et c’est tout
  --lang <fr|en>         langue du terminal et du site
  --claude-dir <chemin>  dossier Claude Code (défaut : ~/.claude)
  --codex-dir <chemin>   dossier Codex (défaut : ~/.codex)
  --gemini-dir <chemin>  dossier Gemini CLI (défaut : ~/.gemini)
  -v, --version          version
  -h, --help             cette aide`,
};

const en: typeof fr = {
  tagline: "local read, nothing is sent",
  files: (n: string) => `${n} files`,
  notFound: "not found",
  skipped: "skipped",
  noData: "No activity found for this period.",
  noDataHint: "Try --all for your whole history, or check that Claude Code, Codex or Gemini CLI run on this machine.",
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

Reads your Claude Code, Codex and Gemini CLI logs locally, computes your Wrapped
and opens it on wrapped.mazaki.fr. Your prompts and code never leave your machine.

Options
  --year <YYYY>          a specific year (default: the current year)
  --since <YYYY-MM-DD>   from a date
  --all                  your whole history
  --only <tools>         claude,codex,gemini
  --hide-projects        replace project names with projet-1, projet-2…
  --no-stats             don’t count this Wrapped in the global stats
  --no-open              print the link without opening the browser
  --json                 print the data that would be sent, and stop
  --lang <fr|en>         terminal and website language
  --claude-dir <path>    Claude Code folder (default: ~/.claude)
  --codex-dir <path>     Codex folder (default: ~/.codex)
  --gemini-dir <path>    Gemini CLI folder (default: ~/.gemini)
  -v, --version          version
  -h, --help             this help`,
};

export const TEXT = { fr, en };
