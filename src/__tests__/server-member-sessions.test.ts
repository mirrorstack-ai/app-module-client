import { describe, expect, it, vi } from "vitest";
import { MemberSessionError, memberSessions } from "../server/index.js";

const OPTIONS = { apiUrl: "https://api.example.test", appSlug: "twkpa-edu" };

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("memberSessions", () => {
  it("addresses the app's control plane, not a module", () => {
    expect(memberSessions(OPTIONS).url).toBe("https://api.example.test/dispatch/apps/twkpa-edu/member-sessions");
  });

  it("validates its inputs up front", () => {
    expect(() => memberSessions({ ...OPTIONS, apiUrl: "api.example.test" })).toThrow(TypeError);
    expect(() => memberSessions({ ...OPTIONS, apiUrl: "https://u:p@api.example.test" })).toThrow(TypeError);
    expect(() => memberSessions({ ...OPTIONS, appSlug: "Bad Slug" })).toThrow(TypeError);
  });

  it("issues a state inside the provider's 16–256 byte window, never repeating", () => {
    const sessions = memberSessions(OPTIONS);
    const states = new Set(Array.from({ length: 100 }, () => sessions.newState()));
    expect(states.size).toBe(100);
    for (const state of states) {
      const bytes = new TextEncoder().encode(state).length;
      expect(bytes).toBeGreaterThanOrEqual(16);
      expect(bytes).toBeLessThanOrEqual(256);
      expect(state).toMatch(/^[0-9a-f]{32}$/);
    }
  });

  it("exchanges with the v1 envelope and normalizes the identity", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(201, {
        v: 1,
        credential: "mss1_abc",
        identity: { id: "u-1", display_name: "Ada", email: "ada@example.test", avatar_url: null, created_at: "2026-01-01T00:00:00Z", last_sign_in_at: "2026-09-06T00:00:00Z" },
        expiresAt: "2026-09-06T08:00:00Z",
      }),
    );
    const session = await memberSessions({ ...OPTIONS, fetch: fetchMock }).exchange("one-time", "0123456789abcdef");
    expect(session).toEqual({
      credential: "mss1_abc",
      expiresAt: "2026-09-06T08:00:00Z",
      identity: { id: "u-1", displayName: "Ada", email: "ada@example.test", avatarUrl: null, createdAt: "2026-01-01T00:00:00Z", lastSignInAt: "2026-09-06T00:00:00Z" },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/dispatch/apps/twkpa-edu/member-sessions");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ v: 1, code: "one-time", state: "0123456789abcdef" });
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("surfaces the platform's error code on a refused exchange", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: { code: "invalid_handoff", message: "invalid or expired handoff" } }));
    await expect(memberSessions({ ...OPTIONS, fetch: fetchMock }).exchange("stale", "0123456789abcdef"))
      .rejects.toMatchObject({ name: "MemberSessionError", status: 401, code: "invalid_handoff" });
  });

  it("rejects a 2xx that is not a member session", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(201, { v: 1, identity: { id: "u-1" } }));
    await expect(memberSessions({ ...OPTIONS, fetch: fetchMock }).exchange("c", "0123456789abcdef"))
      .rejects.toBeInstanceOf(MemberSessionError);
  });

  it("revokes with the credential as bearer and maps 204 / 401 / other / network", async () => {
    for (const [status, outcome] of [[204, "revoked"], [401, "alreadyInvalid"], [503, "unavailable"]] as const) {
      const fetchMock = vi.fn(async () => new Response(null, { status }));
      await expect(memberSessions({ ...OPTIONS, fetch: fetchMock }).revoke("mss1_abc")).resolves.toBe(outcome);
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe("https://api.example.test/dispatch/apps/twkpa-edu/member-sessions/current");
      expect(init.method).toBe("DELETE");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer mss1_abc");
    }
    const failing = vi.fn(async () => { throw new Error("offline"); });
    await expect(memberSessions({ ...OPTIONS, fetch: failing }).revoke("mss1_abc")).resolves.toBe("unavailable");
  });
});
