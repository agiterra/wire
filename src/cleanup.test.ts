import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { runCleanup } from "./server";

// AGI-113 #2, part 1 — the cleanup OUTCOME must be truthful.
//
// Measured (torta-caprese, AGI-108): the live log carried
// `webhook_janitor_cleanup_ok` for webhook 119 while GitHub hook 676795468
// stayed active. The cleanup body is client-supplied JS stored on the row at
// REGISTRATION time; rows registered before github-tools started throwing on
// a bad status carry a body that ignores `res.ok` entirely. The gateway
// cannot fix already-stored rows, so it must judge the cleanup itself:
// a delete that came back 4xx/5xx did not delete anything.

let srv: ReturnType<typeof Bun.serve>;
let base: string;
/** Authorization headers the fake API saw, in order. */
const seen: string[] = [];

beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push(req.headers.get("authorization") ?? "");
      if (url.pathname === "/ok") return new Response(null, { status: 204 });
      if (url.pathname === "/gone") return new Response("not found", { status: 404 });
      if (url.pathname === "/unauthorized") return new Response("Bad credentials", { status: 401 });
      if (url.pathname === "/boom") return new Response("nope", { status: 500 });
      return new Response(null, { status: 204 });
    },
  });
  base = `http://localhost:${srv.port}`;
});

afterAll(() => srv.stop(true));

const del = (path: string) =>
  `const res = await fetch(${JSON.stringify("__BASE__")} + ${JSON.stringify(path)}, { method: "DELETE", headers: { Authorization: "Bearer " + secrets.tok } });`;

const code = (path: string) => del(path).replace("__BASE__", base);

describe("AGI-113 #2 — runCleanup reports a cleanup that did not clean up", () => {
  test("a cleanup body that throws still rejects (existing contract — verified, not changed)", async () => {
    await expect(
      runCleanup(`throw new Error("hook delete failed (401)");`, { meta: {}, secrets: {} }),
    ).rejects.toThrow(/401/);
  });

  test("a cleanup that SWALLOWS a 401 must reject — the external hook is still live", async () => {
    await expect(
      runCleanup(code("/unauthorized"), { meta: {}, secrets: { tok: "stale" } }),
    ).rejects.toThrow(/401/);
  });

  test("a swallowed 500 rejects too", async () => {
    await expect(
      runCleanup(code("/boom"), { meta: {}, secrets: { tok: "stale" } }),
    ).rejects.toThrow(/500/);
  });

  test("204 resolves", async () => {
    await expect(runCleanup(code("/ok"), { meta: {}, secrets: { tok: "t" } })).resolves.toBeUndefined();
  });

  test("404 resolves — already gone is the outcome we wanted", async () => {
    await expect(runCleanup(code("/gone"), { meta: {}, secrets: { tok: "t" } })).resolves.toBeUndefined();
  });
});
