import assert from "node:assert/strict";
import { test } from "vitest";

import { createModuleWebTransport } from "../web/runtime.js";

test("web transports isolate app context and route scope", async () => {
  const calls: Array<{ input: string; appId: string | null }> = [];
  const hostFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      input: String(input),
      appId: new Headers(init?.headers).get("x-ms-app-id"),
    });
    return Response.json({ ok: true });
  };

  const first = createModuleWebTransport({
    moduleRef: "user-core",
    apiBase: "/modules/user-core",
    appId: "app-one",
    fetch: hostFetch,
  });
  const second = createModuleWebTransport({
    moduleRef: "user-core",
    apiBase: "/modules/user-core",
    appId: "app-two",
    fetch: hostFetch,
  });

  await first.request("GET", "/platform/users");
  await second.request("GET", "/me");

  assert.deepEqual(calls, [
    { input: "/modules/user-core/platform/users", appId: "app-one" },
    { input: "/modules/user-core/me", appId: "app-two" },
  ]);
});

test("web transport requires host fetch before requesting", async () => {
  const transport = createModuleWebTransport({
    moduleRef: "user-core",
    apiBase: "/modules/user-core",
  });

  await assert.rejects(
    transport.request("GET", "/me"),
    /Module user-core cannot request data before the host supplies fetch/,
  );
});
