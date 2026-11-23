// Task 4.6 W4-B: the runtime version facts (`src/runtimeFacts/versionFacts.ts`). Deterministic and offline.
// Every version, package name and file text below is SYNTHETIC. The host Node.js, the host npm and the host file system are never
// consulted: the port is a fake that answers from memory, and the Node.js value is injected.
// **Validates: Requirements 22.3, 20.6, 20.7**
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildToolVersionsSection } from "../src/manifest/toolVersionsSection.js";
import {
  MAX_DIRECT_DEPENDENCIES,
  PACKAGE_JSON_MAX_BYTES,
  collectRuntimeVersionFacts,
  parseDeclaredDependencies,
  parseInstalledPackageJson,
  parseNodeVersion,
  parseNpmPackageJson,
  processNodeVersion,
  verifyDirectDependencies,
  type PackageJsonReadAnswer,
  type RuntimeVersionReadPort,
} from "../src/runtimeFacts/versionFacts.js";

const CANARY = "canary-secret-value-91x";
const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const codeOf = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);
const ok = (text: string): PackageJsonReadAnswer => ({ kind: "ok", text });
const pkg = (o: Record<string, unknown>): string => JSON.stringify(o);

const NPM_TEXT = pkg({ name: "npm", version: "9.8.7", description: "synthetic" });
const DECLARED = pkg({
  name: "synthetic-runner",
  version: "0.0.0",
  dependencies: { "b-lib": "2.0.1", "@phoenix/inner": "*", "a-lib": "1.2.3", "@scope/c-lib": "3.0.0-rc.1" },
  devDependencies: { "dev-only": "^1.0.0" },
});
const INSTALLED: Record<string, string> = {
  "a-lib": pkg({ name: "a-lib", version: "1.2.3" }),
  "b-lib": pkg({ name: "b-lib", version: "2.0.1" }),
  "@scope/c-lib": pkg({ name: "@scope/c-lib", version: "3.0.0-rc.1" }),
};

interface Script {
  node?: unknown;
  nodeThrows?: boolean;
  npm?: PackageJsonReadAnswer | "throw" | unknown;
  declared?: PackageJsonReadAnswer | "throw" | unknown;
  installed?: Record<string, PackageJsonReadAnswer | "throw" | unknown>;
}
/** A fake port: answers from the script, records every call. Nothing touches a file or a process. */
function fakePort(script: Script = {}): RuntimeVersionReadPort & { calls: string[] } {
  const calls: string[] = [];
  const pick = (v: unknown): never | unknown => {
    if (v === "throw") throw new Error(CANARY);
    return v;
  };
  return {
    calls,
    readNodeVersion() {
      calls.push("node");
      if (script.nodeThrows === true) throw new Error(CANARY);
      return "node" in script ? script.node : "1.2.3";
    },
    readNpmPackageJson() {
      calls.push("npm");
      return pick("npm" in script ? script.npm : ok(NPM_TEXT)) as PackageJsonReadAnswer;
    },
    readDeclaredPackageJson() {
      calls.push("declared");
      return pick("declared" in script ? script.declared : ok(DECLARED)) as PackageJsonReadAnswer;
    },
    readInstalledPackageJson(name: string) {
      calls.push(`installed:${name}`);
      const given = script.installed?.[name];
      if (script.installed !== undefined && name in script.installed) return pick(given) as PackageJsonReadAnswer;
      const text = INSTALLED[name];
      return text === undefined ? { kind: "absent" } : ok(text);
    },
  };
}

