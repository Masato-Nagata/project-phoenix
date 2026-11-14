// The address check of the Experiment_Runner (task 2.15 and 2.17; R9.16, R9.17, R18.2, R18.3).
import { describe, expect, it } from "vitest";
import { DEFAULT_ADDRESS_POLICY, checkTestApiAddress, resolveRequestTarget, validateAddressPolicy } from "../src/index.js";

const policy = DEFAULT_ADDRESS_POLICY;

describe("the configured Test_API address (R9.17, R18.3)", () => {
  it("accepts the loopback-published Reverse_Proxy address and the configured internal address, and nothing else", () => {
    expect(checkTestApiAddress("http://127.0.0.1:8056", policy)).toEqual({ ok: true, value: "http://127.0.0.1:8056" });
    expect(checkTestApiAddress("http://reverse-proxy:8080", policy)).toEqual({ ok: true, value: "http://reverse-proxy:8080" });
    const bad = [
      "http://127.0.0.1:8057", "http://127.0.0.1", "http://localhost:8056", "http://0.0.0.0:8056", "http://[::1]:8056", "http://127.0.0.2:8056",
      "https://127.0.0.1:8056", "http://reverse-proxy:8081", "http://reverse-proxy", "http://evil.example:8080", "http://reverse-proxy.evil.example:8080",
      "http://user@127.0.0.1:8056", "http://user:pw@reverse-proxy:8080", "http://127.0.0.1:8056/x", "http://127.0.0.1:8056/?q=1", "http://127.0.0.1:8056/#f",
      "ftp://127.0.0.1:8056", "127.0.0.1:8056", "", "   ", "http://", "not a url", "http://127.0.0.1:8056@evil.example", "//127.0.0.1:8056",
    ];
    for (const a of bad) expect(checkTestApiAddress(a, policy), JSON.stringify(a)).toEqual({ ok: false, error: "address_not_allowed" });
    for (const a of [undefined, null, 5, {}, []] as unknown[]) expect(checkTestApiAddress(a as string, policy).ok).toBe(false);
  });

  it("only the canonical text is accepted: a trailing slash, and every other spelling that the URL parser would turn into the same address, are refused (decision of 2026-11-12)", () => {
    const spellings = [
      "http://127.0.0.1:8056/", "http://reverse-proxy:8080/",
      "http://0x7f.0.0.1:8056", "http://2130706433:8056", "http://127.1:8056", "http://127.0.0.1:08056", "http://0177.0.0.1:8056", "http://127.000.000.001:8056",
      "HTTP://127.0.0.1:8056", "http://REVERSE-PROXY:8080", "http://Reverse-Proxy:8080", "http://reverse-proxy.:8080", "http://reverse-proxy:08080",
      "http://\uFF52everse-proxy:8080", "http://reverse\u2010proxy:8080", "http://reverse-proxy\u3002:8080", "http://reverse-proxy:8080\u0000",
      " http://127.0.0.1:8056", "http://127.0.0.1:8056 ", "http://127.0.0.1:8056\n", "\thttp://127.0.0.1:8056", "http://127.0.0.1:8056\r\n",
      "http:/127.0.0.1:8056", "http:\\\\127.0.0.1:8056", "http://127.0.0.1:8056\\", "http://127.0.0.1:+8056",
    ];
    for (const a of spellings) expect(checkTestApiAddress(a, policy), JSON.stringify(a)).toEqual({ ok: false, error: "address_not_allowed" });
    // Control: the parser does accept these spellings as the same address, which is why it must not decide.
    for (const a of ["http://0x7f.0.0.1:8056", "http://127.1:8056", "HTTP://127.0.0.1:8056"]) expect(new URL(a).origin).toBe("http://127.0.0.1:8056");
  });

  it("a configured policy with another loopback port or internal name accepts exactly those texts", () => {
    const p = { loopbackOrigin: "http://127.0.0.1:9100", internalOrigin: "http://api-proxy:8081" };
    expect(checkTestApiAddress("http://127.0.0.1:9100", p).ok).toBe(true);
    expect(checkTestApiAddress("http://api-proxy:8081", p).ok).toBe(true);
    expect(checkTestApiAddress("http://127.0.0.1:8056", p).ok).toBe(false);
  });

  it("a policy whose own texts are not canonical is refused: a trailing slash, an explicit default port, upper case, a non-ASCII character", () => {
    for (const p of [
      { loopbackOrigin: "http://127.0.0.1:8056/", internalOrigin: "http://reverse-proxy:8080" },
      { loopbackOrigin: "http://127.0.0.1:8056", internalOrigin: "http://reverse-proxy:8080/" },
      { loopbackOrigin: "http://127.0.0.1:8056", internalOrigin: "http://api-proxy:80" },
      { loopbackOrigin: "http://127.0.0.1:8056", internalOrigin: "HTTP://reverse-proxy:8080" },
      { loopbackOrigin: "http://127.0.0.1:8056", internalOrigin: "http://Reverse-Proxy:8080" },
      { loopbackOrigin: "http://127.0.0.1:8056", internalOrigin: "http://\uFF52everse-proxy:8080" },
      { loopbackOrigin: "http://127.1:8056", internalOrigin: "http://reverse-proxy:8080" },
      { loopbackOrigin: "http://127.0.0.1:8056 ", internalOrigin: "http://reverse-proxy:8080" },
    ]) {
      expect(validateAddressPolicy(p).ok, JSON.stringify(p)).toBe(false);
      expect(checkTestApiAddress("http://127.0.0.1:8056", p)).toEqual({ ok: false, error: "address_policy_invalid" });
    }
  });

  it("refuses a policy whose loopback address is not 127.0.0.1 or whose internal address is a loopback or wildcard address", () => {
    for (const p of [
      { loopbackOrigin: "http://localhost:8056", internalOrigin: "http://reverse-proxy:8080" },
      { loopbackOrigin: "http://10.0.0.1:8056", internalOrigin: "http://reverse-proxy:8080" },
      { loopbackOrigin: "http://127.0.0.1:8056", internalOrigin: "http://localhost:8080" },
      { loopbackOrigin: "http://127.0.0.1:8056", internalOrigin: "http://127.0.0.2:8080" },
      { loopbackOrigin: "http://127.0.0.1:8056", internalOrigin: "http://0.0.0.0:8080" },
      { loopbackOrigin: "http://127.0.0.1:8056", internalOrigin: "https://reverse-proxy:8080" },
      { loopbackOrigin: "", internalOrigin: "" },
    ]) {
      expect(validateAddressPolicy(p).ok, JSON.stringify(p)).toBe(false);
      expect(checkTestApiAddress("http://127.0.0.1:8056", p)).toEqual({ ok: false, error: "address_policy_invalid" });
    }
    expect(validateAddressPolicy(undefined as never).ok).toBe(false);
  });
});

