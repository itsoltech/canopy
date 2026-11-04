import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostname } from "node:os";
import { createClient } from "@connectrpc/connect";
import { ui } from "@canopy/contracts";
import { routedPinnedTransport } from "@canopy/transport";
import type { JsonValue } from "@canopy/domain";
import type { DesktopClientCredential } from "../remote-client.ts";
import { enrollWorker } from "../../../worker/src/enroll.ts";
import { isString, isWorkerConfiguration } from "./config.ts";
import type { Logs } from "./log.ts";
import type { Supervisor } from "./process.ts";
import { Schema } from "effect";

export function desktopWorkerIdle(services: Supervisor, statusFile: string, draining: boolean) {
  const pid = services.send("worker", draining ? "canopy:drain" : "canopy:resume");

  const value = Schema.decodeUnknownSync(
    Schema.Struct({ pid: Schema.Number, time: Schema.Number, idle: Schema.Boolean, draining: Schema.Boolean }),
  )(JSON.parse(readFileSync(statusFile, "utf8")));

  return value.pid === pid && Date.now() - value.time < 3000 && value.draining && value.idle;
}

export async function remoteEnrollment(client: DesktopClientCredential, directory: string, logs: Logs) {
  if (existsSync(join(directory, "worker.json"))) return undefined;
  const routed = routedPinnedTransport(client, client.token);

  try {
    const api = createClient(ui.GatewayService, routed.transport);
    const result = await api.createWorkerEnrollment({ name: `Canopy · ${hostname()}` }, { timeoutMs: 3000 });

    return { token: result.token, gatewayUrl: routed.connection().lastAddress };
  } catch {
    logs.write(
      "worker",
      "Worker enrollment unavailable; the desktop UI can connect independently. Retry in desktop settings.",
    );

    return undefined;
  }
}

export async function startDesktopWorker(options: {
  directory: string;
  gatewayUrl: string;
  token?: string | undefined;
  fingerprint?: string | undefined;
  local: boolean;
  logs: Logs;
  services: Supervisor;
  bun: string;
  entry: string;
  env: NodeJS.ProcessEnv;
}) {
  const { directory, gatewayUrl, local, logs } = options;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const configPath = join(directory, "worker.json");

  if (options.token) {
    logs.protect(options.token);

    let enrolled;

    try {
      enrolled = await enrollWorker({
        gateway: gatewayUrl,
        ...(options.fingerprint && { fingerprint: options.fingerprint }),
        token: options.token,
        configPath,
        dataDir: join(directory, "data"),
        force: existsSync(configPath),
      });
    } catch (cause) {
      if (local) throw cause;
      logs.write("worker", "Worker enrollment failed. Retry in desktop settings; desktop UI access is independent.");

      return "";
    }

    logs.protect(enrolled.credential);
  } else if (!existsSync(configPath)) return "";

  const worker: JsonValue = JSON.parse(readFileSync(configPath, "utf8"));

  if (!isWorkerConfiguration(worker)) throw new Error("Invalid worker configuration");

  if (isString(worker["credential"])) logs.protect(worker["credential"]);

  if (local) {
    writeFileSync(`${configPath}.new`, JSON.stringify({ ...worker, gateway_url: gatewayUrl }), { mode: 0o600 });
    renameSync(`${configPath}.new`, configPath);
  }

  const status = join(directory, "status.json");
  writeFileSync(status, JSON.stringify({ status: "offline", time: Date.now() }), { mode: 0o600 });
  options.services.start({
    name: "worker",
    command: options.bun,
    args: [options.entry, "--config", configPath],
    cwd: dirname(options.entry),
    env: { ...options.env, CANOPY_WORKER_STATUS_FILE: status, CANOPY_LOCAL_WORKER: local ? "1" : "0" },
    restart: true,
  });

  return status;
}
