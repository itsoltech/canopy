import { isIP } from "node:net";
import { Option, Schema } from "effect";
import type { JsonValue } from "@canopy/domain";

/** What Settings shows: not_installed (no CLI or LocalAPI), not_running (no tailscaled), stopped
 * (`tailscale down`), logged_out (needs a login or the admin's approval), starting, connected. */
export type TailscaleState = "not_installed" | "not_running" | "stopped" | "logged_out" | "starting" | "connected";

export type TailscaleSnapshot = {
  state: TailscaleState;
  /** This computer's MagicDNS name, without the trailing dot; empty without MagicDNS. */
  dnsName: string;
  ipv4: string[];
  ipv6: string[];
  tailnet: string;
  magicDns: boolean;
  /** Names the tailnet can get HTTPS certificates for; empty while HTTPS is off in the admin console. */
  certDomains: string[];
  /** The login of the user who owns this computer; empty for a tagged computer. */
  login: string;
  tagged: boolean;
  checkedAt: number;
};

export const NOT_INSTALLED: Omit<TailscaleSnapshot, "checkedAt"> = {
  state: "not_installed",
  dnsName: "",
  ipv4: [],
  ipv6: [],
  tailnet: "",
  magicDns: false,
  certDomains: [],
  login: "",
  tagged: false,
};

const Strings = Schema.optional(Schema.NullOr(Schema.Array(Schema.String)));

// Only the fields Canopy reads; tailscaled sends many more (peers, keys, traffic), never kept or logged.
const Status = Schema.Struct({
  BackendState: Schema.String,
  TailscaleIPs: Strings,
  CertDomains: Strings,
  MagicDNSSuffix: Schema.optional(Schema.String),
  Self: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        DNSName: Schema.optional(Schema.String),
        UserID: Schema.optional(Schema.Number),
        Tags: Strings,
        TailscaleIPs: Strings,
      }),
    ),
  ),
  User: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Struct({ LoginName: Schema.String })))),
  CurrentTailnet: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ Name: Schema.optional(Schema.String), MagicDNSEnabled: Schema.optional(Schema.Boolean) }),
    ),
  ),
});

const decodeStatus = Schema.decodeUnknownOption(Status);

const STATES = new Map<string, TailscaleState>([
  ["Running", "connected"],
  ["Starting", "starting"],
  ["Stopped", "stopped"],
  ["NeedsLogin", "logged_out"],
  ["NeedsMachineAuth", "logged_out"],
  ["NoState", "starting"],
]);

function parseJson(text: string): Option.Option<JsonValue> {
  try {
    const json: JsonValue = JSON.parse(text);

    return Option.some(json);
  } catch {
    return Option.none();
  }
}

/** `tailscale status --json` (or LocalAPI /localapi/v0/status) as the few facts Settings needs.
 * Anything unreadable counts as "not running": the gateway never fails because of Tailscale. */
export function parseStatus(text: string, checkedAt = Date.now()): TailscaleSnapshot {
  const status = Option.getOrUndefined(Option.flatMap(parseJson(text), (json) => decodeStatus(json)));

  if (!status) return { ...NOT_INSTALLED, state: "not_running", checkedAt };

  const state = STATES.get(status.BackendState) ?? "starting";
  const self = status.Self ?? undefined;
  const ips = self?.TailscaleIPs ?? status.TailscaleIPs ?? [];
  const tags = self?.Tags ?? [];
  const tailnet = status.CurrentTailnet ?? undefined;
  const dnsName = (self?.DNSName ?? "").replace(/\.$/, "").toLowerCase();
  const owner = self?.UserID === undefined ? undefined : status.User?.[String(self.UserID)];

  if (state !== "connected") return { ...NOT_INSTALLED, state, checkedAt };

  return {
    state,
    dnsName,
    ipv4: ips.filter((ip) => isIP(ip) === 4),
    ipv6: ips.filter((ip) => isIP(ip) === 6),
    tailnet: tailnet?.Name ?? "",
    magicDns: Boolean(tailnet?.MagicDNSEnabled ?? status.MagicDNSSuffix) && Boolean(dnsName),
    certDomains: (status.CertDomains ?? []).map((d) => d.replace(/\.$/, "").toLowerCase()),
    login: tags.length ? "" : (owner?.LoginName ?? ""),
    tagged: tags.length > 0,
    checkedAt,
  };
}
