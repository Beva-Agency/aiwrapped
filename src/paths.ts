import os from "node:os";
import path from "node:path";

export function home(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Dossier de données d’une application de bureau (VS Code, Cursor, Antigravity…). */
export function appData(app: string): string {
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), app);
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", app);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), app);
}

/** Dossier de données XDG : ~/.local/share partout, Windows compris (OpenCode suit cette règle). */
export function xdgData(app: string): string {
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), app);
}
