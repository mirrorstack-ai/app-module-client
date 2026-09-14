import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory stand-in for next/headers cookies(): the adapter is the only
// Next-specific code in the package and this is the only Next API it touches.
type CookieRecord = { value: string; options?: Record<string, unknown> };
const jar = new Map<string, CookieRecord>();
vi.mock("next/headers.js", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)!.value } : undefined),
    set: (name: string, value: string, options?: Record<string, unknown>) => { jar.set(name, { value, options }); },
    delete: (name: string) => { jar.delete(name); },
  }),
}));

const { createAuthRoutes } = await import("../next/index.js");
type AuthRoutesOptions = import("../next/auth-routes.js").AuthRoutesOptions;

const ORIGIN = "http://localhost:3010";
const startUrl = vi.fn((provider: string, options: { redirect: string; handoffState: string }) =>
  `https://api.example.test/v1/apps/app/twkpa-edu/public/user-core/start?provider=${provider}&redirect=${encodeURIComponent(options.redirect)}&handoff=true&handoff_state=${options.handoffState}`,
);

function routes(fetchImpl?: typeof fetch) {
  return createAuthRoutes({ apiUrl: "https://api.example.test", appSlug: "twkpa-edu", provider: { startUrl }, fetch: fetchImpl });
}

function location(res: Response): URL {
  return new URL(res.headers.get("location") ?? "", ORIGIN);
}

beforeEach(() => {
  jar.clear();
  startUrl.mockClear();
});

describe("start", () => {
  it("issues a state, stores it HttpOnly, and sends the browser to the provider with the request's own callback", async () => {
    const res = await routes().start.GET(new Request(`${ORIGIN}/api/auth/start?provider=google`));
    expect(res.status).toBe(302);
    const state = jar.get("ms_handoff_state");
    expect(state?.value).toMatch(/^[0-9a-f]{32}$/);
    expect(state?.options).toMatchObject({ httpOnly: true, sameSite: "lax", secure: false, path: "/" });
    expect(startUrl).toHaveBeenCalledWith("google", { redirect: `${ORIGIN}/api/auth/callback`, handoffState: state?.value });
    expect(location(res).host).toBe("api.example.test");
  });

  it("marks the cookie Secure when the app is served over https", async () => {
    await routes().start.GET(new Request("https://twkpa-edu.mirrorstack.app/api/auth/start?provider=google"));
    expect(jar.get("ms_handoff_state")?.options).toMatchObject({ secure: true });
  });

  // 🔴 Behind a TLS-terminating proxy — every production deployment — the
  // request URL carries the INTERNAL hop's scheme, so it reads "http:" while
  // the browser is on HTTPS. Deriving Secure from it alone shipped the session
  // cookie WITHOUT Secure over a connection the user believes is encrypted,
  // and such a cookie is then sent on any later plaintext request to the host.
  it("marks the cookie Secure behind a TLS-terminating proxy", async () => {
    await routes().start.GET(
      new Request(`${ORIGIN}/api/auth/start?provider=google`, {
        headers: { "x-forwarded-proto": "https" },
      }),
    );
    expect(jar.get("ms_handoff_state")?.options).toMatchObject({ secure: true });
  });

  it("reads the FIRST hop of a comma-listed forwarded protocol", async () => {
    await routes().start.GET(
      new Request(`${ORIGIN}/api/auth/start?provider=google`, {
        headers: { "x-forwarded-proto": "https, http" },
      }),
    );
    expect(jar.get("ms_handoff_state")?.options).toMatchObject({ secure: true });
  });

  // The header is consulted only to ADD Secure. A forged value cannot weaken
  // the cookie, and plain local development — which sets no such header and
  // cannot store a Secure cookie — keeps working.
  it("stays insecure on plain http when the proxy says http", async () => {
    await routes().start.GET(
      new Request(`${ORIGIN}/api/auth/start?provider=google`, {
        headers: { "x-forwarded-proto": "http" },
      }),
    );
    expect(jar.get("ms_handoff_state")?.options).toMatchObject({ secure: false });
  });

  it("refuses a missing or malformed provider before issuing anything", async () => {
    const res = await routes().start.GET(new Request(`${ORIGIN}/api/auth/start`));
    expect(res.status).toBe(400);
    expect(jar.size).toBe(0);
    expect(startUrl).not.toHaveBeenCalled();
  });
});

