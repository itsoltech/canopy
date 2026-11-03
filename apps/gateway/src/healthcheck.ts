import { connect } from "node:net";
import { readEnv } from "@canopy/domain/env";

/**
 * `canopy-gateway healthcheck` (Docker HEALTHCHECK, systemd probes): 0 when the gRPC listener accepts a connection.
 * The listener opens only after migrations and the core started, so this is also a readiness check.
 */
export function healthcheck(env: Readonly<Record<string, string | undefined>>): Promise<number> {
  const configured = readEnv("CANOPY_HOST", env) ?? "0.0.0.0";
  const host = configured === "0.0.0.0" || configured === "::" ? "127.0.0.1" : configured;
  return new Promise((done) => {
    const socket = connect({ host, port: Number(readEnv("CANOPY_PORT", env) ?? 7443), timeout: 3000 });
    socket.once("connect", () => { socket.destroy(); done(0); });
    socket.once("timeout", () => { socket.destroy(); done(1); });
    socket.once("error", () => done(1));
  });
}
