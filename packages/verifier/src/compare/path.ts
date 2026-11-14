// Paths for masking and comparison (design: "Masking decisions", item 3).
//
// A mask entry is `a.b`, `[n]`, or `[*]` segments (a leading index is allowed because a body may be a list, and `[*]`
// stands for any index). A predicted path is concrete (the M1 `PATH_PATTERN`: a name first, then `.name` or `[n]`).
export type Segment =
  | { readonly kind: "key"; readonly name: string }
  | { readonly kind: "index"; readonly n: number }
  | { readonly kind: "any" };

const KEY = /^[A-Za-z_][A-Za-z0-9_]*/;
const MAX_PATH_LENGTH = 128;

function tokenize(s: string, mask: boolean): Segment[] | undefined {
  if (s.length === 0 || s.length > MAX_PATH_LENGTH) return undefined;
  const index = mask ? /^\[(0|[1-9][0-9]{0,3}|\*)\]/ : /^\[([0-9]{1,4})\]/;
  const out: Segment[] = [];
  let i = 0;
  while (i < s.length) {
    if (s.charAt(i) === "[") {
      if (i === 0 && !mask) return undefined;
      const m = index.exec(s.slice(i));
      if (m === null) return undefined;
      out.push(m[1] === "*" ? { kind: "any" } : { kind: "index", n: Number(m[1]) });
      i += m[0].length;
      continue;
    }
    if (i > 0) {
      if (s.charAt(i) !== ".") return undefined;
      i += 1;
    }
    const m = KEY.exec(s.slice(i));
    if (m === null) return undefined;
    out.push({ kind: "key", name: m[0] });
    i += m[0].length;
  }
  return out;
}

/** Parses a mask entry. Undefined when it is not valid. */
export const parseMaskPattern = (s: string): Segment[] | undefined => tokenize(s, true);

/** Parses a concrete predicted path. Undefined when it is not valid. */
export const parseConcretePath = (s: string): Segment[] | undefined => tokenize(s, false);

function segmentCovers(pattern: Segment, concrete: Segment): boolean {
  switch (pattern.kind) {
    case "key":
      return concrete.kind === "key" && concrete.name === pattern.name;
    case "index":
      return concrete.kind === "index" && concrete.n === pattern.n;
    case "any":
      return concrete.kind === "index";
  }
}

/** True if the pattern equals the concrete path or is a leading part of it (the path lies below the pattern). */
export function patternCovers(pattern: readonly Segment[], concrete: readonly Segment[]): boolean {
  if (pattern.length > concrete.length) return false;
  for (let i = 0; i < pattern.length; i += 1) {
    if (!segmentCovers(pattern[i] as Segment, concrete[i] as Segment)) return false;
  }
  return true;
}