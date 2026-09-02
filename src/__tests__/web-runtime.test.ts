import assert from "node:assert/strict";
import { expectTypeOf, test } from "vitest";

import type { ScopedTransport } from "../transport.js";
import {
  createModuleWebTransport,
  createModuleWebTransports,
} from "../web/runtime.js";
import type {
  CreateModuleWebTransportOptions,
  CreateModuleWebTransportsOptions,
  ModuleWebTransport,
} from "../web/runtime.js";

test("web transports expose the complete scoped transport contract", () => {
  const transports = createModuleWebTransports({
    moduleRef: "user-core",
    apiBase: "/modules/user-core",
    fetch: async () => Response.json({ ok: true }),
  });

  expectTypeOf(transports.public).toEqualTypeOf<ScopedTransport>();
  expectTypeOf(transports.platform).toEqualTypeOf<ScopedTransport>();

  const options = {
    moduleRef: "user-core",
    // @ts-expect-error Application identity is not selected by browser module code.
    appId: "caller-selected-app",
  } satisfies CreateModuleWebTransportsOptions;
  expectTypeOf(options.moduleRef).toEqualTypeOf<string>();
});

test("web transports keep public and platform routes structurally separate", async () => {
  const calls: Array<{ input: string; appId: string | null }> = [];
  const hostFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      input: String(input),
      appId: new Headers(init?.headers).get("x-ms-app-id"),
    });
    return Response.json({ ok: true });
  };

  const transports = createModuleWebTransports({
    moduleRef: "user-core",
    apiBase: "/modules/user-core",
    fetch: hostFetch,
  });

  await transports.platform.get("/users");
  await transports.public.get("/me");

  assert.deepEqual(calls, [
    { input: "/modules/user-core/platform/users", appId: null },
    // The public scope owns its segment, exactly as platform owns /platform.
    // The Go SDK mounts ms.Public routes under /public/.
    { input: "/modules/user-core/public/me", appId: null },
  ]);
});

test("web transports require host fetch before requesting", async () => {
  const transports = createModuleWebTransports({
    moduleRef: "user-core",
    apiBase: "/modules/user-core",
  });

  await assert.rejects(
    transports.public.get("/me"),
    /Module user-core cannot request data before the host supplies fetch/,
  );
});

test("web transports reject an invalid module reference before use", () => {
  assert.throws(
    () => createModuleWebTransports({ moduleRef: "../other-module" }),
    /moduleRef must be a lowercase catalog slug or UUID/u,
  );
});

test("web transports apply the shared parsed-response byte limit", async () => {
  const transports = createModuleWebTransports({
    moduleRef: "user-core",
    maxResponseBytes: 2,
    fetch: async () => new Response("too large"),
  });

  await assert.rejects(
    transports.public.get("/me", { responseType: "text" }),
    /exceeds the 2 byte limit/u,
  );
});

test("web transports retain JSON serialization and explicit response types", async () => {
  const calls: Array<{ body: BodyInit | null | undefined; contentType: string | null }> = [];
  const transports = createModuleWebTransports({
    moduleRef: "user-core",
    apiBase: "/modules/user-core/",
    fetch: async (_input, init) => {
      calls.push({
        body: init?.body,
        contentType: new Headers(init?.headers).get("content-type"),
      });
      return new Response(null, { status: 204 });
    },
  });

  await transports.platform.patch("/settings", {
    json: { sessionLifetimeDays: 30 },
    responseType: "void",
  });

  assert.deepEqual(calls, [{
    body: '{"sessionLifetimeDays":30}',
    contentType: "application/json",
  }]);
});

test("web transports reject raw and JSON bodies together at runtime", async () => {
  const transports = createModuleWebTransports({
    moduleRef: "user-core",
    apiBase: "/modules/user-core",
    fetch: async () => Response.json({ ok: true }),
  });

  await assert.rejects(
    transports.platform.post("/settings", {
      body: "raw",
      json: { sessionLifetimeDays: 30 },
    } as never),
    /cannot contain both json and body/u,
  );
});

test("the v0.1.0 singular transport export remains source and runtime compatible", async () => {
  const calls: Array<{ input: string; appId: string | null }> = [];
  const options: CreateModuleWebTransportOptions = {
    moduleRef: "user-core",
    apiBase: "/modules/user-core",
    appId: "informational-only",
    fetch: async (input, init) => {
      calls.push({
        input: String(input),
        appId: new Headers(init?.headers).get("x-ms-app-id"),
      });
      return Response.json({ ok: true });
    },
  };
  const transport: ModuleWebTransport = createModuleWebTransport(options);

  await transport.request("GET", "/platform/users");
  await transport.text("GET", "/status");

  assert.deepEqual(calls, [
    { input: "/modules/user-core/platform/users", appId: null },
    { input: "/modules/user-core/status", appId: null },
  ]);
});

test("the singular compatibility transport requires host fetch before requesting", async () => {
  const transport = createModuleWebTransport({
    moduleRef: "user-core",
    apiBase: "/modules/user-core",
  });

  await assert.rejects(
    transport.request("GET", "/me"),
    /Module user-core cannot request data before the host supplies fetch/u,
  );
});

test("the public scope owns its segment so modules never spell it", async () => {
  const calls: string[] = [];
  const transports = createModuleWebTransports({
    moduleRef: "users-profile",
    apiBase: "https://dispatch.example/module/users-profile",
    fetch: async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ ok: true });
    },
  });

  await transports.public.get("/profile-fields");

  assert.deepEqual(calls, [
    "https://dispatch.example/module/users-profile/public/profile-fields",
  ]);
});

test("the deprecated singular transport still addresses the module root", async () => {
  // Regression guard for the fix to #10. This transport is documented as
  // serving "public-root and platform-scoped routes", so its callers pass whole
  // paths — the /public segment and root-level routes alike. It must NOT
  // inherit the segment createModuleWebTransports now owns, or /public/x would
  // become /public/public/x and /healthz would become /public/healthz.
  const calls: string[] = [];
  const transport = createModuleWebTransport({
    moduleRef: "users-profile",
    apiBase: "https://dispatch.example/module/users-profile",
    fetch: async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Response.json({ ok: true });
    },
  });

  await transport.request("GET", "/public/profile-fields");
  await transport.request("GET", "/platform/settings");
  await transport.request("GET", "/healthz");

  assert.deepEqual(calls, [
    "https://dispatch.example/module/users-profile/public/profile-fields",
    "https://dispatch.example/module/users-profile/platform/settings",
    "https://dispatch.example/module/users-profile/healthz",
  ]);
});
