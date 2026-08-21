import { createServer } from "node:http";

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  ModuleClientError,
  createAppClient,
  defineModuleClient,
  type CreateAppClientOptions,
  type ModuleClientContext,
  type ModulePluginMap,
} from "../index.js";

function makeFetch(
  implementation: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const mock = vi.fn(implementation);
  return { mock, fetch: mock as unknown as typeof fetch };
}

function makeScopes(
  fetchImplementation: typeof fetch,
  options: Partial<Omit<CreateAppClientOptions<ModulePluginMap>, "baseUrl" | "modules" | "fetch">> = {},
): ModuleClientContext {
  const plugin = defineModuleClient({
    moduleRef: "user-core",
    create: (context) => context,
  });
  return createAppClient({
    baseUrl: "/v1/dispatch/apps/demo",
    modules: { user: plugin },
    fetch: fetchImplementation,
    ...options,
  }).modules.user;
}

describe("request transport", () => {
  it("uses one injected fetch with include credentials and merged request context", async () => {
    const { mock, fetch } = makeFetch(async () =>
      Response.json({ id: "u1" }, { status: 200 }),
    );
    const headerProvider = vi.fn(async (context) => {
      expect(context).toMatchObject({
        moduleRef: "user-core",
        scope: "public",
        method: "POST",
        path: "/users",
        url: "/v1/dispatch/apps/demo/user-core/public/users?notify=true",
        metadata: { app: "demo", operation: "create-user" },
      });
      return { "x-provider": "yes", "x-order": "provider" };
    });
    const scopes = makeScopes(fetch, {
      headers: headerProvider,
      metadata: { app: "demo", shared: true },
    });

    const result = await scopes.public.post<{ id: string }>("/users", {
      query: { notify: true },
      json: { name: "Ada" },
      headers: { "x-order": "caller" },
      metadata: { operation: "create-user" },
    });

    expectTypeOf(result).toEqualTypeOf<{ id: string }>();
    expect(result).toEqual({ id: "u1" });
    expect(headerProvider).toHaveBeenCalledOnce();
    expect(mock).toHaveBeenCalledOnce();
    const [url, init] = mock.mock.calls[0]!;
    expect(url).toBe("/v1/dispatch/apps/demo/user-core/public/users?notify=true");
    expect(init?.credentials).toBe("include");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe('{"name":"Ada"}');
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-provider")).toBe("yes");
    expect(headers.get("x-order")).toBe("caller");
  });

  it("supports raw BodyInit without conflating it with JSON", async () => {
    const { mock, fetch } = makeFetch(async () => new Response("ok"));
    const scopes = makeScopes(fetch);

    await scopes.public.post("/import", { body: "raw=payload", responseType: "text" });
    const init = mock.mock.calls[0]?.[1];
    expect(init?.body).toBe("raw=payload");
    expect(new Headers(init?.headers).has("content-type")).toBe(false);

    await expect(
      scopes.public.post("/ambiguous", {
        body: "raw",
        json: { raw: false },
      } as never),
    ).rejects.toThrow(/both json and body/u);
  });

  it("supports every response type and requires void for an empty success", async () => {
    const responses = [
      Response.json({ ok: true }),
      new Response("hello"),
      new Response("raw"),
      new Response("ignored"),
      new Response(null, { status: 204 }),
      new Response(null, { headers: { "content-length": "0" } }),
    ];
    const { fetch } = makeFetch(async () => responses.shift()!);
    const scopes = makeScopes(fetch);

    await expect(scopes.public.get<{ ok: boolean }>("/json")).resolves.toEqual({ ok: true });
    await expect(scopes.public.get("/text", { responseType: "text" })).resolves.toBe("hello");
    const raw = await scopes.public.get("/response", { responseType: "response" });
    expectTypeOf(raw).toEqualTypeOf<Response>();
    await expect(raw.text()).resolves.toBe("raw");
    await expect(scopes.public.delete("/void", { responseType: "void" })).resolves.toBeUndefined();
    await expect(scopes.public.get("/no-content")).rejects.toThrow(/responseType: "void"/u);
    await expect(scopes.public.get("/zero-length")).rejects.toThrow(/responseType: "void"/u);
  });

  it("rejects invalid response types before the network call", async () => {
    const { mock, fetch } = makeFetch(async () => Response.json({ ok: true }));
    const scopes = makeScopes(fetch);

    await expect(
      scopes.public.get("/invalid", { responseType: "bytes" } as never),
    ).rejects.toThrow(/responseType must be/u);
    expect(mock).not.toHaveBeenCalled();
  });

  it("uses the convenience methods and leaves raw non-2xx responses untouched", async () => {
    const { mock, fetch } = makeFetch(async () =>
      new Response("no", { status: 418, statusText: "Teapot" }),
    );
    const scopes = makeScopes(fetch);

    const response = await scopes.public.fetch("/tea", { method: "PATCH" });
    expect(response.status).toBe(418);
    expect(mock.mock.calls[0]?.[1]?.method).toBe("PATCH");
  });

  it("leaves native network errors unchanged", async () => {
    const networkError = new TypeError("network down");
    const { fetch } = makeFetch(async () => {
      throw networkError;
    });
    const scopes = makeScopes(fetch);

    await expect(scopes.public.get("/me")).rejects.toBe(networkError);
  });
});

