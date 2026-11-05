import { Code, ConnectError } from "@connectrpc/connect";
import type { ui } from "@canopy/contracts";
import type { ReleaseManifest } from "@canopy/updater";

const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

const platforms = [
  { os: "linux", arch: "x64", pattern: "Linux/x86_64|Linux/amd64" },
  { os: "linux", arch: "arm64", pattern: "Linux/aarch64|Linux/arm64" },
  { os: "darwin", arch: "arm64", pattern: "Darwin/arm64" },
];

/** URL normalisation also catches shortened IPv4 and IPv4-mapped IPv6 loopback. */
export function localWorkerAddress(value: string): boolean {
  const host = new URL(value).hostname.toLowerCase().replace(/\.$/, "");

  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.startsWith("127.") ||
    host === "0.0.0.0" ||
    host === "[::]" ||
    host === "[::1]" ||
    /^\[::ffff:(?:7f[0-9a-f]{2}:|0:0\])/.test(host)
  );
}

/** This gateway over Tailscale: the listener's tailnet origin, or only that Tailscale is connected. */
export type TailnetHint = { origin: string; connected: boolean };

export function requireRemoteWorkerAddress(
  gatewayUrl: string,
  targetHost: string,
  tailnet: TailnetHint = { origin: "", connected: false },
): void {
  if (
    !gatewayUrl ||
    (localWorkerAddress(gatewayUrl) &&
      !localWorkerAddress(`http://${targetHost.includes(":") ? `[${targetHost}]` : targetHost}`))
  )
    throw new ConnectError(
      tailnet.origin
        ? `Set the gateway address for workers to ${tailnet.origin} (Tailscale), or leave it empty to use it automatically.`
        : tailnet.connected
          ? "Turn on network access to reach this computer over Tailscale, or set a gateway address for workers."
          : "Turn on network access or set a gateway address for workers.",
      Code.FailedPrecondition,
    );
}

/** Fixed stdin only: HTTPS plus a manifest hash delivered through the trusted SSH connection. */
export function workerSshCommand(
  setup: ui.GetWorkerSetupResponse,
  manifest: ReleaseManifest,
  gatewayVersion: string,
  token: string,
  name: string,
): string {
  const cases = manifest.assets.flatMap((asset) => {
    const pattern = platforms.find((platform) => platform.os === asset.os && platform.arch === asset.arch)?.pattern;

    if (asset.app !== "worker" || !pattern) return [];

    return [`${pattern}) set -- "$@" --release-url ${quote(asset.url)} --release-sha256 ${quote(asset.sha256)} ;;`];
  });

  const message =
    manifest.version === gatewayVersion
      ? `Downloading GitHub release ${manifest.version}, matching this gateway.`
      : `Gateway version ${gatewayVersion} is unavailable. Using compatible GitHub channel release ${manifest.version}.`;

  return `set +x
set -eu
umask 077
set -- --gateway ${quote(setup.gatewayUrl)}${setup.gatewayFingerprint ? ` --fingerprint ${quote(setup.gatewayFingerprint)}` : ""} --token ${quote(token)} --name ${quote(name)}
printf '%s\\n' ${quote(message)}
case "$(uname -s)/$(uname -m)" in
${cases.join("\n")}
*) printf '%s\\n' 'Canopy: No worker binary for this platform. Choose Linux x64/arm64 or macOS arm64.' >&2; exit 1 ;;
esac
`;
}
