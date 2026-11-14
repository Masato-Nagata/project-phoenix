// Path folding for the deny rules (design: "Matching rules", "Deny after folding"; R8.4, R8.5).
//
// foldPath is used only for deny decisions. The allow decision compares the path as received (R8.1).
//
// Steps: replace "\" with "/"; percent-decode repeatedly (at most 3 rounds; only the triplets that stand for an
// ASCII character are decoded, every other sequence stays as it is); lowercase; cut at the first "?" or "#";
// collapse repeated "/"; remove a trailing "/".
//
// One deliberate tightening of the design wording: the backslash replacement is repeated after each decode round, so
// "%5Creset" folds like "\reset". This only widens what the deny rules catch.

const ASCII_PERCENT_TRIPLET = /%([0-9a-fA-F]{2})/g;
const MAX_DECODE_ROUNDS = 3;

function decodeRound(s: string): string {
  return s
    .replace(ASCII_PERCENT_TRIPLET, (whole, hex: string) => {
      const n = Number.parseInt(hex, 16);
      return n < 0x80 ? String.fromCharCode(n) : whole;
    })
    .replace(/\\/g, "/");
}

/** The raw path and its decoded forms (at most MAX_DECODE_ROUNDS), each with "\" read as "/". Used by the URL and traversal rules. */
export function decodedForms(raw: string): string[] {
  const forms: string[] = [];
  let current = raw.replace(/\\/g, "/");
  forms.push(current);
  for (let round = 0; round < MAX_DECODE_ROUNDS; round += 1) {
    const next = decodeRound(current);
    if (next === current) break;
    forms.push(next);
    current = next;
  }
  return forms;
}

export function foldPath(p: string): string {
  const forms = decodedForms(p);
  let s = forms[forms.length - 1] ?? "";
  s = s.toLowerCase();
  const cut = s.search(/[?#]/);
  if (cut >= 0) s = s.slice(0, cut);
  s = s.replace(/\/{2,}/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return s === "" ? "/" : s;
}

/** True when the folded path equals a denied path or lies under a denied prefix (a prefix "/x/" also covers "/x"). */
export function isDeniedFolded(
  folded: string,
  deny: { readonly equals: readonly string[]; readonly prefixes: readonly string[] },
): { reset: boolean; namespace: boolean } {
  const reset = deny.equals.some((e) => folded === e);
  const namespace = deny.prefixes.some(
    (pre) => folded.startsWith(pre) || (pre.endsWith("/") && folded === pre.slice(0, -1)),
  );
  return { reset, namespace };
}
