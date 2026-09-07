import { describe, expect, it, vi } from "vitest";

import { createAppClient } from "../client.js";
import { defineModuleClient } from "../plugin.js";

/** A plugin exposing one call on each scope, so both can be observed. */
const probe = defineModuleClient({
  moduleRef: "user-core",
  create({ public: publicScope, platform }) {
    return {
      publicCall: () => publicScope.get("/me", { responseType: "void" }),
      platformCall: () => platform.get("/users", { responseType: "void" }),
    };
  },
});

function clientWith(options: Record<string, unknown>) {
  const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response(null, { status: 204 }));
  const client = createAppClient({
    baseUrl: "/api/mirrorstack/modules",
    modules: { user: probe },
    fetch: fetch as unknown as typeof globalThis.fetch,
    ...options,
  });
  return { client, fetch };
}

// 🔴 A member credential is PUBLIC-scope authentication.
//
// The generated app client put it in `headers`, which applies to EVERY scope —
// and platform scope rejects a configured Authorization outright. So an app
// holding a signed-in member could not call ANY platform method: a TypeError at
// request time, latent only until the first module client gains a platform-scope
// method. `memberCredential` is the scope-aware way to send it.
describe("memberCredential", () => {
  it("authenticates public scope", async () => {
    const { client, fetch } = clientWith({ memberCredential: "tok-123" });

    await client.modules.user.publicCall();

    const init = fetch.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer tok-123");
  });

  it("does NOT reach platform scope, which would throw", async () => {
    const { client, fetch } = clientWith({ memberCredential: "tok-123" });

    // The platform guard rejects any configured Authorization. Completing at
    // all is the assertion: a static header here would have thrown.
    await expect(client.modules.user.platformCall()).resolves.toBeUndefined();

    const init = fetch.mock.calls[0]![1]!;
    expect(new Headers(init.headers).has("authorization")).toBe(false);
  });

  // The old shape, kept as the regression it is: a credential in `headers`
  // still breaks platform scope, which is why the generator must stop doing it.
  it("shows why a configured header is the wrong home for it", async () => {
    const { client } = clientWith({ headers: { Authorization: "Bearer tok-123" } });

    await expect(client.modules.user.platformCall()).rejects.toThrow(/platformAuth/);
  });
});
