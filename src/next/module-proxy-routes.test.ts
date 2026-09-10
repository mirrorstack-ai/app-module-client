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

  it("never replays the app's own cookie upstream", async () => {
    const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
    const r = routes("c", fetchMock);

    await r.GET(
      new Request("https://app.example.com/x", { headers: { cookie: "ms_member_session=abc", "x-keep": "1" } }),
      ctx("a", "b"),
    );
    const sent = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(sent.get("cookie")).toBeNull();
    expect(sent.get("x-keep")).toBe("1");
  });

  it("passes the upstream status through rather than flattening it", async () => {
    const r = routes("c", (async () => new Response('{"error":"too_large"}', { status: 413 })) as unknown as typeof globalThis.fetch);
    const response = await r.PUT(new Request("https://app.example.com/x", { method: "PUT" }), ctx("a", "b"));
    expect(response.status).toBe(413);
    expect(await response.text()).toBe('{"error":"too_large"}');
  });
});