describe("callback", () => {
  const exchangeOk = vi.fn(async () =>
    new Response(JSON.stringify({ v: 1, credential: "mss1_abc", identity: { id: "u-1" }, expiresAt: "2026-09-06T08:00:00Z" }), { status: 201, headers: { "Content-Type": "application/json" } }),
  );

  it("reads the provider's handoff parameter, exchanges with the cookie state, and sets the session", async () => {
    jar.set("ms_handoff_state", { value: "0123456789abcdef0123456789abcdef" });
    const res = await routes(exchangeOk).callback.GET(new Request(`${ORIGIN}/api/auth/callback?ms_handoff=one-time`));
    expect(location(res).pathname).toBe("/");
    expect(JSON.parse(String((exchangeOk.mock.calls[0] as unknown as [string, RequestInit])[1].body)))
      .toEqual({ v: 1, code: "one-time", state: "0123456789abcdef0123456789abcdef" });
    expect(jar.get("ms_member_session")?.value).toBe("mss1_abc");
    expect(jar.get("ms_member_session")?.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
    expect(jar.has("ms_handoff_state")).toBe(false);
  });

  it("ignores a state in the query: the cookie is the binding", async () => {
    jar.set("ms_handoff_state", { value: "0123456789abcdef0123456789abcdef" });
    await routes(exchangeOk).callback.GET(new Request(`${ORIGIN}/api/auth/callback?ms_handoff=one-time&state=attacker`));
    expect(JSON.parse(String((exchangeOk.mock.calls[0] as unknown as [string, RequestInit])[1].body)).state)
      .toBe("0123456789abcdef0123456789abcdef");
  });

  it("does not accept a legacy `code` parameter", async () => {
    jar.set("ms_handoff_state", { value: "0123456789abcdef0123456789abcdef" });
    const res = await routes(exchangeOk).callback.GET(new Request(`${ORIGIN}/api/auth/callback?code=one-time`));
    expect(location(res).search).toBe("?error=missing_code");
    expect(exchangeOk).not.toHaveBeenCalled();
  });

  it("takes the state before redeeming, so a replay finds nothing", async () => {
    const res = await routes(exchangeOk).callback.GET(new Request(`${ORIGIN}/api/auth/callback?ms_handoff=one-time`));
    expect(location(res).search).toBe("?error=expired");
    expect(exchangeOk).not.toHaveBeenCalled();
  });

  it("mints nothing when the platform refuses the exchange", async () => {
    jar.set("ms_handoff_state", { value: "0123456789abcdef0123456789abcdef" });
    const refused = vi.fn(async () => new Response(JSON.stringify({ error: { code: "invalid_handoff" } }), { status: 401 }));
    const res = await routes(refused).callback.GET(new Request(`${ORIGIN}/api/auth/callback?ms_handoff=one-time`));
    expect(location(res).search).toBe("?error=exchange_failed");
    expect(jar.has("ms_member_session")).toBe(false);
  });
});

describe("logout", () => {
  it("revokes on the platform, then clears the cookie", async () => {
    jar.set("ms_member_session", { value: "mss1_abc" });
    const revoked = vi.fn(async () => new Response(null, { status: 204 }));
    const res = await routes(revoked).logout.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST" }));
    const [url, init] = revoked.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/dispatch/apps/twkpa-edu/member-sessions/current");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer mss1_abc");
    expect(jar.has("ms_member_session")).toBe(false);
    expect(res.status).toBe(303);
    expect(location(res).pathname).toBe("/login");
  });

  it("keeps the cookie when the platform cannot revoke, and says so", async () => {
    jar.set("ms_member_session", { value: "mss1_abc" });
    const down = vi.fn(async () => new Response(null, { status: 503 }));
    const res = await routes(down).logout.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST" }));
    expect(jar.get("ms_member_session")?.value).toBe("mss1_abc");
    expect(location(res).pathname + location(res).search).toBe("/?error=logout_unavailable");
  });

  it("with no session just lands on login", async () => {
    const never = vi.fn();
    const res = await routes(never as unknown as typeof fetch).logout.POST(new Request(`${ORIGIN}/api/auth/logout`, { method: "POST" }));
    expect(never).not.toHaveBeenCalled();
    expect(location(res).pathname).toBe("/login");
  });
});

