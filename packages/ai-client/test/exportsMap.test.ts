import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const pkgDir = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { exports: Record<string, unknown> };
const require = createRequire(import.meta.url);

describe("package exports map", () => {
  it("publishes the entry point \".\" and nothing else", () => {
    expect(Object.keys(pkg.exports)).toEqual(["."]);
  });

  it("resolves the package name to the built entry through the workspace link", () => {
    expect(require.resolve("@phoenix/ai-client").replaceAll("\\", "/")).toMatch(/packages\/ai-client\/dist\/index\.js$/);
  });

  it("refuses deep imports of internal modules, of the audit config builder, and of source files", () => {
    for (const sub of ["dist/hash.js", "dist/internal/brand.js", "dist/auditConfigBuilder.js", "src/index.ts", "package.json", "dist/mock/mockProvider.js"]) {
      try {
        require.resolve(`@phoenix/ai-client/${sub}`);
        expect.unreachable(sub);
      } catch (e) {
        expect((e as NodeJS.ErrnoException).code, sub).toBe("ERR_PACKAGE_PATH_NOT_EXPORTED");
      }
    }
  });

  it("the package entry source does not export an audit config builder", () => {
    const entry = readFileSync(join(pkgDir, "src", "index.ts"), "utf8");
    expect(entry).not.toMatch(/auditConfigBuilder|AuditConfigBuilder/);
  });
});
