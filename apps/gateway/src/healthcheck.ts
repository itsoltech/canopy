import { connect } from "node:net";
import { CANOPY_VERSION } from "@canopy/domain/release/version";
import { isJsonObject, parseJson } from "@canopy/domain/json";

/**
 * `canopy-gateway healthcheck` (Docker HEALTHCHECK, systemd probes): 0 when the gRPC listener accepts a connection
 * and, when this gateway runs its embedded web, that web answers `/api/health` with this version (another process
 * on the web port does not count). The gRPC listener opens only after migrations and the core started, so this is
 * also a readiness check.
 */
export async function healthcheck(env: Readonly<Record<string, string | undefined>>, webUrl?: string): Promise<number> {
  const configured = env["CANOPY_HOST"] ?? "0.0.0.0";
  const host = configured === "0.0.0.0" || configured === "::" ? "127.0.0.1" : configured;
  const gateway = await accepts(host, Number(env["CANOPY_PORT"] ?? 7443));

  return gateway === 0 && webUrl ? webAnswers(webUrl) : gateway;
}

async function webAnswers(url: string): Promise<number> {
  try {
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    const body = parseJson(await response.text());

    return response.ok && isJsonObject(body) && body["version"] === CANOPY_VERSION ? 0 : 1;
  } catch {
    return 1;
  }
}

function accepts(host: string, port: number): Promise<number> {
  return new Promise((done) => {
    const socket = connect({ host, port, timeout: 3000 });
    socket.once("connect", () => {
      socket.destroy();
      done(0);
    });
    socket.once("timeout", () => {
      socket.destroy();
      done(1);
    });
    socket.once("error", () => done(1));
  });
}
