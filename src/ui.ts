/**
 * Sortie terminal : même système que le site. Curseur jaune, gris pour les chemins,
 * jaune pour un seul chiffre. Respecte NO_COLOR et les terminaux sans couleur.
 */

const env = process.env;
const isTTY = !!process.stdout.isTTY;
const noColor = "NO_COLOR" in env || env.TERM === "dumb" || !isTTY;
const truecolor =
  env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || process.platform === "win32" || !!env.WT_SESSION;

type Paint = (s: string) => string;

function rgb(r: number, g: number, b: number, c256: number): Paint {
  return (s) => {
    if (noColor) return s;
    return truecolor ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : `\x1b[38;5;${c256}m${s}\x1b[39m`;
  };
}

export const yellow = rgb(242, 233, 78, 221);
export const claude = rgb(229, 135, 95, 173);
export const codex = rgb(94, 209, 162, 79);
export const gemini = rgb(142, 166, 255, 111);
export const danger = rgb(255, 107, 90, 203);
export const dim: Paint = (s) => (noColor ? s : `\x1b[2m${s}\x1b[22m`);
export const bold: Paint = (s) => (noColor ? s : `\x1b[1m${s}\x1b[22m`);
export const underline: Paint = (s) => (noColor ? s : `\x1b[4m${s}\x1b[24m`);

export const TOOL_PAINT = { claude, codex, gemini } as const;

export function cursor(): string {
  return noColor ? "|" : yellow("█");
}

export function out(line = "") {
  process.stdout.write(`${line}\n`);
}

export function err(line: string) {
  process.stderr.write(`${line}\n`);
}

/** Ligne de progression réécrite sur place (TTY uniquement). */
export function progressLine(text: string) {
  if (!isTTY) return;
  const width = process.stdout.columns || 80;
  process.stdout.write(`\r${text.slice(0, width - 1).padEnd(Math.min(width - 1, 90))}`);
}

export function clearLine() {
  if (!isTTY) return;
  process.stdout.write("\r\x1b[2K");
}

export function bar(ratio: number, width = 10): string {
  const full = Math.round(Math.max(0, Math.min(1, ratio)) * width);
  return "━".repeat(full) + dim("━".repeat(width - full));
}
