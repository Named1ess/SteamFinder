import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Opt in with RUN_NGINX_TESTS=true; requires a running Docker Linux engine.
// The deployed web stage is built with a tiny SPA fixture instead of Vite output.
const run = promisify(execFile);
const suite = process.env.RUN_NGINX_TESTS === "true" ? describe : describe.skip;

suite("deployed Nginx security and proxy behavior", () => {
  const id = `steamfinder-nginx-test-${randomUUID()}`;
  const network = `${id}-network`;
  const upstream = `${id}-api`;
  const image = `${id}:test`;
  const containers: string[] = [];
  let fixture = "";
  let defaultPort = 0;
  let customPort = 0;

  async function docker(...args: string[]) {
    const result = await run("docker", args, {
      timeout: 180_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return result.stdout.trim();
  }

  async function get(port: number, path: string, host = "localhost", options: { method?: string; headers?: Record<string, string> } = {}) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolveRequest, reject) => {
      const req = request({ hostname: "127.0.0.1", port, path, method: options.method,
        headers: { Host: host, ...options.headers } }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => { body += chunk; });
        res.on("end", () => resolveRequest({ status: res.statusCode!, headers: res.headers, body }));
        res.on("error", reject);
      });
      req.setTimeout(5_000, () => req.destroy(new Error("Nginx request timed out")));
      req.on("error", reject);
      req.end();
    });
  }

  async function startWeb(name: string, trustedHosts?: string) {
    containers.push(name);
    await docker("run", "--detach", "--name", name, "--network", network,
      "--publish", "127.0.0.1::80",
      ...(trustedHosts ? ["--env", `TRUSTED_HOSTS=${trustedHosts}`] : []), image);
    const binding = await docker("port", name, "80/tcp");
    const port = Number(binding.split(":").at(-1));
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await get(port, "/", trustedHosts ? "steamfinder.test" : "localhost");
        return port;
      } catch {
        await new Promise((done) => setTimeout(done, 100));
      }
    }
    const logs = await run("docker", ["logs", name]);
    throw new Error(`Nginx did not start: ${logs.stdout}${logs.stderr}`);
  }

  beforeAll(async () => {
    await docker("info");
    const root = resolve(import.meta.dirname, "../../..");
    fixture = await mkdtemp(join(tmpdir(), "steamfinder-nginx-test-"));
    await mkdir(join(fixture, "fixture", "html", "assets"), { recursive: true });
    await writeFile(join(fixture, "fixture", "html", "index.html"), "<!doctype html><title>Nginx test SPA</title>");
    await writeFile(join(fixture, "fixture", "html", "assets", "app.js"), "console.log('Nginx test asset');");
    await cp(join(root, "nginx.conf"), join(fixture, "nginx.conf"));
    const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
    const webStage = dockerfile.slice(dockerfile.search(/^FROM nginx:.* AS web\s*$/m));
    if (!webStage.startsWith("FROM nginx:")) throw new Error("Dockerfile has no Nginx web stage");
    await writeFile(join(fixture, "Dockerfile"), webStage.replace(
      "COPY --from=web-build /app/dist/web /usr/share/nginx/html",
      "COPY fixture/html /usr/share/nginx/html",
    ));
    // Only copied when present, so this regression can also run against the old config.
    try { await cp(join(root, "nginx-security-headers.conf"), join(fixture, "nginx-security-headers.conf")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFile(join(fixture, "upstream.mjs"), `
import http from 'node:http';
http.createServer((req, res) => {
  if (req.url === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: first ' + '.'.repeat(2048) + '\\n\\n');
    setTimeout(() => res.end('data: final\\n\\n'), 1500);
  } else {
    res.writeHead(req.url === '/api/missing' ? 404 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ host: req.headers.host, connection: req.headers.connection ?? null }));
  }
}).listen(3001, '0.0.0.0');
`);
    await docker("build", "--tag", image, fixture);
    await docker("network", "create", network);
    containers.push(upstream);
    await docker("create", "--name", upstream, "--network", network, "--network-alias", "api",
      "node:24-alpine", "node", "/upstream.mjs");
    await docker("cp", join(fixture, "upstream.mjs"), `${upstream}:/upstream.mjs`);
    await docker("start", upstream);
    defaultPort = await startWeb(`${id}-web`);
    customPort = await startWeb(`${id}-custom-web`, "steamfinder.test");
    await docker("exec", `${id}-web`, "nginx", "-t");
  }, 180_000);

  afterAll(async () => {
    await Promise.allSettled(containers.map((name) => docker("rm", "--force", name)));
    await docker("network", "rm", network).catch(() => undefined);
    await docker("image", "rm", image).catch(() => undefined);
    if (fixture) {
      const target = resolve(fixture);
      if (!target.startsWith(join(tmpdir(), "steamfinder-nginx-test-"))) {
        throw new Error("Refusing to remove a directory outside the Nginx test fixtures");
      }
      await rm(target, { recursive: true, force: true });
    }
  }, 30_000);

  it.each([
    ["/", 200],
    ["/index.html", 200],
    ["/saved/view", 200],
    ["/favicon.ico", 200],
    ["/assets/app.js", 200],
    ["/assets/missing.js", 404],
    ["/api/headers", 200],
    ["/api/missing", 404],
  ])("sends security headers for %s (%s)", async (path, status) => {
    const response = await get(defaultPort, String(path));
    expect(response.status).toBe(status);
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("sends security headers on Nginx's body-size rejection", async () => {
    const response = await get(defaultPort, "/api/headers", "localhost", {
      method: "POST", headers: { "Content-Length": "1048577" },
    });
    expect(response.status).toBe(413);
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("preserves no-cache for HTML and one-year immutable caching for assets", async () => {
    for (const path of ["/", "/saved/view"]) {
      const response = await get(defaultPort, path);
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.body).toContain("Nginx test SPA");
    }
    const asset = await get(defaultPort, "/assets/app.js");
    expect(asset.headers["cache-control"]).toContain("max-age=31536000");
    expect(asset.headers["cache-control"]).toContain("public, immutable");
    expect(asset.headers.expires).toBeDefined();
  });

  it.each(["localhost", "127.0.0.1", "[::1]", "web", "api", "LOCALHOST:8080"])("accepts the default trusted Host %s", async (host) => {
    expect((await get(defaultPort, "/", host)).status).toBe(200);
  });

  it.each(["/", "/saved/view", "/assets/app.js", "/api/headers"])("rejects an unknown Host before serving %s", async (path) => {
    const response = await get(defaultPort, path, "untrusted.test:8080");
    expect(response.status).toBe(421);
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["content-security-policy"]).toBe("frame-ancestors 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("only accepts a custom domain when TRUSTED_HOSTS includes it", async () => {
    expect((await get(defaultPort, "/", "steamfinder.test:8080")).status).toBe(421);
    expect((await get(customPort, "/", "steamfinder.test:8080")).status).toBe(200);
    expect((await get(customPort, "/api/headers", "untrusted.test")).status).toBe(421);
  });

  it("passes the original Host including its port to the API", async () => {
    const response = await get(customPort, "/api/headers", "steamfinder.test:8080");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ host: "steamfinder.test:8080", connection: null });
  });

  it("streams SSE promptly with no-cache and no gzip", async () => {
    await new Promise<void>((resolveRequest, reject) => {
      const started = Date.now();
      let firstChunkAt = 0;
      let body = "";
      const req = request({ hostname: "127.0.0.1", port: defaultPort, path: "/api/events",
        headers: { Host: "localhost", "Accept-Encoding": "gzip" } }, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          firstChunkAt ||= Date.now();
          body += chunk;
        });
        res.on("end", () => {
          try {
            expect(res.statusCode).toBe(200);
            expect(res.headers["content-type"]).toBe("text/event-stream");
            expect(res.headers["content-encoding"]).toBeUndefined();
            expect(res.headers["cache-control"]).toBe("no-cache");
            expect(firstChunkAt - started).toBeLessThan(1_000);
            expect(body).toContain("data: first");
            expect(body).toContain("data: final");
            resolveRequest();
          } catch (error) { reject(error); }
        });
        res.on("error", reject);
      });
      req.setTimeout(5_000, () => req.destroy(new Error("SSE request timed out")));
      req.on("error", reject);
      req.end();
    });
  });
});
