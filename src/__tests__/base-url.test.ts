import { describe, expect, it } from "vitest";

import { createAppClient, defineModuleClient, platformBaseUrl } from "../index.js";

describe("platformBaseUrl", () => {
  it("composes the app dispatch root from the API URL and app slug", () => {
    expect(platformBaseUrl({ apiUrl: "https://api.example.org", appSlug: "example-edu" })).toBe(
      "https://api.example.org/v1/apps/app/example-edu",
    );
  });

  it("strips a trailing slash and preserves a deployment prefix", () => {
    expect(platformBaseUrl({ apiUrl: "https://api.example.org/", appSlug: "example-edu" })).toBe(
      "https://api.example.org/v1/apps/app/example-edu",
    );
    expect(platformBaseUrl({ apiUrl: "http://localhost:8080/edge/", appSlug: "example-edu" })).toBe(
      "http://localhost:8080/edge/v1/apps/app/example-edu",
    );
  });

  it("rejects a relative API URL", () => {
    expect(() => platformBaseUrl({ apiUrl: "/v1", appSlug: "example-edu" })).toThrow(
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
    expect(() => platformBaseUrl({ apiUrl, appSlug: "example-edu" })).toThrow(TypeError);
  });

  it("rejects an invalid app slug", () => {
    expect(() => platformBaseUrl({ apiUrl: "https://api.example.org", appSlug: "Example_Edu" })).toThrow(
      /appSlug must be a lowercase app slug/u,
    );
  });

  // The APP slug rule (api-platform internal/shared/slugs/slugs.go) is wider
  // than the module catalog slug rule: 1-39 chars, may start with a digit.
  it.each([
    "1abc",
    "1edu",
    "a",
    "7",
    "example-edu-test",
    `a${"b".repeat(16)}`,
    `a${"b".repeat(38)}`,
    "a722a8a8-d413-435b-b21b-f4cbacb5ef73",
  ])("accepts app slug %j", (appSlug) => {
    expect(appSlug.length).toBeLessThanOrEqual(39);
    expect(platformBaseUrl({ apiUrl: "https://api.example.org", appSlug })).toBe(
      `https://api.example.org/v1/apps/app/${appSlug}`,
    );
  });

  it("rejects a 40-character app slug", () => {
    const appSlug = `a${"b".repeat(39)}`;
    expect(appSlug).toHaveLength(40);
    expect(() => platformBaseUrl({ apiUrl: "https://api.example.org", appSlug })).toThrow(TypeError);
  });

  it.each([
    "",
    "EXAMPLE-EDU",
    "Example",
    "example_edu",
    "-example",
    "example/edu",
    "../edu",
    "example edu",
    "example.edu",
  ])("rejects app slug %j", (appSlug) => {
    expect(() => platformBaseUrl({ apiUrl: "https://api.example.org", appSlug })).toThrow(TypeError);
  });

  it("rejects a non-object argument before reading either field", () => {
    expect(() => platformBaseUrl(null as never)).toThrow(/options must be an object/u);
  });

  it("feeds createAppClient the scope-before-module platform shape end to end", async () => {
    const calls: string[] = [];
    const client = createAppClient({
      baseUrl: platformBaseUrl({ apiUrl: "https://api.example.org", appSlug: "example-edu" }),
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
      "https://api.example.org/v1/apps/app/example-edu/public/user-core/me",
    ]);
  });
});