describe("readMemberCredential", () => {
  it("reads the session cookie, null when signed out", async () => {
    const auth = routes();
    expect(await auth.readMemberCredential()).toBeNull();
    jar.set("ms_member_session", { value: "mss1_abc" });
    expect(await auth.readMemberCredential()).toBe("mss1_abc");
  });
});

// --- landingPath: one SSR round trip removed for a first-time member ---
//
// The destination is the whole test. An app whose home page immediately
// redirects a new member to onboarding makes them pay two full server renders
// back to back; deciding here, where the credential already exists, replaces
// the second with a module read. What must never change is that a member who
// signed in successfully lands SOMEWHERE — every failure falls back to home.

describe("callback landingPath", () => {
  const exchangeOk = vi.fn(async () =>
    new Response(
      JSON.stringify({ v: 1, credential: "mss1_abc", identity: { id: "u-1" }, expiresAt: "2026-09-06T08:00:00Z" }),
      { status: 201, headers: { "Content-Type": "application/json" } },
    ),
  );

  async function callbackWith(landingPath?: AuthRoutesOptions["landingPath"]): Promise<Response> {
    jar.set("ms_handoff_state", { value: "0123456789abcdef0123456789abcdef" });
    const auth = createAuthRoutes({
      apiUrl: "https://api.example.test",
      appSlug: "twkpa-edu",
      provider: { startUrl },
      fetch: exchangeOk,
      landingPath,
    });
    return auth.callback.GET(new Request(`${ORIGIN}/api/auth/callback?ms_handoff=one-time`));
  }

  it("sends the member where the resolver says, with the credential it just minted", async () => {
    const landingPath = vi.fn(async (credential: string) =>
      credential === "mss1_abc" ? "/onboarding?status=wait-info" : "/wrong",
    );
    const res = await callbackWith(landingPath);

    expect(landingPath).toHaveBeenCalledWith("mss1_abc");
    expect(location(res).pathname + location(res).search).toBe("/onboarding?status=wait-info");
    // The session is still set: the landing is a destination, not a gate.
    expect(jar.get("ms_member_session")?.value).toBe("mss1_abc");
  });

  // 🔴 The old signature must be untouched. An app that passes no resolver has
  // to redirect byte-for-byte as it did before this option existed.
  it("redirects to home, unchanged, when no resolver is given", async () => {
    const res = await callbackWith(undefined);
    expect(res.status).toBe(302);
    expect(location(res).pathname).toBe("/");
    expect(location(res).search).toBe("");
    expect(jar.get("ms_member_session")?.value).toBe("mss1_abc");
  });

  // 🔴 EVERY REJECTION HERE IS A MEASURED CROSS-ORIGIN ESCAPE. `new URL()`
  // resolves a protocol-relative path and a leading-backslash path against
  // this app's origin as https://evil.com — the backslash because WHATWG
  // treats it as a slash in a special scheme. Whatever feeds a resolver would
  // otherwise be an open-redirect surface on the one route that has just
  // minted a session.
  it.each([
    ["protocol-relative", "//evil.com/x"],
    ["backslash, which WHATWG reads as a slash", "/" + String.fromCharCode(92) + "evil.com"],
    ["absolute url", "https://evil.com/x"],
    ["not a path at all", "onboarding"],
    ["empty", ""],
    ["a control character", "/ok" + String.fromCharCode(0)],
  ])("refuses %s and falls back to home", async (_name, answer) => {
    const res = await callbackWith(() => answer);
    expect(location(res).host).toBe(new URL(ORIGIN).host);
    expect(location(res).pathname).toBe("/");
    expect(jar.get("ms_member_session")?.value).toBe("mss1_abc");
  });

  it("falls back to home when the resolver throws", async () => {
    const res = await callbackWith(() => {
      throw new Error("roles unavailable");
    });
    expect(location(res).pathname).toBe("/");
    expect(jar.get("ms_member_session")?.value).toBe("mss1_abc");
  });

  it("falls back to home when the resolver never answers, and does not wait forever", async () => {
    vi.useFakeTimers();
    try {
      const pending = callbackWith(() => new Promise<string>(() => {}));
      await vi.advanceTimersByTimeAsync(2_000);
      const res = await pending;
      expect(location(res).pathname).toBe("/");
      expect(jar.get("ms_member_session")?.value).toBe("mss1_abc");
    } finally {
      vi.useRealTimers();
    }
  });
});