describe("Node.js version", () => {
  it("accepts major.minor.patch from the injected value, never the host value", () => {
    expect(parseNodeVersion("26.13.0")).toEqual({ ok: true, value: "26.13.0" });
    const r = collectRuntimeVersionFacts(fakePort({ node: "7.8.9" }));
    expect(r.ok && r.value.node).toBe("7.8.9");
    expect(r.ok && r.value.node).not.toBe(process.versions.node);
  });

  it("refuses an empty, malformed, missing or non-string value", () => {
    for (const bad of ["", "v1.2.3", "1.2", "1.2.3.4", "1.2.3-rc.1", "01.2.3", " 1.2.3", "1.2.3\n", "latest", "^1.2.3", undefined, null, 1, {}, ["1.2.3"]]) {
      expect(codeOf(parseNodeVersion(bad)), String(bad)).toBe("node_invalid");
    }
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ node: undefined })))).toBe("node_invalid");
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ node: "" })))).toBe("node_invalid");
  });

  it("refuses a port that throws, without echoing the thrown text", () => {
    const r = collectRuntimeVersionFacts(fakePort({ nodeThrows: true }));
    expect(r).toEqual({ ok: false, error: { code: "node_read_failed" } });
    expect(JSON.stringify(r)).not.toContain(CANARY);
  });

  it("processNodeVersion reads an own data property and never runs a getter", () => {
    expect(processNodeVersion({ node: "3.2.1" })).toBe("3.2.1");
    expect(typeof processNodeVersion(process.versions)).toBe("string");
    let ran = false;
    const g = {};
    Object.defineProperty(g, "node", { enumerable: true, get: () => ((ran = true), "1.2.3") });
    expect(processNodeVersion(g)).toBeUndefined();
    expect(ran).toBe(false);
    for (const bad of [undefined, null, 1, "x"]) expect(processNodeVersion(bad)).toBeUndefined();
  });
});

describe("npm version", () => {
  it("takes the version of the installed npm package file", () => {
    expect(parseNpmPackageJson(NPM_TEXT)).toEqual({ ok: true, value: "9.8.7" });
    const r = collectRuntimeVersionFacts(fakePort());
    expect(r.ok && r.value.npm).toBe("9.8.7");
  });

  it("ignores a packageManager declaration: the declared package file never supplies npm", () => {
    const declared = pkg({ packageManager: "npm@5.5.5", dependencies: { "a-lib": "1.2.3" } });
    const r = collectRuntimeVersionFacts(fakePort({ declared: ok(declared), npm: ok(pkg({ name: "npm", version: "9.8.7", packageManager: "npm@5.5.5" })) }));
    expect(r.ok && r.value.npm).toBe("9.8.7");
    // no installed npm file -> no npm fact, even though the declaration names one
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: ok(declared), npm: { kind: "absent" } })))).toBe("npm_read_absent");
  });

  it("is fail closed when npm cannot be read, and never starts a command", () => {
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ npm: { kind: "absent" } })))).toBe("npm_read_absent");
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ npm: { kind: "error" } })))).toBe("npm_read_failed");
    const t = collectRuntimeVersionFacts(fakePort({ npm: "throw" }));
    expect(t).toEqual({ ok: false, error: { code: "npm_read_failed" } });
    expect(JSON.stringify(t)).not.toContain(CANARY);
    for (const bad of [undefined, null, "x", { kind: "ok" }, { kind: "ok", text: 1 }, { kind: "ok", text: "{}", extra: 1 }, { kind: "other" }]) {
      expect(codeOf(collectRuntimeVersionFacts(fakePort({ npm: bad }))), JSON.stringify(bad)).toBe("npm_read_answer_invalid");
    }
  });

  it("refuses a file that is not npm, has no valid version, or is not strict JSON", () => {
    expect(codeOf(parseNpmPackageJson(pkg({ name: "not-npm", version: "1.2.3" })))).toBe("npm_name_mismatch");
    expect(codeOf(parseNpmPackageJson(pkg({ version: "1.2.3" })))).toBe("npm_name_mismatch");
    for (const bad of ["v1.2.3", "1.2", "^1.2.3", "1.2.3-rc.1", "", "latest", 1, null]) {
      expect(codeOf(parseNpmPackageJson(pkg({ name: "npm", version: bad }))), String(bad)).toBe("npm_version_invalid");
    }
    expect(codeOf(parseNpmPackageJson(pkg({ name: "npm" })))).toBe("npm_version_invalid");
    for (const bad of ["", "{", "not json", '{"name":"npm","name":"npm","version":"1.2.3"}', "\ufeff" + NPM_TEXT]) expect(codeOf(parseNpmPackageJson(bad)), bad).toBe("npm_json_invalid");
    for (const bad of ["[]", "1", "null", '"npm"']) expect(codeOf(parseNpmPackageJson(bad)), bad).toBe("npm_json_not_object");
    expect(codeOf(parseNpmPackageJson(undefined))).toBe("npm_json_invalid");
    expect(codeOf(parseNpmPackageJson(" ".repeat(PACKAGE_JSON_MAX_BYTES + 1)))).toBe("npm_json_invalid");
  });
});

