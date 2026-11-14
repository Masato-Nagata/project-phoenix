// Static dependency analysis for the isolation tests (R1.9, R15.7): follows every import of a module (relative or not),
// without running anything, and reports what a Source_Bundler module could reach.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const SPEC_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

export interface ImportEdge {
  from: string;
  spec: string;
  /** Absolute path for a relative specifier (it may not exist), undefined for a bare specifier. */
  target?: string;
}

export interface ImportGraph {
  files: string[];
  edges: ImportEdge[];
}

function resolveModule(target: string): string | undefined {
  const base = target.replace(/\.js$/, "");
  for (const c of [`${base}.ts`, resolve(base, "index.ts")]) if (existsSync(c)) return c;
  return undefined;
}

export function scan(entry: string): ImportGraph {
  const seen = new Set<string>();
  const edges: ImportEdge[] = [];
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = (m[1] ?? m[2]) as string;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        edges.push({ from: file, spec, target });
        const real = resolveModule(target);
        if (real !== undefined) stack.push(real);
      } else {
        edges.push({ from: file, spec });
      }
    }
  }
  return { files: [...seen].sort(), edges };
}

const FORBIDDEN_SEGMENTS = new Set(["evaluation", "tests", ".kiro", "infra"]);

/** True if a slash-separated path names one of the forbidden locations or a README.md. */
export function isForbiddenPath(path: string): boolean {
  const parts = path.split(/[\\/]/);
  return parts.some((p) => FORBIDDEN_SEGMENTS.has(p)) || parts[parts.length - 1]?.toLowerCase() === "readme.md";
}

/**
 * Violations of the isolation rule for a graph scanned from modules under `root`:
 * a relative import that leaves `root`, an import whose path names a forbidden location or a README.md, and a
 * non-relative import other than the allowed ones.
 */
export function violations(graph: ImportGraph, root: string, allowedBare: readonly string[]): string[] {
  const out: string[] = [];
  for (const e of graph.edges) {
    if (e.target === undefined) {
      if (!allowedBare.includes(e.spec)) out.push(`non-relative import ${e.spec} in ${relative(root, e.from)}`);
      if (isForbiddenPath(e.spec)) out.push(`forbidden location in specifier ${e.spec}`);
      continue;
    }
    const rel = relative(root, e.target);
    if (rel.startsWith(`..${sep}`) || rel === "..") out.push(`import leaves the package: ${e.spec} in ${relative(root, e.from)}`);
    if (isForbiddenPath(rel) || isForbiddenPath(e.spec)) out.push(`forbidden location: ${e.spec} in ${relative(root, e.from)}`);
  }
  return out;
}

/** Access paths (as recorded by the spy file system) that name a forbidden location, relative to `root`. */
export function forbiddenAccesses(paths: readonly string[], root: string): string[] {
  return paths.filter((p) => isForbiddenPath(p.startsWith(`${root}/`) ? p.slice(root.length + 1) : p) || p.endsWith("/.env"));
}