describe("typed HTTP errors", () => {
  it("parses nested MirrorStack errors and preserves all response context", async () => {
    const body = {
      error: { code: "invalid_name", message: "name is invalid", details: { field: "name" } },
    };
    const { fetch } = makeFetch(async () =>
      Response.json(body, { status: 422, headers: { "x-request-id": "req-123" } }),
    );
    const scopes = makeScopes(fetch);

    const error = await scopes.platform.get("/users/u1").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ModuleClientError);
    expect(error).toMatchObject({
      name: "ModuleClientError",
      message: "name is invalid",
      status: 422,
      code: "invalid_name",
      details: { field: "name" },
      body,
      requestId: "req-123",
      moduleRef: "user-core",
      scope: "platform",
      path: "/users/u1",
    });
  });

  it("parses the legacy string error envelope and plain text fallback", async () => {
    const responses = [
      Response.json({ error: "not_found", request_id: "body-request" }, { status: 404 }),
      new Response("upstream unavailable", { status: 503 }),
    ];
    const { fetch } = makeFetch(async () => responses.shift()!);
    const scopes = makeScopes(fetch);

    const legacy = await scopes.public.get("/missing").catch((caught: unknown) => caught);
    expect(legacy).toMatchObject({
      code: "not_found",
      requestId: "body-request",
      body: { error: "not_found", request_id: "body-request" },
    });
    const text = await scopes.public.get("/down").catch((caught: unknown) => caught);
    expect(text).toMatchObject({ status: 503, body: "upstream unavailable" });
  });
});

describe("header trust boundary", () => {
  it.each(["x-ms-app-id", "X-MS-Internal-Secret", "x-Ms-platform-token"])(
    "rejects reserved configured header %s",
    (name) => {
      const { fetch } = makeFetch(async () => new Response("ok"));
      expect(() => makeScopes(fetch, { headers: { [name]: "forged" } })).toThrow(/reserved x-ms/u);
    },
  );

  it("rejects reserved provider and caller headers before fetch", async () => {
    const { mock, fetch } = makeFetch(async () => new Response("ok"));
    const providerScopes = makeScopes(fetch, {
      headers: async () => ({ "X-MS-App-ID": "forged" }),
    });
    await expect(providerScopes.public.get("/me")).rejects.toThrow(/reserved x-ms/u);

    const callerScopes = makeScopes(fetch);
    await expect(
      callerScopes.public.get("/me", { headers: { "x-ms-app-role": "owner" } }),
    ).rejects.toThrow(/reserved x-ms/u);
    expect(mock).not.toHaveBeenCalled();
  });

  it("allows public Authorization but rejects it on platform requests", async () => {
    const { mock, fetch } = makeFetch(async () => Response.json({ ok: true }));
    const scopes = makeScopes(fetch);

    await scopes.public.get("/asserted", { headers: { authorization: "Member abc" } });
    expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe("Member abc");
    await expect(
      scopes.platform.get("/me", { headers: { Authorization: "Bearer forged" } }),
    ).rejects.toThrow(/platformAuth/u);
    expect(mock).toHaveBeenCalledTimes(1);
  });
});

