import { createServer } from "node:net";
import { homedir } from "node:os";
import { delimiter } from "node:path";
import type { DesktopConfiguration, DesktopStatus } from "@canopy/ui/desktop";
import type { JsonObject, JsonValue } from "@canopy/domain";
import { fromJsonString } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";

export interface Secrets {
  databasePassword: string;
  secretsKey: string;
  serviceToken: string;
}

export interface RuntimePaths {
  bun: string;
  gateway: string;
  worker: string;
  web: string;
  postgres: string;
}

export function isWorkerStatus(value: unknown): value is { status?: string; time?: number } {
  return (
    !!value &&
    typeof value === "object" &&
    (!("status" in value) || value.status === undefined || isString(value.status)) &&
    (!("time" in value) || value.time === undefined || typeof value.time === "number")
  );
}

export function isWorkerConfiguration(value: JsonValue): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export const initialStatus = (): DesktopStatus => ({
  mode: null,
  phase: "setup",
  worker: "offline",
  clis: { claude: false, codex: false, grok: false },
  allowNetwork: false,
  bindHost: "127.0.0.1",
});

export function isString<T>(value: T): value is T & string {
  return typeof value === "string";
}

export interface ConfigurationInput {
  mode?: unknown;
  allowNetwork?: unknown;
  bindHost?: unknown;
  gatewayUrl?: unknown;
  webUrl?: unknown;
  enrollmentToken?: unknown;
  gatewayFingerprint?: unknown;
  pairingInvitation?: unknown;
  workerGatewayUrl?: unknown;
}

function isConfigurationInput(value: ConfigurationInput | null | undefined): value is ConfigurationInput {
  return !!value && typeof value === "object";
}

export function origin(value: string | null | undefined, label: string) {
  if (!isString(value) || value.length > 2048) throw new Error(`Invalid ${label}`);
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(`${label} must be an HTTP(S) origin without credentials or a path`);

  return url.origin;
}

export function configuration(value: ConfigurationInput | null | undefined): DesktopConfiguration {
  if (!isConfigurationInput(value)) throw new Error("Invalid desktop configuration");
  const c = value;

  if (c["mode"] === "local") {
    return { mode: "local", allowNetwork: false, bindHost: "127.0.0.1" };
  }

  if (c["mode"] === "remote") {
    const fingerprint = c.gatewayFingerprint;

    if (
      fingerprint !== undefined &&
      (!isString(fingerprint) || (fingerprint !== "" && !/^[a-f0-9]{64}$/i.test(fingerprint)))
    )
      throw new Error("Use the full SHA-256 gateway fingerprint");
    const token = c["enrollmentToken"];

    if (token !== undefined && (!isString(token) || token.length < 16 || token.length > 4096))
      throw new Error("Invalid enrollment token");

    if (c.pairingInvitation !== undefined && (!isString(c.pairingInvitation) || c.pairingInvitation.length > 16384))
      throw new Error("Invalid desktop pairing invitation");
    let invited: string | undefined;

    try {
      if (isString(c.pairingInvitation) && c.pairingInvitation.trim())
        invited = fromJsonString(ui.CreateMobilePairingResponseSchema, c.pairingInvitation, {
          ignoreUnknownFields: true,
        }).routes?.addresses[0];
    } catch {
      throw new Error("Paste a desktop invitation from gateway Settings → Devices");
    }

    if (!isString(c.gatewayUrl)) throw new Error("Invalid Gateway address");
    const gatewayUrl = origin(c.gatewayUrl || invited, "Gateway address");

    if (c.webUrl !== undefined && !isString(c.webUrl)) throw new Error("Invalid Web address");

    if (c.workerGatewayUrl !== undefined && !isString(c.workerGatewayUrl)) throw new Error("Invalid worker address");

    return {
      mode: "remote",
      gatewayUrl,
      ...(isString(c.webUrl) && { webUrl: origin(c.webUrl, "Web address") }),
      ...(isString(c.pairingInvitation) && { pairingInvitation: c.pairingInvitation }),
      ...(isString(c.workerGatewayUrl) && { workerGatewayUrl: origin(c.workerGatewayUrl, "Worker address") }),
      ...(isString(token) && { enrollmentToken: token }),
      ...(isString(fingerprint) && fingerprint && { gatewayFingerprint: fingerprint.toLowerCase() }),
    };
  }

  throw new Error("Choose local or remote mode");
}

export function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();

      if (!address || isString(address)) {
        server.close();
        reject(new Error("Port allocation failed"));

        return;
      }

      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

/** Do not inherit gateway/provider secrets or unrelated developer configuration. */
export function serviceEnvironment(): NodeJS.ProcessEnv {
  const names = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "PROGRAMDATA",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
  ];

  const env: NodeJS.ProcessEnv = {};

  for (const name of names) if (process.env[name]) env[name] = process.env[name];
  env["PATH"] = [
    ...new Set([
      process.env["PATH"] ?? "",
      `${homedir()}/.local/bin`,
      ...(process.platform === "win32" ? [] : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"]),
    ]),
  ].join(delimiter);

  return env;
}
