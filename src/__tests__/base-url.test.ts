import { describe, expect, it } from "vitest";

import { createAppClient, defineModuleClient, platformBaseUrl } from "../index.js";

describe("platformBaseUrl", () => {
  it("composes the app dispatch root from the API URL and app slug", () => {
    expect(platformBaseUrl({ apiUrl: "https://api.example.org", appSlug: "twkpa-edu" })).toBe(
      "https://api.example.org/v1/apps/app/twkpa-edu",
    );
  });

  it("strips a trailing slash and preserves a deployment prefix", () => {
    expect(platformBaseUrl({ apiUrl: "https://api.example.org/", appSlug: "twkpa-edu" })).toBe(
      "https://api.example.org/v1/apps/app/twkpa-edu",
    );
    expect(platformBaseUrl({ apiUrl: "http://localhost:8080/edge/", appSlug: "twkpa-edu" })).toBe(
      "http://localhost:8080/edge/v1/apps/app/twkpa-edu",
    );
  });

  it("rejects a relative API URL", () => {
    expect(() => platformBaseUrl({ apiUrl: "/v1", appSlug: "twkpa-edu" })).toThrow(
      /apiUrl must be an absolute HTTP\(S\) URL/u,
    );
  });

  it.each([
    "",
    "api.example.org",
    "//api.example.org",
    "ftp://api.example.org",
    "https://user:secret@api.example.org",
    "https://api.example.org?token=secret",
    "https://api.example.org#fragment",
    "https://api.example.org/../other",
  ])("rejects API URL %j", (apiUrl) => {
    expect(() => platformBaseUrl({ apiUrl, appSlug: "twkpa-edu" })).toThrow(TypeError);
  });

  it("rejects an invalid app slug", () => {
    expect(() => platformBaseUrl({ apiUrl: "https://api.example.org", appSlug: "Twkpa_Edu" })).toThrow(
      /appSlug must be a lowercase catalog slug/u,
    );
  });

  it.each([
    "",
    "1edu",
    "twkpa/edu",
    "../edu",
    "twkpa edu",
    `a${"b".repeat(16)}`,
    "a722a8a8-d413-435b-b21b-f4cbacb5ef73",
  ])("rejects app slug %j", (appSlug) => {
    expect(() => platformBaseUrl({ apiUrl: "https://api.example.org", appSlug })).toThrow(TypeError);
  });

  it("rejects a non-object argument before reading either field", () => {
    expect(() => platformBaseUrl(null as never)).toThrow(/options must be an object/u);
  });

  it("feeds createAppClient the scope-before-module platform shape end to end", async () => {
    const calls: string[] = [];
    const client = createAppClient({
      baseUrl: platformBaseUrl({ apiUrl: "https://api.example.org", appSlug: "twkpa-edu" }),
      modules: {
        user: defineModuleClient({
          moduleRef: "user-core",
          create: ({ public: publicScope }) => ({ getMe: () => publicScope.get("/me") }),
        }),
      },
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return Response.json({ id: "user-1" });
      }) as typeof fetch,
    });

    await expect(client.modules.user.getMe()).resolves.toEqual({ id: "user-1" });
    expect(calls).toEqual([
      "https://api.example.org/v1/apps/app/twkpa-edu/public/user-core/me",
    ]);
  });
});
