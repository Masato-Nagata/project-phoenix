// Task 4.1, stage A: the validator performs no I/O. A static check of the source of the stage A modules, with a positive control.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Names that would give a module a side effect or a source of non-determinism. The import list is checked separately. */
const FORBIDDEN: readonly { id: string; re: RegExp }[] = [
  { id: "node:fs", re: /node:fs|from\s+["']fs["']/ },
  { id: "node:net", re: /node:net|node:dgram|node:dns|node:tls/ },
  { id: "node:child_process", re: /node:child_process|node:worker_threads|node:cluster/ },
  { id: "node:http", re: /node:https?|node:http2/ },
  { id: "node:os", re: /node:os|node:process/ },
  { id: "process", re: /\bprocess\b/ },
  { id: "Date", re: /\bDate\b/ },
  { id: "Math.random", re: /Math\.random|crypto\.getRandomValues|randomUUID|randomBytes/ },
  { id: "performance", re: /\bperformance\b|hrtime/ },
  { id: "fetch", re: /\bfetch\s*\(|XMLHttpRequest|WebSocket/ },
  { id: "dynamic import", re: /\bimport\s*\(/ },
  { id: "timers", re: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/ },
];
const ALLOWED_IMPORTS = new Set(["../schema/validator.js", "../schema/types.js", "./limits.js"]);

function violations(source: string): string[] {
  const found = FORBIDDEN.filter((f) => f.re.test(source)).map((f) => f.id);
  for (const m of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)) {
    if (!ALLOWED_IMPORTS.has(m[1] as string)) found.push(`import ${m[1]}`);
  }
  return found;
}
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("stage A performs no I/O", () => {
  it("the validator module and its constants use no file, network, process, clock or random source and import only the schema layer", () => {
    expect(violations(read("../src/config/runConfig.ts"))).toEqual([]);
    expect(violations(read("../src/config/limits.ts"))).toEqual([]);
  });
  it("positive control: the checker reports each forbidden use in a fixture", () => {
    for (const bad of [
      'import { readFileSync } from "node:fs";',
      'import net from "node:net";',
      "const t = Date.now();",
      "const r = Math.random();",
      "const e = process.env.X;",
      'await import("node:child_process");',
      'import x from "../store/index.js";',
      "setTimeout(() => 1, 1);",
      "await fetch(url);",
    ]) {
      expect(violations(bad).length, bad).toBeGreaterThan(0);
    }
    expect(violations('import { a } from "./limits.js";\nconst x = 1;')).toEqual([]);
  });
});