describe("the target of a request (R9.16)", () => {
  const origin = "http://127.0.0.1:8056";
  it("accepts a plain path and gives the URL of the origin", () => {
    for (const path of ["/health", "/reset", "/orders", "/orders/12", "/orders/12/cancel", "/test/orders/3/ship", "/products/1"]) {
      const r = resolveRequestTarget(origin, path);
      expect(r.ok, path).toBe(true);
      if (r.ok) expect(r.value.href).toBe(`${origin}${path}`);
    }
  });

  it("refuses everything that leaves the origin or that the URL parser would rewrite", () => {
    const bad = [
      "//evil.example/x", "///x", "http://evil.example/x", "https://127.0.0.1:8056/x", "evil", "", "orders", "\\x", "/a\\b", "/a/../b", "/a/./b", "/%2e%2e/x", "/%2E/x",
      "/orders?x=1", "/orders#f", "/a b", "/\t/x", "/ä", "/orders/%41", "@evil.example/x", "/@evil.example", ":8056/x",
    ];
    for (const path of bad) {
      expect(resolveRequestTarget(origin, path), JSON.stringify(path)).toEqual({ ok: false, error: "address_not_allowed" });
    }
    expect(resolveRequestTarget(origin, 5 as unknown as string).ok).toBe(false);
  });
});