/**
 * Lecture brute du format protobuf (sans schéma) : de quoi aller chercher quelques champs numérotés
 * dans les blobs d’Antigravity. Les numéros de champs viennent des descripteurs publiés par agy-reader.
 */

export interface Field {
  n: number;
  /** valeur des champs varint */
  v?: bigint;
  /** contenu des champs de longueur variable (chaîne, sous-message, liste compacte) */
  b?: Uint8Array;
}

function varint(data: Uint8Array, at: number): [bigint, number] | null {
  let value = 0n;
  let shift = 0n;
  let i = at;
  while (i < data.length) {
    const byte = BigInt(data[i]);
    i += 1;
    value |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) return [value, i];
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}

/** Champs de premier niveau d’un message ; s’arrête net sur une donnée illisible. */
export function fields(data: Uint8Array | undefined | null): Field[] {
  const out: Field[] = [];
  if (!data) return out;
  let i = 0;
  while (i < data.length) {
    const key = varint(data, i);
    if (!key) break;
    i = key[1];
    const n = Number(key[0] >> 3n);
    const wire = Number(key[0] & 7n);
    if (!Number.isSafeInteger(n) || n <= 0) break;
    if (wire === 0) {
      const v = varint(data, i);
      if (!v) break;
      out.push({ n, v: v[0] });
      i = v[1];
    } else if (wire === 2) {
      const len = varint(data, i);
      if (!len) break;
      i = len[1];
      const size = Number(len[0]);
      if (!Number.isSafeInteger(size) || size < 0 || i + size > data.length) break;
      out.push({ n, b: data.subarray(i, i + size) });
      i += size;
    } else if (wire === 1) {
      if (i + 8 > data.length) break;
      i += 8;
    } else if (wire === 5) {
      if (i + 4 > data.length) break;
      i += 4;
    } else break;
  }
  return out;
}

export function first(fs: Field[], n: number): Field | undefined {
  return fs.find((f) => f.n === n);
}

export function sub(fs: Field[], n: number): Field[] {
  return fields(first(fs, n)?.b);
}

/** Entier positif d’un champ varint (0 si absent). */
export function int(f: Field | undefined): number {
  if (f?.v === undefined) return 0;
  const n = Number(f.v);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

const decoder = new TextDecoder("utf-8", { fatal: false });

/** Texte d’un champ ; undefined s’il ressemble à du binaire. */
export function str(f: Field | undefined): string | undefined {
  if (!f?.b || f.b.length === 0) return undefined;
  const s = decoder.decode(f.b);
  return /[\u0000-\u0008\u000E-\u001F\u007F�]/.test(s) ? undefined : s;
}

/** Liste compacte de varints (packed repeated). */
export function packed(f: Field | undefined): number[] {
  const out: number[] = [];
  const data = f?.b;
  if (!data) return out;
  let i = 0;
  while (i < data.length) {
    const v = varint(data, i);
    if (!v) break;
    out.push(Number(v[0]));
    i = v[1];
  }
  return out;
}

/** google.protobuf.Timestamp {1: secondes, 2: nanosecondes} en millisecondes (NaN si absent). */
export function timestamp(f: Field | undefined): number {
  if (!f) return NaN;
  if (f.b) {
    const t = fields(f.b);
    const s = first(t, 1)?.v;
    if (s !== undefined) {
      const ms = Number(s) * 1000 + Math.floor(Number(first(t, 2)?.v ?? 0n) / 1e6);
      return ms > 0 ? ms : NaN;
    }
    const text = str(f);
    return text ? Date.parse(text) : NaN;
  }
  if (f.v !== undefined) {
    const raw = Number(f.v);
    return raw > 0 ? (raw < 1e12 ? raw * 1000 : raw) : NaN;
  }
  return NaN;
}
