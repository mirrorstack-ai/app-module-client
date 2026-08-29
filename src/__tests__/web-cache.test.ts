import assert from "node:assert/strict";
import { test } from "vitest";

import { createModuleTextCache, isAbortError } from "../web/cache.js";

function tracker() {
  let started = 0;
  const aborted: boolean[] = [];
  let release: ((value: string) => void) | undefined;

  const fetchText = (signal: AbortSignal) => {
    const index = started++;
    aborted[index] = false;
    return new Promise<string>((resolve, reject) => {
      release = resolve;
      signal.addEventListener("abort", () => {
        aborted[index] = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      }, { once: true });
    });
  };

  return {
    fetchText,
    starts: () => started,
    aborted,
    settle: (value: string) => release?.(value),
  };
}

test("cache instances never share completed entries", async () => {
  let calls = 0;
  const fetchText = async () => String(++calls);
  const first = createModuleTextCache();
  const second = createModuleTextCache();

  assert.equal(await first.cachedText("users", fetchText), "1");
  assert.equal(await first.cachedText("users", fetchText), "1");
  assert.equal(await second.cachedText("users", fetchText), "2");
});

test("freshness and explicit refresh use the instance clock", async () => {
  let now = 1_000;
  let calls = 0;
  const cache = createModuleTextCache({ now: () => now, maxAgeMs: 50 });
  const fetchText = async () => String(++calls);

  assert.equal(await cache.cachedText("users", fetchText), "1");
  now += 49;
  assert.equal(await cache.cachedText("users", fetchText), "1");
  now += 2;
  assert.equal(await cache.cachedText("users", fetchText), "2");
  assert.equal(await cache.cachedText("users", fetchText, { maxAgeMs: 0 }), "3");
});

test("concurrent readers coalesce without sharing parsed objects", async () => {
  const cache = createModuleTextCache();
  const request = tracker();
  const first = cache.cachedText("users", request.fetchText);
  const second = cache.cachedText("users", request.fetchText);

  assert.equal(request.starts(), 1);
  request.settle('{"users":[{"id":"a"}]}');
  const [firstText, secondText] = await Promise.all([first, second]);
  const firstValue = JSON.parse(firstText) as { users: Array<{ id: string }> };
  firstValue.users[0]!.id = "changed";
  assert.deepEqual(JSON.parse(secondText), { users: [{ id: "a" }] });
});

test("one caller abort does not cancel a remaining caller", async () => {
  const cache = createModuleTextCache();
  const request = tracker();
  const leavingController = new AbortController();
  const stayingController = new AbortController();
  const leaving = cache.cachedText("users", request.fetchText, {
    signal: leavingController.signal,
  });
  const staying = cache.cachedText("users", request.fetchText, {
    signal: stayingController.signal,
  });

  leavingController.abort();
  await assert.rejects(leaving, (error: unknown) => isAbortError(error));
  assert.equal(request.aborted[0], false);

  request.settle("response");
  assert.equal(await staying, "response");
});

test("the last caller abort stops the owned request", async () => {
  const cache = createModuleTextCache();
  const request = tracker();
  const controller = new AbortController();
  const pending = cache.cachedText("users", request.fetchText, {
    signal: controller.signal,
  });

  controller.abort();
  await assert.rejects(pending, (error: unknown) => isAbortError(error));
  assert.equal(request.aborted[0], true);
});

test("clear aborts live requests and removes completed entries", async () => {
  const cache = createModuleTextCache();
  const request = tracker();
  const pending = cache.cachedText("users", request.fetchText);

  cache.clear();
  await assert.rejects(pending, (error: unknown) => isAbortError(error));
  assert.equal(request.aborted[0], true);

  let calls = 0;
  const fetchText = async () => String(++calls);
  assert.equal(await cache.cachedText("sessions", fetchText), "1");
  cache.clear();
  assert.equal(await cache.cachedText("sessions", fetchText), "2");
});

test("prefix invalidation affects only matching completed entries", async () => {
  const cache = createModuleTextCache();
  let calls = 0;
  const fetchText = async () => String(++calls);

  await cache.cachedText("/users", fetchText);
  await cache.cachedText("/sessions", fetchText);
  cache.invalidate("/users");

  assert.equal(await cache.cachedText("/sessions", fetchText), "2");
  assert.equal(await cache.cachedText("/users", fetchText), "3");
});

test("invalid cache limits fail fast", () => {
  assert.throws(() => createModuleTextCache({ maxEntries: 0 }), /maxEntries/);
  assert.throws(() => createModuleTextCache({ maxAgeMs: -1 }), /maxAgeMs/);
});
