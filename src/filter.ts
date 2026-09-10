/**
 * Filter VM sandbox — evaluates JS expressions for webhook routing.
 *
 * Filters are JS expressions that return true/false. They receive a context
 * object with { headers, payload } from the inbound webhook.
 *
 * Uses Function constructor (not eval) for slightly better isolation.
 * The expression runs synchronously with a frozen context.
 */

export type FilterContext = Record<string, unknown>;

/**
 * Evaluate a filter expression against a context.
 * Returns true if the filter matches, false otherwise.
 * Returns true if filter is null/empty (no filter = match all).
 */
export function evaluateFilter(
  filter: string | null,
  context: FilterContext,
): boolean {
  if (!filter || !filter.trim()) return true; // no filter = match all

  try {
    const keys = Object.keys(context);
    const values = keys.map((k) => context[k]);
    // Create function with context keys as parameters
    const fn = new Function(...keys, `"use strict"; return !!(${filter})`);
    return fn(...values);
  } catch (e) {
    // Filter error = no match (fail closed)
    return false;
  }
}

/**
 * Evaluate a JS expression and return the raw result (not coerced to boolean).
 * Used for dedup key extraction and other value-returning expressions.
 */
export function evaluateExpression(
  expr: string,
  context: FilterContext,
): unknown {
  const keys = Object.keys(context);
  const values = keys.map((k) => context[k]);
  const fn = new Function(...keys, `"use strict"; return (${expr})`);
  return fn(...values);
}

/**
 * Validate a filter expression without evaluating it.
 * Returns null if valid, error message if invalid.
 */
export function validateFilter(filter: string): string | null {
  try {
    new Function("event", "payload", `"use strict"; return !!(${filter})`);
    return null;
  } catch (e: any) {
    return e.message;
  }
}

/**
 * A stand-in envelope used to smoke-run a filter at WRITE time (AGI-103).
 *
 * It has to be permissive, not empty. Real fleet filters reach deep into a
 * payload — `payload.pull_request.number === 1355`, `payload.labels.map(l =>
 * l.name).includes("bug")` — and those legitimately throw against `{}`, so an
 * empty sample would reject most of the filters actually in use. Every
 * property read, call and iteration on this value yields the value again, and
 * it coerces to 0 / "0" / false-ish comparisons, so a well-formed expression
 * runs to completion no matter how deep it digs.
 *
 * What still throws — and so is still caught — is the class of mistake worth
 * catching: a syntax error, a typo'd identifier (`payloadd.action`,
 * ReferenceError), or calling a real global that isn't a function.
 */
const permissive: any = new Proxy((() => {}) as any, {
  get(_t, prop) {
    if (prop === Symbol.toPrimitive) return () => 0;
    if (prop === Symbol.iterator) return function* () {};
    if (prop === Symbol.toStringTag) return "Object";
    if (prop === "then") return undefined; // never look thenable
    return permissive;
  },
  apply: () => permissive,
  has: () => true,
});

export const SAMPLE_ENVELOPE: FilterContext = { headers: permissive, payload: permissive };

/**
 * Check a filter the way the delivery path will actually run it: compiled with
 * the SAME context keys evaluateFilter uses ({ headers, payload }), then run
 * once against a permissive sample envelope.
 *
 * Returns null when the filter is safe to store, otherwise the engine's own
 * error text (which the PATCH route hands straight back to the caller).
 *
 * This matters because evaluateFilter swallows throws and returns false — a
 * filter that throws is a webhook that silently receives NOTHING. Catching it
 * at write time is the difference between a 400 and a hook that looks healthy
 * for a week. Note this is stricter than validateFilter(), which compiles with
 * the wrong parameter names and therefore only ever catches syntax errors.
 */
export function checkFilter(filter: string, sample: FilterContext = SAMPLE_ENVELOPE): string | null {
  const keys = Object.keys(sample);
  let fn: Function;
  try {
    fn = new Function(...keys, `"use strict"; return !!(${filter})`);
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  try {
    fn(...keys.map((k) => sample[k]));
  } catch (e: any) {
    return String(e?.message ?? e);
  }
  return null;
}
