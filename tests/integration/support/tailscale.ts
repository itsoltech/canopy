import { chmodSync, copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

const FIXTURE = join(import.meta.dir, "../fixtures/tailscale/tailscale");

export type FakeStatus = {
  backend?: string;
  dnsName?: string;
  ips?: string[];
  certDomains?: string[] | null;
  magicDns?: boolean;
  login?: string;
  tags?: string[];
  tailnet?: string;
};

/** The part of `tailscale serve status --json` the fake keeps. */
export type FakeServe = {
  TCP?: Record<string, { HTTPS?: boolean; TCPForward?: string }>;
  Web?: Record<string, { Handlers: Record<string, { Proxy?: string }> }>;
  AllowFunnel?: Record<string, boolean>;
};

/** Synthetic `tailscale status --json`: the fields Canopy reads plus a peer it must ignore. Addresses are
 * documentation ranges (RFC 5737, RFC 3849), so nothing a test dials can reach a real tailnet. */
export function statusJson(status: FakeStatus = {}) {
  const dnsName = status.dnsName ?? "laptop.example-tailnet.ts.net";

  return {
    Version: "1.0.0-test",
    BackendState: status.backend ?? "Running",
    TailscaleIPs: status.ips ?? ["192.0.2.10", "2001:db8::10"],
    CertDomains: status.certDomains === undefined ? [dnsName] : status.certDomains,
    MagicDNSSuffix: "example-tailnet.ts.net",
    Self: {
      ID: "n1",
      DNSName: `${dnsName}.`,
      HostName: "laptop",
      UserID: 7,
      TailscaleIPs: status.ips ?? ["192.0.2.10", "2001:db8::10"],
      ...(status.tags && { Tags: status.tags }),
    },
    Peer: { "nodekey:peer": { DNSName: "phone.example-tailnet.ts.net.", TailscaleIPs: ["192.0.2.99"] } },
    User: { "7": { ID: 7, LoginName: status.login ?? "owner@example.com", DisplayName: "Owner" } },
    CurrentTailnet: {
      Name: status.tailnet ?? "owner@example.com",
      MagicDNSSuffix: "example-tailnet.ts.net",
      MagicDNSEnabled: status.magicDns ?? true,
    },
  };
}

/** A fake `tailscale` CLI in a fresh directory: `path` is the PATH to give the gateway (the fake and Bun only). */
export function fakeTailscale(dir: string, status: FakeStatus | "down" = {}) {
  const cli = join(dir, "tailscale");
  copyFileSync(FIXTURE, cli);
  chmodSync(cli, 0o755);

  const fake = {
    dir,
    cli,
    path: [dir, dirname(process.execPath)].join(delimiter),
    setStatus(next: FakeStatus | "down") {
      rmSync(join(dir, "down"), { force: true });

      if (next === "down") writeFileSync(join(dir, "down"), "");
      else writeFileSync(join(dir, "status.json"), JSON.stringify(statusJson(next)));
    },
    setServe(config: FakeServe) {
      writeFileSync(join(dir, "serve.json"), JSON.stringify(config));
    },
    serve(): FakeServe {
      return existsSync(join(dir, "serve.json")) ? JSON.parse(readFileSync(join(dir, "serve.json"), "utf8")) : {};
    },
    denyServe(denied = true) {
      if (denied) writeFileSync(join(dir, "serve-denied"), "");
      else rmSync(join(dir, "serve-denied"), { force: true });
    },
    calls(): string[][] {
      return existsSync(join(dir, "calls.jsonl"))
        ? readFileSync(join(dir, "calls.jsonl"), "utf8")
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [];
    },
  };

  fake.setStatus(status);

  return fake;
}

/** A path with nothing on it: detection must find neither the fake nor the real CLI. */
export const EMPTY_PATH = "";
