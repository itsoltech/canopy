import { closeSync, existsSync, fchmodSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { createClient } from "@connectrpc/connect";
import { WorkerEnrollmentService } from "@open-agents/contracts";
import { CANOPY_VERSION } from "@open-agents/domain/release/version";
import { createGrpcClientTransport } from "@open-agents/transport";
import type { LocalConfig } from "./config/local.ts";

export interface EnrollmentOptions {
  gateway: string;
  token: string;
  configPath: string;
  dataDir?: string;
  force?: boolean;
}

/** Reserve the destination before spending the one-use token. Never print the returned credential. */
export async function enrollWorker(options: EnrollmentOptions): Promise<LocalConfig> {
  const url = new URL(options.gateway);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Use the gateway origin with its gRPC port");
  const path = resolve(options.configPath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!options.force && existsSync(path)) throw new Error("Worker config already exists; use --force to replace it");
  // --force replaces via rename, including a symlink, without following it or truncating the old config.
  const target = options.force ? `${path}.${crypto.randomUUID()}.enrolling` : path;
  const fd = openSync(target, "wx", 0o600);
  try {
    const client = createClient(WorkerEnrollmentService, createGrpcClientTransport({ baseUrl: url.origin, connectTimeoutMs: 5_000 }));
    let result;
    try {
      result = await client.enroll({ enrollmentToken: options.token,
        host: { hostname: hostname(), os: process.platform, arch: process.arch, workerVersion: CANOPY_VERSION } }, { timeoutMs: 15_000 });
    } catch {
      throw new Error("Enrollment failed. Check the gateway address and use a valid, unexpired token from Settings → Workers");
    }
    const local: LocalConfig = { gateway_url: url.origin, worker_id: result.workerId, credential: result.workerCredential,
      ...(options.dataDir && { data_dir: resolve(options.dataDir) }) };
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(local, null, 2)}\n`, { encoding: "utf8" });
    fsyncSync(fd);
    if (options.force) renameSync(target, path);
    return local;
  } catch (error) {
    unlinkSync(target);
    throw error;
  } finally { closeSync(fd); }
}

/** How this worker is started again: the standalone binary itself (bun build --compile), else Bun with the source entry. */
export function workerCommand(): readonly string[] {
  const compiled = import.meta.dir.includes("$bunfs") || import.meta.dir.includes("~BUN");
  return compiled ? [process.execPath] : [process.execPath, resolve(import.meta.dir, "main.ts")];
}

/** Snippets contain paths only; credentials stay in worker.json. No automatic service installation. */
export function workerServiceSnippet(platform: string, configPath: string, command: readonly string[] = workerCommand()): string {
  const config = resolve(configPath);
  if (platform === "darwin") {
    const xml = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
    return `Save as ~/Library/LaunchAgents/com.canopy.worker.plist, then run:\nlaunchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.canopy.worker.plist\n\n<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n  <key>Label</key><string>com.canopy.worker</string>\n  <key>ProgramArguments</key><array>${command.map((part) => `<string>${xml(part)}</string>`).join("")}<string>--config</string><string>${xml(config)}</string></array>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin")}</string></dict>\n</dict></plist>`;
  }
  const unit = (s: string) => '"' + s.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%").replaceAll("$", "$$") + '"';
  return `Save as ~/.config/systemd/user/canopy-worker.service, then run:\nsystemctl --user daemon-reload\nsystemctl --user enable --now canopy-worker\n\n[Unit]\nDescription=Canopy worker\nAfter=network-online.target\n\n[Service]\nExecStart=${command.map(unit).join(" ")} --config ${unit(config)}\nEnvironment=${unit(`PATH=${process.env["PATH"] ?? "/usr/local/bin:/usr/bin:/bin"}`)}\nRestart=on-failure\nRestartPreventExitStatus=78\nRestartSec=5\n\n[Install]\nWantedBy=default.target`;
}
