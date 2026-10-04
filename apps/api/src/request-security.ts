import { isIP } from "node:net";
import type { FastifyInstance } from "fastify";

type Authority = { hostname: string; port: string };
const dnsName = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

function authority(value: string | undefined): Authority | null {
  if (!value) return null;
  const match = /^(\[[^\]]+\]|[^:]+)(?::([0-9]{1,5}))?$/.exec(value);
  if (!match) return null;
  const hostname = match[1].toLowerCase();
  if (hostname.startsWith("[")) {
    if (isIP(hostname.slice(1, -1)) !== 6) return null;
  } else if (hostname.length > 254 || !dnsName.test(hostname)) {
    return null;
  }
  const port = match[2] ? Number(match[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return null;
  return { hostname: hostname.replace(/\.$/, ""), port: port === undefined ? "" : String(port) };
}

export function registerRequestSecurity(app: FastifyInstance, trustedHosts: string): void {
  const hosts = trustedHosts.trim().split(/\s+/);
  const allowed = new Set(hosts.map(host => {
    const parsed = authority(host);
    if (!parsed || parsed.port) throw new Error("TRUSTED_HOSTS 必须是以空格分隔、不含端口的主机名或 IP 地址");
    return parsed.hostname;
  }));

  // Apply before routing/body parsing, including encoded paths and SSE requests.
  app.addHook("onRequest", async (request, reply) => {
    const target = authority(request.headers.host);
    if (!target || !allowed.has(target.hostname)) {
      return reply.code(403).send({ message: "请求主机不受信任" });
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      return reply.code(403).send({ message: "请求来源不受信任" });
    }
    const origin = request.headers.origin;
    if (origin !== undefined) {
      const match = /^(https?):\/\/(.+)$/.exec(origin);
      const source = match ? authority(match[2]) : null;
      const defaultPort = match?.[1] === "https" ? "443" : "80";
      // Host has already passed the independent allowlist. Preserve its public
      // authority through both proxies; HTTPS may terminate outside Fastify.
      if (!source || source.hostname !== target.hostname ||
          (source.port || defaultPort) !== (target.port || defaultPort)) {
        return reply.code(403).send({ message: "请求来源不受信任" });
      }
    }
  });
}
