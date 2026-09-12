import { describe, expect, it, vi } from "vitest";
import { createModuleProxyRoutes } from "./module-proxy-routes.js";

const ctx = (...path: string[]) => ({ params: Promise.resolve({ path }) });

const routes = (credential: string | null, fetchImpl: typeof globalThis.fetch) =>
  createModuleProxyRoutes({
    apiUrl: "https://api.example.com",
    appSlug: "demo",
    readMemberCredential: async () => credential,
    fetch: fetchImpl,
  });

describe("createModuleProxyRoutes", () => {
  it("attaches the member credential and composes the platform path", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = routes("mss1_secret", fetchMock);

    await r.GET(new Request("https://app.example.com/api/mirrorstack/modules/user-core/public/me?x=1"), ctx("user-core", "public", "me"));

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://api.example.com/v1/apps/app/demo/user-core/public/me?x=1");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mss1_secret");
  });

  it("answers 401 without ever calling upstream when signed out", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = routes(null, fetchMock);

    const response = await r.GET(new Request("https://app.example.com/x"), ctx("user-core", "public", "me"));
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // 🔴 Both of these are invisible until they bite, which is why they are
  // pinned here rather than left to each app to rediscover.
  it("sets duplex:half so a streamed upload body can leave at all", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = routes("c", fetchMock);

    await r.POST(
      new Request("https://app.example.com/x", { method: "POST", body: "hi" }),
      ctx("user-core", "public", "avatar"),
    );
    expect((fetchMock.mock.calls[0][1] as (RequestInit & { duplex?: string }) | undefined)?.duplex).toBe("half");
  });

  it("drops content-length and content-encoding from the response", async () => {
    const upstream = new Response("body", {
      status: 200,
      headers: { "content-length": "999", "content-encoding": "gzip", "x-keep": "yes" },
    });
    const r = routes("c", (async () => upstream) as unknown as typeof globalThis.fetch);

    const response = await r.GET(new Request("https://app.example.com/x"), ctx("a", "b"));
    expect(response.headers.get("content-length")).toBeNull();
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("x-keep")).toBe("yes");
  });

  // 🔴 THE REGRESSION THIS FILE EXISTS FOR. A hosted tenant's request reaches
  // the Lambda carrying the CDN edge's own headers. Replaying `cf-connecting-ip`
  // into the platform's Cloudflare zone made Cloudflare answer instead of the
  // API — 403 text/html, "Error reference number: 1000" — so every browser-side
  // module call on a hosted tenant failed with a page no module could parse.
  //
  // Measured against the live API, 12 trials each: clean → 401 JSON 12/12,
  // + cf-connecting-ip → 1000 12/12. Asserted here per header so a failure
  // names the exact one that escaped.
  it.each([
    ["cf-connecting-ip", "35.72.244.132"],
    ["cf-ray", "a39e4d514e15991c-SJC"],
    ["cf-visitor", '{"scheme":"https"}'],
    ["cf-worker", "mirrorstack.app"],
    ["cf-ew-via", "15"],
    ["cdn-loop", "cloudflare; loops=1"],
    ["x-forwarded-for", "1.2.3.4, 35.72.244.132"],
    ["x-forwarded-proto", "https"],
    ["x-forwarded-host", "twkpa-edu.mirrorstack.app"],
    ["x-real-ip", "1.2.3.4"],
    ["true-client-ip", "1.2.3.4"],
    ["forwarded", "for=1.2.3.4;proto=https"],
    ["via", "1.1 cloudflare"],
  ])("never replays the edge header %s upstream", async (name, value) => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = routes("mss1_secret", fetchMock);

    await r.GET(
      new Request("https://app.example.com/x", { headers: { [name]: value, accept: "application/json" } }),
      ctx("user-roles", "public", "me", "roles"),
    );

    const sent = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sent.get(name)).toBeNull();
    // The request still went, and still carries what a module actually needs.
    expect(sent.get("accept")).toBe("application/json");
    expect(sent.get("authorization")).toBe("Bearer mss1_secret");
  });

  // The allowlist is the mechanism, so prove it is an allowlist: a header
  // nobody enumerated is dropped too. This is what a denylist could not do,
  // and the reason the next CDN in front of a tenant cannot reopen the bug.
  it("drops an unknown header nobody thought to name", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = routes("mss1_secret", fetchMock);

    await r.GET(
      new Request("https://app.example.com/x", { headers: { "fastly-client-ip": "9.9.9.9", "x-some-future-edge": "1" } }),
      ctx("user-core", "public", "me"),
    );

    const sent = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sent.get("fastly-client-ip")).toBeNull();
    expect(sent.get("x-some-future-edge")).toBeNull();
  });

  it("still forwards the headers a module call actually needs", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = routes("mss1_secret", fetchMock);

    await r.POST(
      new Request("https://app.example.com/x", {
        method: "POST",
        headers: {
          accept: "application/json",
          "accept-language": "zh-TW",
          "content-type": "application/json",
          "if-none-match": '"etag-1"',
          "user-agent": "Mozilla/5.0",
        },
        body: '{"a":1}',
      }),
      ctx("user-core", "public", "me"),
    );

    const sent = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sent.get("accept")).toBe("application/json");
    expect(sent.get("accept-language")).toBe("zh-TW");
    expect(sent.get("content-type")).toBe("application/json");
    expect(sent.get("if-none-match")).toBe('"etag-1"');
    expect(sent.get("user-agent")).toBe("Mozilla/5.0");
  });

  it("forwards an opted-in extra header, and only that one", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = createModuleProxyRoutes({
      apiUrl: "https://api.example.com",
      appSlug: "demo",
      readMemberCredential: async () => "mss1_secret",
      extraRequestHeaders: ["X-Tenant-Mode"],
      fetch: fetchMock,
    });

    await r.GET(
      new Request("https://app.example.com/x", {
        headers: { "x-tenant-mode": "preview", "x-not-opted-in": "nope", "cf-connecting-ip": "1.2.3.4" },
      }),
      ctx("user-core", "public", "me"),
    );

    const sent = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sent.get("x-tenant-mode")).toBe("preview");
    expect(sent.get("x-not-opted-in")).toBeNull();
    expect(sent.get("cf-connecting-ip")).toBeNull();
  });

  // The escape hatch must not be a way back into the bug.
  it.each(["cf-connecting-ip", "X-Forwarded-For", "cdn-loop", "true-client-ip", "via", "fastly-client-ip"])(
    "refuses %s as an opted-in extra header, at mount rather than in production",
    (name) => {
      expect(() =>
        createModuleProxyRoutes({
          apiUrl: "https://api.example.com",
          appSlug: "demo",
          readMemberCredential: async () => "mss1_secret",
          extraRequestHeaders: [name],
          fetch: vi.fn<typeof globalThis.fetch>(),
        }),
      ).toThrow(TypeError);
    },
  );

  it("never replays the app's own cookie upstream", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = routes("c", fetchMock);

    await r.GET(
      new Request("https://app.example.com/x", {
        headers: { cookie: "ms_member_session=abc", accept: "application/json", "x-keep": "1" },
      }),
      ctx("a", "b"),
    );
    const sent = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sent.get("cookie")).toBeNull();
    // Still proves the request went and carries its own headers — but `accept`
    // rather than an arbitrary `x-keep`. This assertion used to read
    // `x-keep === "1"`, which encoded the OLD denylist contract ("forward
    // everything not named"). Under the allowlist an unenumerated header is
    // dropped by design; an app that needs one names it in extraRequestHeaders.
    expect(sent.get("accept")).toBe("application/json");
    expect(sent.get("x-keep")).toBeNull();
  });

  it("passes the upstream status through rather than flattening it", async () => {
    const r = routes("c", (async () => new Response('{"error":"too_large"}', { status: 413 })) as unknown as typeof globalThis.fetch);
    const response = await r.PUT(new Request("https://app.example.com/x", { method: "PUT" }), ctx("a", "b"));
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('{"error":"too_large"}');
  });
});
