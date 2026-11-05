import { userInfo } from "node:os";
import { Option, Schema } from "effect";
import type { JsonValue } from "@canopy/domain";

/** HTTPS ports Canopy picks by itself: the standard one when it is free, else a fixed Canopy default. */
export const AUTOMATIC_PORTS = [443, 8447] as const;

/** Exactly the Serve entry Canopy added (stored in network_access.tailscale_serve). */
export type ServeEntry = { port: number; host: string; target: string };

const Tcp = Schema.optional(
  Schema.NullOr(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        HTTPS: Schema.optional(Schema.Boolean),
        HTTP: Schema.optional(Schema.Boolean),
        TCPForward: Schema.optional(Schema.String),
      }),
    ),
  ),
);

const Web = Schema.optional(
  Schema.NullOr(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        Handlers: Schema.optional(
          Schema.NullOr(Schema.Record(Schema.String, Schema.Struct({ Proxy: Schema.optional(Schema.String) }))),
        ),
      }),
    ),
  ),
);

// `tailscale serve status --json`: background entries, and foreground sessions (`tailscale serve` in a terminal).
const ServeConfig = Schema.Struct({
  TCP: Tcp,
  Web,
  Foreground: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Struct({ TCP: Tcp })))),
});

export type ServeConfig = typeof ServeConfig.Type;

const decodeConfig = Schema.decodeUnknownOption(ServeConfig);

export const decodeEntry = Schema.decodeUnknownOption(
  Schema.Struct({ port: Schema.Number, host: Schema.String, target: Schema.String }),
);

/** The serve config, or undefined when the CLI printed something else. An empty answer is an empty config. */
export function parseServeConfig(text: string): ServeConfig | undefined {
  if (!text.trim()) return {};

  try {
    const json: JsonValue = JSON.parse(text);

    return Option.getOrUndefined(decodeConfig(json));
  } catch {
    return undefined;
  }
}

/** Fixed argument arrays only. None of them ever contains "funnel" (a test checks every command built). */
export const serveStatusArgs = () => ["serve", "status", "--json"];

export const serveOnArgs = (port: number, target: string) => ["serve", "--bg", "--yes", `--https=${port}`, target];

export const serveOffArgs = (port: number) => ["serve", `--https=${port}`, "off"];

/** Every port Serve uses on this computer, in the background or in a terminal session. */
export function usedPorts(config: ServeConfig) {
  const keys = [
    ...Object.keys(config.TCP ?? {}),
    ...Object.values(config.Foreground ?? {}).flatMap((session) => Object.keys(session.TCP ?? {})),
  ];

  return new Set(keys.flatMap((key) => (Number.isInteger(Number(key)) ? [Number(key)] : [])));
}

/** The entry is still exactly what Canopy added: its port proxies the web root to Canopy's front. */
export function ownsEntry(config: ServeConfig, entry: ServeEntry) {
  return (
    Boolean(config.TCP?.[String(entry.port)]?.HTTPS) &&
    config.Web?.[`${entry.host}:${entry.port}`]?.Handlers?.["/"]?.Proxy === entry.target
  );
}

const usedMessage = (port: number) =>
  `Port ${port} is already used by another Tailscale Serve entry. Choose another port.`;

/** The HTTPS port: the one chosen in Settings or the first free automatic one. Canopy's own entry counts as free. */
export function choosePort(config: ServeConfig, own: ServeEntry | undefined, requested: number | null) {
  const used = usedPorts(config);

  if (own) used.delete(own.port);

  if (requested !== null) {
    if (used.has(requested)) throw new Error(usedMessage(requested));

    return requested;
  }

  const free = AUTOMATIC_PORTS.find((port) => !used.has(port));

  if (free === undefined)
    throw new Error("Ports 443 and 8447 are used by other Tailscale Serve entries. Choose another port.");

  return free;
}

function osUser() {
  try {
    return userInfo().username;
  } catch {
    return "$USER";
  }
}

/** The CLI's refusal in words a person can act on. Never more than the first line of its output. */
export function serveError(stderr: string) {
  if (/access denied|permission denied|operator/i.test(stderr))
    return `Tailscale didn't let Canopy change Serve. Run “sudo tailscale set --operator=${osUser()}” once, then try again.`;

  if (/https.*(not enabled|disabled)|enable https|certificate/i.test(stderr))
    return "Turn on HTTPS certificates in the Tailscale admin console.";

  const line = stderr.trim().split("\n")[0]?.slice(0, 200) ?? "";

  return line ? `Tailscale Serve failed: ${line}` : "Tailscale Serve failed.";
}

/** The URL people open: the port is left out when it is 443. */
export const httpsUrl = (host: string, port: number) => (port === 443 ? `https://${host}` : `https://${host}:${port}`);