describe("platform authentication", () => {
  it("attaches a platform token only to platform-scope requests", async () => {
    const { mock, fetch } = makeFetch(async () => Response.json({ ok: true }));
    const getAccessToken = vi.fn(async () => "access-one");
    const scopes = makeScopes(fetch, { platformAuth: { getAccessToken } });

    await scopes.public.get("/public");
    await scopes.platform.get("/platform");
    expect(getAccessToken).toHaveBeenCalledOnce();
    expect(new Headers(mock.mock.calls[0]?.[1]?.headers).has("authorization")).toBe(false);
    expect(new Headers(mock.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
      "Bearer access-one",
    );
  });

  it.each([null, "", "   "])("fails closed when the initial token is %j", async (token) => {
    const { mock, fetch } = makeFetch(async () => Response.json({ ok: true }));
    const scopes = makeScopes(fetch, {
      platformAuth: { getAccessToken: async () => token },
    });

    await expect(scopes.platform.get("/me")).rejects.toThrow(
      "platformAuth.getAccessToken returned no access token",
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it.each(["token_expired", "token_missing"])(
    "refreshes and retries a safe request once for %s",
    async (code) => {
      const responses = [
        Response.json({ error: { code, message: "refresh" } }, { status: 401 }),
        Response.json({ ok: true }),
      ];
      const { mock, fetch } = makeFetch(async () => responses.shift()!);
      const refreshAccessToken = vi.fn(async () => "access-two");
      const scopes = makeScopes(fetch, {
        platformAuth: {
          getAccessToken: async () => "access-one",
          refreshAccessToken,
        },
      });

      await expect(scopes.platform.get("/me")).resolves.toEqual({
        ok: true,
      });
      expect(refreshAccessToken).toHaveBeenCalledOnce();
      expect(mock).toHaveBeenCalledTimes(2);
      expect(new Headers(mock.mock.calls[0]?.[1]?.headers).get("authorization")).toBe(
        "Bearer access-one",
      );
      expect(new Headers(mock.mock.calls[1]?.[1]?.headers).get("authorization")).toBe(
        "Bearer access-two",
      );
    },
  );

  it("cancels the first refreshable response before refreshing and retrying", async () => {
    const events: string[] = [];
    const first = Response.json({ error: "token_expired" }, { status: 401 });
    const cancel = vi
      .spyOn(ReadableStream.prototype, "cancel")
      .mockImplementation(async () => {
        events.push("cancel");
      });
    const { fetch } = makeFetch(async () => {
      events.push("fetch");
      return events.filter((event) => event === "fetch").length === 1
        ? first
        : Response.json({ ok: true });
    });
    const scopes = makeScopes(fetch, {
      platformAuth: {
        getAccessToken: async () => "access-one",
        refreshAccessToken: async () => {
          events.push("refresh");
          return "access-two";
        },
      },
    });

    await expect(scopes.platform.get("/me")).resolves.toEqual({ ok: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(events).toEqual(["fetch", "cancel", "refresh", "fetch"]);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "does not retry unsafe %s requests",
    async (method) => {
      const { mock, fetch } = makeFetch(async () =>
        Response.json({ error: "token_expired" }, { status: 401 }),
      );
      const refreshAccessToken = vi.fn(async () => "access-two");
      const scopes = makeScopes(fetch, {
        platformAuth: { getAccessToken: async () => "access-one", refreshAccessToken },
      });

      const response = await scopes.platform.fetch("/mutation", {
        method,
        json: { name: "Ada" },
      });
      expect(response.status).toBe(401);
      expect(mock).toHaveBeenCalledOnce();
      expect(refreshAccessToken).not.toHaveBeenCalled();
    },
  );

  it("blocks redirects and rejects caller redirect overrides", async () => {
    const { mock, fetch } = makeFetch(async (_input, init) => {
      expect(init?.redirect).toBe("error");
      return Response.json({ ok: true });
    });
    const scopes = makeScopes(fetch, {
      platformAuth: { getAccessToken: async () => "access-one" },
    });

    await expect(scopes.platform.get("/me")).resolves.toEqual({ ok: true });
    await expect(
      scopes.platform.get("/me", { redirect: "follow" } as never),
    ).rejects.toThrow(/redirect overrides/u);
    expect(mock).toHaveBeenCalledOnce();
  });

  it("does not carry a platform bearer through a same-origin redirect", async () => {
    let escapedAuthorization: string | undefined;
    let escapedRequests = 0;
    const server = createServer((request, response) => {
      if (request.url === "/outside") {
        escapedRequests += 1;
        escapedAuthorization = request.headers.authorization;
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"escaped":true}');
        return;
      }
      response.writeHead(307, { location: "/outside" });
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not expose a TCP address");
    }

    try {
      const plugin = defineModuleClient({
        moduleRef: "user-core",
        create: (context) => context,
      });
      const scopes = createAppClient({
        baseUrl: `http://127.0.0.1:${address.port}/v1/dispatch/apps/demo`,
        modules: { user: plugin },
        platformAuth: { getAccessToken: async () => "access-one" },
      }).modules.user;

      await expect(scopes.platform.get("/me")).rejects.toBeInstanceOf(TypeError);
      expect(escapedRequests).toBe(0);
      expect(escapedAuthorization).toBeUndefined();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it("does not retry arbitrary 401s or public requests", async () => {
    const { mock, fetch } = makeFetch(async () =>
      Response.json({ error: { code: "reauth_required", message: "reauth" } }, { status: 401 }),
    );
    const refreshAccessToken = vi.fn(async () => "access-two");
    const scopes = makeScopes(fetch, {
      platformAuth: { getAccessToken: async () => "access-one", refreshAccessToken },
    });

    await expect(scopes.platform.get("/me")).rejects.toMatchObject({ code: "reauth_required" });
    await expect(scopes.public.get("/me")).rejects.toMatchObject({ code: "reauth_required" });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it("does not retry a non-replayable streaming body", async () => {
    const { mock, fetch } = makeFetch(async () =>
      Response.json({ error: "token_expired" }, { status: 401 }),
    );
    const refreshAccessToken = vi.fn(async () => "access-two");
    const scopes = makeScopes(fetch, {
      platformAuth: { getAccessToken: async () => "access-one", refreshAccessToken },
    });
    const body = new ReadableStream<Uint8Array>();

    const response = await scopes.platform.fetch("/stream", { method: "POST", body });
    expect(response.status).toBe(401);
    expect(mock).toHaveBeenCalledOnce();
    expect(refreshAccessToken).not.toHaveBeenCalled();
  });

  it.each([null, "", "   "])("does not retry with refreshed token %j", async (token) => {
    const { mock, fetch } = makeFetch(async () =>
      Response.json({ error: "token_expired" }, { status: 401 }),
    );
    const scopes = makeScopes(fetch, {
      platformAuth: {
        getAccessToken: async () => "access-one",
        refreshAccessToken: async () => token,
      },
    });

    await expect(scopes.platform.get("/me")).rejects.toThrow(
      "platformAuth.refreshAccessToken returned no access token",
    );
    expect(mock).toHaveBeenCalledOnce();
  });

  it("never retries more than once", async () => {
    const { mock, fetch } = makeFetch(async () =>
      Response.json({ error: "token_expired" }, { status: 401 }),
    );
    const refreshAccessToken = vi.fn(async () => "access-two");
    const scopes = makeScopes(fetch, {
      platformAuth: { getAccessToken: async () => "access-one", refreshAccessToken },
    });

    await expect(scopes.platform.get("/me")).rejects.toMatchObject({
      status: 401,
      code: "token_expired",
    });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(refreshAccessToken).toHaveBeenCalledOnce();
  });
});