describe("direct dependencies: collection", () => {
  it("collects the installed versions of the declared direct dependencies, sorted by name", () => {
    const port = fakePort();
    const r = collectRuntimeVersionFacts(port);
    expect(r).toEqual({ ok: true, value: { node: "1.2.3", npm: "9.8.7", dependencies: { "@scope/c-lib": "3.0.0-rc.1", "a-lib": "1.2.3", "b-lib": "2.0.1" } } });
    if (!r.ok) return;
    expect(Object.keys(r.value.dependencies)).toEqual(["@scope/c-lib", "a-lib", "b-lib"]);
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.dependencies)).toBe(true);
    // one read per file, in a fixed order, no retry
    expect(port.calls).toEqual(["node", "npm", "declared", "installed:b-lib", "installed:a-lib", "installed:@scope/c-lib"]);
  });

  it("leaves out the workspace scope and development dependencies: they are neither read nor listed", () => {
    const port = fakePort();
    const r = collectRuntimeVersionFacts(port);
    expect(r.ok).toBe(true);
    expect(port.calls.some((c) => c.includes("@phoenix/") || c.includes("dev-only"))).toBe(false);
    expect(r.ok && Object.keys(r.value.dependencies).some((n) => n.startsWith("@phoenix/") || n === "dev-only")).toBe(false);
    // the workspace entry may carry any value: it is not interpreted
    for (const spec of ["*", "workspace:*", "file:../x", "", 5]) {
      const declared = pkg({ dependencies: { "a-lib": "1.2.3", "@phoenix/inner": spec } });
      expect(collectRuntimeVersionFacts(fakePort({ declared: ok(declared) })).ok, String(spec)).toBe(true);
    }
  });

  it("refuses a declared dependency that is not installed", () => {
    const r = collectRuntimeVersionFacts(fakePort({ declared: ok(pkg({ dependencies: { "a-lib": "1.2.3", "missing-lib": "1.0.0" } })) }));
    expect(r).toEqual({ ok: false, error: { code: "installed_read_absent", index: 1 } });
    expect(JSON.stringify(r)).not.toContain("missing-lib");
  });

  it("refuses an installed version that differs from the declared exact version", () => {
    const r = collectRuntimeVersionFacts(fakePort({ installed: { "a-lib": ok(pkg({ name: "a-lib", version: "1.2.4" })) } }));
    expect(codeOf(r)).toBe("version_mismatch");
    const lower = collectRuntimeVersionFacts(fakePort({ installed: { "a-lib": ok(pkg({ name: "a-lib", version: "1.2.2" })) } }));
    expect(codeOf(lower)).toBe("version_mismatch");
  });

  it("refuses an installed file that names another package or has no exact version", () => {
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ installed: { "a-lib": ok(pkg({ name: "b-lib", version: "1.2.3" })) } })))).toBe("installed_name_mismatch");
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ installed: { "a-lib": ok(pkg({ version: "1.2.3" })) } })))).toBe("installed_name_mismatch");
    for (const bad of ["^1.2.3", "1.x", "latest", "", "1.2", 1, null]) {
      expect(codeOf(collectRuntimeVersionFacts(fakePort({ installed: { "a-lib": ok(pkg({ name: "a-lib", version: bad })) } }))), String(bad)).toBe("installed_version_invalid");
    }
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ installed: { "a-lib": ok(pkg({ name: "a-lib" })) } })))).toBe("installed_version_invalid");
  });

  it("refuses a declared version that is a range, a tag, a protocol or empty (nothing is interpreted)", () => {
    for (const bad of ["^1.2.3", "~1.2.3", "1.x", "*", "latest", ">=1.0.0", "", "1.2", "github:a/b", "file:../a", "npm:other@1.2.3", "workspace:*", 1, null]) {
      const r = collectRuntimeVersionFacts(fakePort({ declared: ok(pkg({ dependencies: { "a-lib": bad } })) }));
      expect(r, String(bad)).toEqual({ ok: false, error: { code: "declared_version_not_exact", index: 0 } });
    }
  });

  it("refuses declared names that are not package names", () => {
    for (const bad of ["", "A-Upper", "has space", "../x", "_hidden", ".dot", "x".repeat(215), "__proto__"]) {
      const r = collectRuntimeVersionFacts(fakePort({ declared: ok(JSON.stringify({ dependencies: { [bad]: "1.0.0" } })) }));
      expect(codeOf(r), bad).toBe("declared_name_invalid");
    }
  });

  it("refuses a declared file without direct third-party dependencies, or with a section it does not cover", () => {
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: ok(pkg({ dependencies: {} })) })))).toBe("no_direct_dependencies");
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: ok(pkg({ dependencies: { "@phoenix/inner": "*" } })) })))).toBe("no_direct_dependencies");
    for (const bad of [{}, { dependencies: [] }, { dependencies: "x" }, { dependencies: null }]) {
      expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: ok(pkg(bad)) }))), JSON.stringify(bad)).toBe("declared_dependencies_invalid");
    }
    for (const section of ["optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"]) {
      const text = pkg({ dependencies: { "a-lib": "1.2.3" }, [section]: {} });
      expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: ok(text) }))), section).toBe("declared_section_unsupported");
    }
  });

  it("refuses a duplicate key in a package file (invalid JSON), a file that cannot be read, and answers of the wrong shape", () => {
    const dup = '{"dependencies":{"a-lib":"1.2.3","a-lib":"1.2.3"}}';
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: ok(dup) })))).toBe("declared_json_invalid");
    for (const bad of ["", "{", "not json", "[]", "null"]) {
      expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: ok(bad) }))), bad).toBe(bad === "[]" || bad === "null" ? "declared_json_not_object" : "declared_json_invalid");
      expect(codeOf(collectRuntimeVersionFacts(fakePort({ installed: { "a-lib": ok(bad) } }))), bad).toBe(bad === "[]" || bad === "null" ? "installed_json_not_object" : "installed_json_invalid");
    }
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: { kind: "absent" } })))).toBe("declared_read_absent");
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: { kind: "error" } })))).toBe("declared_read_failed");
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: "throw" })))).toBe("declared_read_failed");
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: 5 })))).toBe("declared_read_answer_invalid");
    expect(collectRuntimeVersionFacts(fakePort({ installed: { "a-lib": { kind: "error" } } }))).toEqual({ ok: false, error: { code: "installed_read_failed", index: 1 } });
    const thrown = collectRuntimeVersionFacts(fakePort({ installed: { "a-lib": "throw" } }));
    expect(thrown).toEqual({ ok: false, error: { code: "installed_read_failed", index: 1 } });
    expect(JSON.stringify(thrown)).not.toContain(CANARY);
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ installed: { "a-lib": { kind: "ok", text: 1 } } })))).toBe("installed_read_answer_invalid");
  });

  it("returns nothing partial and reads no further file after a failure", () => {
    const port = fakePort({ installed: { "b-lib": { kind: "error" } } });
    const r = collectRuntimeVersionFacts(port);
    expect(r.ok).toBe(false);
    expect(port.calls).toEqual(["node", "npm", "declared", "installed:b-lib"]);
  });

  it("refuses an oversized package file", () => {
    const big = pkg({ dependencies: { "a-lib": "1.2.3" }, pad: "x".repeat(PACKAGE_JSON_MAX_BYTES) });
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: ok(big) })))).toBe("declared_json_invalid");
    expect(codeOf(parseInstalledPackageJson(big, "a-lib"))).toBe("installed_json_invalid");
  });
});

