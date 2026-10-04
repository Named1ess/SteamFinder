import Fastify from "fastify";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createServer } from "vite";
import { expect, it } from "vitest";
import webConfig from "../../vite.config.js";
import { registerRequestSecurity } from "../../../api/src/request-security.js";

it("preserves the browser Host and port through the development proxy", async () => {
  const api = Fastify();
  let calls = 0;
  registerRequestSecurity(api, "localhost 127.0.0.1");
  api.delete("/api/proxy-security-control", () => ({ calls: ++calls }));
  await api.listen({ host: "127.0.0.1", port: 0 });
  const apiPort = (api.server.address() as AddressInfo).port;
  const config = webConfig({ command: "serve", mode: "development" });
  const proxy = config.server?.proxy?.["/api"];
  if (!proxy || typeof proxy === "string") {
    await api.close();
    throw new Error("Development API proxy options are missing");
  }
  const web = await createServer({
    ...config,
    configFile: false,
    server: {
      ...config.server,
      host: "127.0.0.1",
      port: 0,
      watch: null,
      proxy: { "/api": { ...proxy, target: `http://127.0.0.1:${apiPort}` } },
    },
  });
  try {
    await web.listen();
    const port = (web.httpServer!.address() as AddressInfo).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({
        hostname: "127.0.0.1", port, method: "DELETE", path: "/api/proxy-security-control",
        headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` },
      }, response => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      });
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(200);
    expect(calls).toBe(1);
  } finally {
    await web.close();
    await api.close();
  }
});
