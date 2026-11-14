// Static dependency analysis for the isolation test (R15.1, R15.7): follows every import of a module, without running
// anything, and reports what it could reach. (Same method as packages/analyzer/test/helpers/importGraph.ts.)
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const SPEC_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

export interface ImportEdge {
  from: string;
  spec: string;
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
    for (const m of readFileSync(file, "utf8").matchAll(SPEC_RE)) {
      const spec = (m[1] ?? m[2]) as string;
      if (spec.startsWith(".")) {
        const target = resolve(dirname(file), spec);
        edges.push({ from: file, spec, target });
        const real = resolveModule(target);
        if (real !== undefined) stack.push(real);
      } else edges.push({ from: file, spec });
    }
  }
  return { files: [...seen].sort(), edges };
}

const FORBIDDEN_SEGMENTS = new Set(["evaluation", "tests", ".kiro", "infra"]);

export function isForbiddenPath(path: string): boolean {
  const parts = path.split(/[\\/]/);
  return parts.some((p) => FORBIDDEN_SEGMENTS.has(p)) || parts[parts.length - 1]?.toLowerCase() === "readme.md";
}

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