describe("direct dependencies: pure check of the two lists", () => {
  const d = (...e: Array<[string, string]>): unknown[] => e.map(([name, version]) => ({ name, version }));

  it("accepts equal lists in any order and lists the installed versions sorted", () => {
    const r = verifyDirectDependencies(d(["b", "1.0.0"], ["a", "2.0.0"]), d(["a", "2.0.0"], ["b", "1.0.0"]));
    expect(r).toEqual({ ok: true, value: { a: "2.0.0", b: "1.0.0" } });
    if (r.ok) expect(Object.keys(r.value)).toEqual(["a", "b"]);
  });

  it("refuses a missing, undeclared, mismatching, duplicate and conflicting entry with a closed code", () => {
    expect(verifyDirectDependencies(d(["a", "1.0.0"], ["b", "1.0.0"]), d(["a", "1.0.0"]))).toEqual({ ok: false, error: { code: "installed_missing", index: 1 } });
    expect(verifyDirectDependencies(d(["a", "1.0.0"]), d(["a", "1.0.0"], ["x", "1.0.0"]))).toEqual({ ok: false, error: { code: "installed_undeclared", index: 1 } });
    expect(verifyDirectDependencies(d(["a", "1.0.0"]), d(["a", "1.0.1"]))).toEqual({ ok: false, error: { code: "version_mismatch", index: 0 } });
    expect(codeOf(verifyDirectDependencies(d(["a", "1.0.0"], ["a", "1.0.0"]), d(["a", "1.0.0"])))).toBe("declared_duplicate");
    expect(codeOf(verifyDirectDependencies(d(["a", "1.0.0"], ["a", "1.0.1"]), d(["a", "1.0.0"])))).toBe("declared_conflict");
    expect(codeOf(verifyDirectDependencies(d(["a", "1.0.0"]), d(["a", "1.0.0"], ["a", "1.0.0"])))).toBe("installed_duplicate");
    expect(codeOf(verifyDirectDependencies(d(["a", "1.0.0"]), d(["a", "1.0.0"], ["a", "1.0.1"])))).toBe("installed_conflict");
    expect(codeOf(verifyDirectDependencies([], []))).toBe("no_direct_dependencies");
  });

  it("refuses a workspace-scope name in either list", () => {
    expect(codeOf(verifyDirectDependencies(d(["@phoenix/x", "1.0.0"]), d(["@phoenix/x", "1.0.0"])))).toBe("internal_dependency_listed");
    expect(codeOf(verifyDirectDependencies(d(["a", "1.0.0"]), d(["a", "1.0.0"], ["@phoenix/x", "1.0.0"])))).toBe("internal_dependency_listed");
  });

  it("refuses lists and entries of the wrong shape, including accessors and extra keys", () => {
    const good = d(["a", "1.0.0"]);
    for (const bad of [undefined, null, "x", {}, new Set(), [undefined], [null], [{}], [{ name: "a" }], [{ name: "a", version: "1.0.0", extra: 1 }], [{ name: "a", version: "^1.0.0" }], [{ name: "A", version: "1.0.0" }], [{ name: 1, version: "1.0.0" }]]) {
      expect(codeOf(verifyDirectDependencies(bad, good)), `declared ${JSON.stringify(bad)}`).toMatch(/^(list_invalid|entry_invalid)$/);
      expect(codeOf(verifyDirectDependencies(good, bad)), `installed ${JSON.stringify(bad)}`).toMatch(/^(list_invalid|entry_invalid)$/);
    }
    let ran = false;
    const entry = { name: "a" };
    Object.defineProperty(entry, "version", { enumerable: true, get: () => ((ran = true), "1.0.0") });
    expect(codeOf(verifyDirectDependencies([entry], good))).toBe("entry_invalid");
    const list: unknown[] = [];
    Object.defineProperty(list, "0", { enumerable: true, get: () => ((ran = true), { name: "a", version: "1.0.0" }) });
    expect(codeOf(verifyDirectDependencies(list, good))).toBe("list_invalid");
    expect(ran).toBe(false);
    const sparse = new Array(1);
    expect(codeOf(verifyDirectDependencies(sparse, good))).toBe("list_invalid");
    const tooMany = Array.from({ length: MAX_DIRECT_DEPENDENCIES + 1 }, (_, i) => ({ name: `p${i}`, version: "1.0.0" }));
    expect(codeOf(verifyDirectDependencies(tooMany, good))).toBe("too_many_dependencies");
  });

  it("does not change its inputs and does not alias them", () => {
    const declared = Object.freeze([Object.freeze({ name: "a", version: "1.0.0" })]);
    const installed = Object.freeze([Object.freeze({ name: "a", version: "1.0.0" })]);
    const before = JSON.stringify([declared, installed]);
    const r = verifyDirectDependencies(declared, installed);
    expect(r.ok).toBe(true);
    expect(JSON.stringify([declared, installed])).toBe(before);
    if (r.ok) expect(() => ((r.value as Record<string, string>)["added"] = "1.0.0")).toThrow();
  });

  it("collection does not change what the port gave and parses declared text without running accessors of the answer", () => {
    const answer = Object.freeze({ kind: "ok" as const, text: DECLARED });
    const port = fakePort({ declared: answer });
    expect(collectRuntimeVersionFacts(port).ok).toBe(true);
    expect(answer.text).toBe(DECLARED);
    let ran = false;
    const getterAnswer = { kind: "ok" };
    Object.defineProperty(getterAnswer, "text", { enumerable: true, get: () => ((ran = true), DECLARED) });
    expect(codeOf(collectRuntimeVersionFacts(fakePort({ declared: getterAnswer })))).toBe("declared_read_answer_invalid");
    expect(ran).toBe(false);
  });
});

