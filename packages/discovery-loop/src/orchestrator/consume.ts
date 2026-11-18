// Single use of a startup ticket (task 4.4, stage 2; R2.16, R15.16).
// A ticket is consumed by the first `consumeStartup` call that accepts it. The check, the lookup and the registration are synchronous and contain no
// suspension point, so two calls in the same tick cannot both succeed. The set is module-private: nothing exports it or a way to reset it.
import { isStartupApproval } from "../config/startup.js";

const consumed = new WeakSet<object>();

export type ConsumeResult = "ok" | "not_a_startup" | "already_consumed";

/**
 * `not_a_startup`: not an object that stage B issued (a copy, a look-alike, a frozen clone, a Proxy, a primitive, null). Nothing is recorded.
 * `already_consumed`: a real ticket that an earlier call consumed. `ok`: first use; the ticket is recorded as consumed.
 */
export function consumeStartup(x: unknown): ConsumeResult {
  if (!isStartupApproval(x)) return "not_a_startup";
  if (consumed.has(x)) return "already_consumed";
  consumed.add(x);
  return "ok";
}
