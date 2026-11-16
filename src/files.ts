import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface FoundFile {
  path: string;
  size: number;
  mtime: number;
}

/** Liste récursive des fichiers dont le nom passe `accept`, modifiés après `since` (ms). */
export async function walk(root: string, accept: (name: string) => boolean, since = 0, maxDepth = 8): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  async function rec(dir: string, depth: number) {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth) await rec(full, depth + 1);
      } else if (e.isFile() && accept(e.name)) {
        try {
          const st = await fs.promises.stat(full);
          if (st.mtimeMs >= since) out.push({ path: full, size: st.size, mtime: st.mtimeMs });
        } catch {
          /* fichier disparu entre-temps */
        }
      }
    }
  }
  await rec(root, 0);
  return out;
}

export function exists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Lit un fichier ligne par ligne, en flux (les logs peuvent peser des centaines de Mo). */
export async function eachLine(file: string, onLine: (line: string) => void): Promise<void> {
  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 1 << 20 });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (line) onLine(line);
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

export function safeJson(line: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(line);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Nom court d'un projet : le dernier segment du dossier de travail. */
export function projectName(cwd: string): string | undefined {
  if (!cwd) return undefined;
  const base = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  return base || undefined;
}