describe("no secret, path or value in an error", () => {
  it("never echoes a name, a version, file text or the environment", () => {
    process.env["PHOENIX_TEST_CANARY_W4B"] = CANARY;
    const names = [`${CANARY}-lib`, "a-lib"];
    const cases: Array<[string, Script]> = [
      ["missing", { declared: ok(pkg({ dependencies: { [names[0] as string]: "1.0.0" } })) }],
      ["mismatch", { declared: ok(pkg({ dependencies: { "a-lib": "1.0.0" } })), installed: { "a-lib": ok(pkg({ name: "a-lib", version: `1.0.1+${CANARY}` })) } }],
      ["range", { declared: ok(pkg({ dependencies: { "a-lib": `^${CANARY}` } })) }],
      ["bad json", { declared: ok(`{"dependencies": ${CANARY}`) }],
      ["bad npm", { npm: ok(`{"name":"npm","version":"${CANARY}"}`) }],
      ["bad node", { node: CANARY }],
      ["thrown", { installed: { "a-lib": "throw" } }],
    ];
    try {
      for (const [label, script] of cases) {
        const r = collectRuntimeVersionFacts(fakePort(script));
        expect(r.ok, label).toBe(false);
        const text = JSON.stringify(r);
        expect(text, label).not.toContain(CANARY);
        expect(text, label).not.toMatch(/[\\/]/);
        expect(Object.keys((r as { error: object }).error).every((k) => k === "code" || k === "index"), label).toBe(true);
      }
    } finally {
      delete process.env["PHOENIX_TEST_CANARY_W4B"];
    }
  });
});

