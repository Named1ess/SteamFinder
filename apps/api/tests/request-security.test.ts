import Fastify from "fastify";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { registerRequestSecurity } from "../src/request-security.js";

const trustedHosts = "localhost 127.0.0.1 [::1] web api finder.example.com";

async function request(headers: Record<string, string>, method = "GET", url = "/api/runs") {
  const app = Fastify();
  let calls = 0;
  registerRequestSecurity(app, trustedHosts);
  app.route({ method: ["GET", "POST", "PUT", "DELETE", "OPTIONS"], url: "/api/runs", handler: () => ({ calls: ++calls }) });
  app.get("/api/runs/:id/events", () => ({ calls: ++calls }));
  try {
    const response = await app.inject({ method: method as "GET", url, headers });
    return { response, calls };
  } finally {
    await app.close();
  }
}

it.each(["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"])("rejects rebinding Host before the %s handler", async method => {
  const { response, calls } = await request({ host: "attacker.example:8080" }, method);
  expect(response.statusCode).toBe(403);
  expect(calls).toBe(0);
});

it.each(["/%61pi/runs", "/api/%72uns", "http://attacker.example/api/runs", "/api/runs/test/events"])("rejects untrusted Host regardless of route representation: %s", async url => {
  const { response, calls } = await request({ host: "attacker.example:8080" }, "GET", url);
  expect(response.statusCode).toBe(403);
  expect(calls).toBe(0);
});

it.each([
  "localhost.evil.test", "localhost:3001@evil.test", "evil.test@localhost", "localhost/evil",
  "localhost\\evil", "localhost?evil", "localhost#evil", "localhost,evil.test", "localhost:65536",
  "localhost:-1", "localhost:", "localhost:80:90", "local%68ost", "127.1", "2130706433", "0x7f000001",
  "[::1]@evil.test", "[::1]:65536", "[not-an-ip]", "localhost..",
])("rejects malformed or unlisted Host %s", async host => {
  const { response, calls } = await request({ host });
  expect(response.statusCode).toBe(403);
  expect(calls).toBe(0);
});

it.each(["localhost", "LOCALHOST:8080", "localhost.:8080", "127.0.0.1:3001", "[::1]:8080", "web", "api:3001", "finder.example.com:8443"])("preserves trusted CLI and healthcheck Host %s without Origin", async host => {
  const { response, calls } = await request({ host });
  expect(response.statusCode).toBe(200);
  expect(calls).toBe(1);
});

it("does not accept an attacker Host via forwarded headers", async () => {
  const { response, calls } = await request({ host: "attacker.example", "x-forwarded-host": "localhost", "x-forwarded-proto": "https" });
  expect(response.statusCode).toBe(403);
  expect(calls).toBe(0);
});

it("rejects empty and absent Host on real HTTP requests before the handler", async () => {
  const app = Fastify();
  let calls = 0;
  registerRequestSecurity(app, trustedHosts);
  app.get("/api/runs", () => ({ calls: ++calls }));
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  try {
    // light-my-request replaces an empty Host with localhost, so use the wire.
    for (const headers of [{ host: "" }, {}]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest({ hostname: "127.0.0.1", port, path: "/api/runs", setHost: false, headers }, response => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        });
        req.on("error", reject);
        req.end();
      });
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
      expect(calls).toBe(0);
    }
  } finally {
    await app.close();
  }
});

it("keeps the declared API healthcheck working with only a custom trusted Host", async () => {
  const compose = await readFile(new URL("../../../compose.yaml", import.meta.url), "utf8");
  const serializedCommand = compose.match(/"-e",\s*("(?:\\.|[^"\\])*")/)?.[1];
  if (!serializedCommand) throw new Error("Node API healthcheck command is missing");
  const api = Fastify();
  registerRequestSecurity(api, "finder.example.com");
  let calls = 0;
  api.get("/api/health", () => ({ calls: ++calls }));
  await api.listen({ host: "127.0.0.1", port: 0 });
  const port = (api.server.address() as AddressInfo).port;
  try {
    const command = (JSON.parse(serializedCommand) as string).replace("127.0.0.1:3001", `127.0.0.1:${port}`);
    await promisify(execFile)(process.execPath, ["-e", command], {
      env: { ...process.env, TRUSTED_HOSTS: "finder.example.com" }, timeout: 5_000,
    });
    expect(calls).toBe(1);
  } finally {
    await api.close();
  }
});

it.each(["http://evil.test:8080", "null", "http://localhost:8081", "http://localhost:8080/", "http://localhost:8080@evil.test", "http://localhost:8080?x=1", "http://localhost:8080#x", "http://localhost:8080, http://evil.test"])("rejects unsafe or different browser Origin %s", async origin => {
  const { response, calls } = await request({ host: "localhost:8080", origin }, "DELETE");
  expect(response.statusCode).toBe(403);
  expect(calls).toBe(0);
});

it.each([
  { host: "localhost:8080", origin: "http://localhost:8080" },
  { host: "localhost:5174", origin: "http://localhost:5174" },
  { host: "127.0.0.1:8080", origin: "http://127.0.0.1:8080" },
  { host: "[::1]:8080", origin: "http://[::1]:8080" },
  { host: "finder.example.com", origin: "https://finder.example.com" },
  { host: "finder.example.com:8443", origin: "https://finder.example.com:8443" },
  { host: "localhost:80", origin: "http://localhost" },
])("preserves same-authority browser and TLS-proxy requests ($host)", async headers => {
  const { response, calls } = await request(headers, "DELETE");
  expect(response.statusCode).toBe(200);
  expect(calls).toBe(1);
});

it("rejects a cross-site browser request even when Origin is absent", async () => {
  const { response, calls } = await request({ host: "localhost:8080", "sec-fetch-site": "cross-site" });
  expect(response.statusCode).toBe(403);
  expect(calls).toBe(0);
});

it.each(["", "*", ".example.com", "localhost:8080", "localhost;return 200", "https://localhost"])("fails closed for invalid trusted-host configuration %s", hosts => {
  const app = Fastify();
  expect(() => registerRequestSecurity(app, hosts)).toThrow();
});
