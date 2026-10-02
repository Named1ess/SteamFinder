import { afterEach, expect, it, vi } from "vitest";
import { api, request } from "./api";

afterEach(() => vi.unstubAllGlobals());

it("deletes a saved view without declaring an empty JSON body", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}'));
  vi.stubGlobal("fetch", fetchMock);
  await expect(api.deleteView("run", "view")).resolves.toEqual({ ok: true });
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/runs/run/views/view");
  expect(init.method).toBe("DELETE");
  expect(init.body).toBeUndefined();
  expect(new Headers(init.headers).has("Content-Type")).toBe(false);
});

it("declares JSON for requests that actually send a JSON body", async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"id":"saved"}'));
  vi.stubGlobal("fetch", fetchMock);
  await request("/example", { method: "POST", body: '{"name":"view"}' });
  const init = fetchMock.mock.calls[0][1];
  expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  expect(init.body).toBe('{"name":"view"}');
});
