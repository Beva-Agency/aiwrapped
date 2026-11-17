/**
 * Lecture SQLite en lecture seule, sans dépendance : module node:sqlite (Node 22.13+ sans option).
 * Sur un Node plus ancien, `sqliteAvailable()` renvoie false et l’outil concerné est signalé dans le terminal.
 */

type Row = Record<string, unknown>;

interface Statement {
  all(...params: unknown[]): Row[];
  iterate?(...params: unknown[]): IterableIterator<Row>;
}

interface DatabaseSync {
  prepare(sql: string): Statement;
  close(): void;
}

type SqliteModule = { DatabaseSync: new (file: string, opts?: Record<string, unknown>) => DatabaseSync };

let mod: SqliteModule | null | undefined;

function load(): SqliteModule | null {
  if (mod !== undefined) return mod;
  // Pour tester le repli des vieux Node : WRAPPEDAI_NO_SQLITE=1.
  if (process.env.WRAPPEDAI_NO_SQLITE === "1") return (mod = null);
  // Node 22 et 23 affichent « SQLite is an experimental feature » au chargement : on coupe ce seul avertissement.
  const emit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : warning?.message;
    if (/sqlite/i.test(String(msg))) return;
    return (emit as (...a: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("node:sqlite") as SqliteModule;
  } catch {
    mod = null;
  } finally {
    process.emitWarning = emit;
  }
  return mod;
}

export function sqliteAvailable(): boolean {
  return load() !== null;
}

export class ReadOnlyDb {
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Ouvre une base en lecture seule ; null si le module manque ou si la base est illisible ou verrouillée. */
  static open(file: string): ReadOnlyDb | null {
    const m = load();
    if (!m) return null;
    try {
      return new ReadOnlyDb(new m.DatabaseSync(file, { readOnly: true }));
    } catch {
      return null;
    }
  }

  /** Parcourt les lignes une par une quand Node le permet (bases de plusieurs Go). */
  each(sql: string, params: unknown[], onRow: (row: Row) => void): void {
    const st = this.db.prepare(sql);
    if (typeof st.iterate === "function") {
      for (const row of st.iterate(...params)) onRow(row);
    } else {
      for (const row of st.all(...params)) onRow(row);
    }
  }

  all(sql: string, ...params: unknown[]): Row[] {
    return this.db.prepare(sql).all(...params);
  }

  /** La table existe-t-elle ? (les schémas changent d’une version à l’autre) */
  hasTable(name: string): boolean {
    return this.all("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?", name).length > 0;
  }

  /** Noms des colonnes d’une table. */
  columns(table: string): Set<string> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return new Set();
    return new Set(this.all(`PRAGMA table_info(${table})`).map((r) => String(r.name)));
  }

  close() {
    try {
      this.db.close();
    } catch {
      /* déjà fermée */
    }
  }
}

/** Valeur texte d’une colonne (TEXT ou BLOB UTF-8). */
export function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v instanceof Uint8Array) return Buffer.from(v).toString("utf8");
  return "";
}