describe("agreement with the W3-A toolVersions section", () => {
  it("the facts, with an image id added, are accepted by buildToolVersionsSection and come back equal", () => {
    const facts = collectRuntimeVersionFacts(fakePort());
    expect(facts.ok).toBe(true);
    if (!facts.ok) return;
    const section = buildToolVersionsSection({ ...facts.value, runtimeImageDigest: IMAGE_ID });
    expect(section).toEqual({ ok: true, value: { node: "1.2.3", npm: "9.8.7", dependencies: { "@scope/c-lib": "3.0.0-rc.1", "a-lib": "1.2.3", "b-lib": "2.0.1" }, runtimeImageDigest: IMAGE_ID } });
  });

  it("the facts have exactly the keys W3-A expects, minus the image id (a missing key is refused by W3-A, so none is invented here)", () => {
    const facts = collectRuntimeVersionFacts(fakePort());
    if (!facts.ok) throw new Error("setup");
    expect(Object.keys(facts.value).sort()).toEqual(["dependencies", "node", "npm"]);
    expect(codeOf(buildToolVersionsSection(facts.value))).toBe("input_keys");
  });

  it("the grammars agree with W3-A: what this unit accepts W3-A accepts, and what W3-A refuses this unit refuses", () => {
    const nodeCases = ["1.2.3", "0.0.0", "26.13.0", "v1.2.3", "1.2", "1.2.3-rc.1", "01.2.3", "", " 1.2.3", "latest", "^1.2.3"];
    for (const v of nodeCases) {
      const mine = parseNodeVersion(v).ok;
      const theirs = buildToolVersionsSection({ node: v, npm: "1.2.3", dependencies: { "a-lib": "1.0.0" }, runtimeImageDigest: IMAGE_ID }).ok;
      expect(mine, v).toBe(theirs);
      const npmMine = parseNpmPackageJson(pkg({ name: "npm", version: v })).ok;
      const npmTheirs = buildToolVersionsSection({ node: "1.2.3", npm: v, dependencies: { "a-lib": "1.0.0" }, runtimeImageDigest: IMAGE_ID }).ok;
      expect(npmMine, v).toBe(npmTheirs);
    }
    const depVersions = ["1.0.0", "1.0.0-rc.1", "1.0.0+build.5", "1.0.0-rc.1+b", "^1.0.0", "~1.0.0", "1.x", "*", "latest", "", "1.0", "github:a/b", "v1.0.0", "01.0.0"];
    for (const v of depVersions) {
      const theirs = buildToolVersionsSection({ node: "1.2.3", npm: "1.2.3", dependencies: { "a-lib": v }, runtimeImageDigest: IMAGE_ID }).ok;
      expect(parseDeclaredDependencies(pkg({ dependencies: { "a-lib": v } })).ok, v).toBe(theirs);
      expect(parseInstalledPackageJson(pkg({ name: "a-lib", version: v }), "a-lib").ok, v).toBe(theirs);
    }
    for (const n of ["a-lib", "@scope/x", "A-Upper", "has space", "../x", "_hidden", ".dot", "x".repeat(214), "x".repeat(215)]) {
      const theirs = buildToolVersionsSection({ node: "1.2.3", npm: "1.2.3", dependencies: { [n]: "1.0.0" }, runtimeImageDigest: IMAGE_ID }).ok;
      expect(parseDeclaredDependencies(JSON.stringify({ dependencies: { [n]: "1.0.0" } })).ok, n).toBe(theirs);
    }
  });
});

describe("static properties of the module", () => {
  const source = readFileSync(new URL("../src/runtimeFacts/versionFacts.ts", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

  it("starts no process, reads no file, and reads no environment variable itself", () => {
    expect(code).not.toMatch(/child_process|node:fs|from "fs"|node:net|node:http|node:os|spawn|exec\(|execFile|fetch\(/);
    expect(code).not.toMatch(/process\.env|process\.execPath|process\.cwd|readFileSync|readFile\(/);
  });

  it("imports only the strict JSON parser and the result type", () => {
    const imports = [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../schema/strictParse.js", "../schema/types.js"]);
  });

  it("holds no fixed version value", () => {
    expect(code).not.toMatch(/["'`]\d+\.\d+\.\d+["'`]/);
  });
});
