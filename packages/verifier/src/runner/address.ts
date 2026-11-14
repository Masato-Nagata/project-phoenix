// The address check of the Experiment_Runner (R9.16, R9.17, R18.2, R18.3; task 2.15).
//
// The runner may reach the Legacy_App only through the loopback-published Reverse_Proxy address or the configured internal Test_API
// address. Both are fixed by the run configuration; the AI supplies neither.
//
// The configured address is accepted only when its text equals, character for character, the canonical text of one of the two
// addresses (decision of 2026-11-12). The URL parser is NOT used to decide: it would accept other spellings of the same address
// (`0x7f.0.0.1`, `2130706433`, `127.1`, a port written `08056`, upper case, a trailing slash, a full-width host name). The parser is
// used only to read the parts of a canonical text. The names are resolved by the container network at connection time; the check
// compares names, not the addresses that the names resolve to (a residual risk, see the design). The adapter follows no redirect.
// A request target is accepted only when it resolves, byte for byte, to the configured origin plus the given path.
import type { Result } from "../policy/types.js";

/** `127.0.0.1:8056 -> reverse-proxy:8080` of `infra/docker-compose.yml`; and the proxy on the `phoenix-discovery-lab` network. */
export const DEFAULT_LOOPBACK_ORIGIN = "http://127.0.0.1:8056";
export const DEFAULT_INTERNAL_ORIGIN = "http://reverse-proxy:8080";

export interface AddressPolicy {
  /** The loopback-published Reverse_Proxy address. The host must be 127.0.0.1. */
  readonly loopbackOrigin: string;
  /** The configured internal Test_API address. */
  readonly internalOrigin: string;
}

export const DEFAULT_ADDRESS_POLICY: AddressPolicy = Object.freeze({ loopbackOrigin: DEFAULT_LOOPBACK_ORIGIN, internalOrigin: DEFAULT_INTERNAL_ORIGIN });

function parseOrigin(text: unknown): URL | undefined {
  if (typeof text !== "string" || text.length === 0 || text.length > 256) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
  if (url.pathname !== "/" || url.hostname === "") return undefined;
  return url;
}

/** Printable ASCII only: no control character, no space, no non-ASCII character. */
const ASCII_TEXT = /^[\x21-\x7e]+$/;

/** An origin in its canonical text: ASCII, and equal to what the parser gives back (lower case, no trailing slash, no explicit default port). */
function canonicalOrigin(text: unknown): URL | undefined {
  if (typeof text !== "string" || !ASCII_TEXT.test(text)) return undefined;
  const url = parseOrigin(text);
  return url !== undefined && url.origin === text ? url : undefined;
}

/**
 * Checks the policy itself: both texts are canonical origins, the loopback address is 127.0.0.1, and the internal address is a named
 * host that is not a loopback or wildcard address.
 */
export function validateAddressPolicy(policy: AddressPolicy): Result<{ readonly loopback: string; readonly internal: string }, string[]> {
  const errors: string[] = [];
  const lo = canonicalOrigin((policy as Partial<AddressPolicy> | undefined)?.loopbackOrigin);
  const inner = canonicalOrigin((policy as Partial<AddressPolicy> | undefined)?.internalOrigin);
  if (lo === undefined || lo.hostname !== "127.0.0.1") errors.push("loopback_origin_invalid");
  if (inner === undefined) errors.push("internal_origin_invalid");
  else if (/^(?:localhost|0\.0\.0\.0|\[.*\]|127\..*|::1?)$/i.test(inner.hostname)) errors.push("internal_origin_is_loopback_or_wildcard");
  if (errors.length > 0 || lo === undefined || inner === undefined) return { ok: false, error: errors };
  return { ok: true, value: { loopback: lo.origin, internal: inner.origin } };
}

/**
 * Checks the configured Test_API address (R9.17, R18.3) by exact text equality with one of the two canonical addresses. Any other
 * text is refused, also a text that the URL parser would turn into one of them. Returns the address, or the refusal. The caller
 * records the configured value and sends no request on a refusal.
 */
export function checkTestApiAddress(address: string, policy: AddressPolicy): Result<string, string> {
  const rules = validateAddressPolicy(policy);
  if (!rules.ok) return { ok: false, error: "address_policy_invalid" };
  if (typeof address !== "string" || (address !== rules.value.loopback && address !== rules.value.internal)) return { ok: false, error: "address_not_allowed" };
  return { ok: true, value: address };
}

/** The characters of a request path after the placeholders are replaced: those of the Experiment schema, without the braces. No query, fragment, or percent-encoding. */
const REQUEST_PATH = /^\/[A-Za-z0-9_./-]*$/;

/**
 * The target of a request: the origin plus the path, accepted only if the URL parser leaves it exactly as written. A path that
 * carries an authority (`//host`), a scheme, a backslash, a dot segment, or anything the parser would rewrite is refused.
 */
export function resolveRequestTarget(origin: string, path: string): Result<URL, string> {
  if (typeof path !== "string" || !REQUEST_PATH.test(path) || path.startsWith("//")) return { ok: false, error: "address_not_allowed" };
  let url: URL;
  try {
    url = new URL(path, origin);
  } catch {
    return { ok: false, error: "address_not_allowed" };
  }
  if (url.origin !== origin || url.href !== `${origin}${path}`) return { ok: false, error: "address_not_allowed" };
  return { ok: true, value: url };
}