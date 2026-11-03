import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import type { ui } from "@canopy/contracts";
import { dockerAvailable } from "@canopy/db/testing";
import { installResponse } from "../../apps/web/src/lib/server/worker-install.ts";
import { eventually, startTestGateway, type TestGateway } from "./support/gateway.ts";

let gw: TestGateway;
let directory = "";
let server: ReturnType<typeof Bun.serve>;
let sha = "";
let corruptDownload = false;
const binary = resolve("dist/release/canopy-worker-linux-x64");
const realBinary = process.env["CANOPY_INSTALL_BINARY_TEST"] === "1";
const sshContainer = process.env["CANOPY_SSH_CONTAINER_TEST"] === "1";

describe.skipIf(!dockerAvailable)("worker installer and BFF mirror boundary", () => {
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "canopy-install-test-"));
    const version = realBinary ? Bun.spawnSync([binary, "--version"]).stdout.toString().trim() : "2.0.0";
    gw = await startTestGateway({ updates: { cacheDir: join(directory, "mirror"), version } });
    const bytes = realBinary ? readFileSync(binary) : Buffer.from("verified release bytes");
    sha = createHash("sha256").update(bytes).digest("hex");
    const mirror = gw.core.updates.service.options.mirror;
    await mirror.remember({ schema: 1, version: gw.core.updates.version, channel: "nightly", commit: "fixture", published_at: new Date().toISOString(),
      protocol: { worker_link: 1, update: 1 }, assets: [{ app: "worker", os: "linux", arch: "x64", name: "canopy-worker-linux-x64", sha256: sha, size: bytes.length,
        url: "https://github.com/itsoltech/canopy/releases/download/v0.0.0/canopy-worker-linux-x64" }] });
    await Bun.write(join(mirror.directory, sha), bytes);
    server = Bun.serve({ port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/install/worker.sh") return new Response((await Bun.file("scripts/install-worker.sh").text()).replace("CANOPY_INSTALL_ORIGIN_DEFAULT", url.origin));
      const match = /^\/install\/worker\/([^/]+)\/([^/]+)$/.exec(url.pathname);
      if (!match) return new Response("not found", { status: 404 });
      if (corruptDownload && !url.searchParams.has("sha256")) return new Response("corrupt download");
      try { return await installResponse(gw.api, match[1]!, match[2]!, url.searchParams.has("sha256"), request.signal); }
      catch (error) { return new Response(error instanceof Error ? error.message : "Unavailable", { status: 400 }); }
    } });
  }, 60_000);
  afterAll(async () => { server?.stop(true); await gw?.close(); if (directory) rmSync(directory, { recursive: true, force: true }); });

  test("BFF streams verified exact-version bytes and checksum, refuses unsupported platforms", async () => {
    const response = await fetch(new URL("/install/worker/linux/x64", server.url));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-canopy-version")).toBe(gw.core.updates.version);
    expect(createHash("sha256").update(Buffer.from(await response.arrayBuffer())).digest("hex")).toBe(sha);
    expect((await (await fetch(new URL("/install/worker/linux/x64?sha256=1", server.url))).text()).trim()).toBe(sha);
    for (const platform of ["darwin/x64", "windows/x64", "linux/riscv64", "unknown/x64"]) {
      const rejected = await fetch(new URL(`/install/worker/${platform}`, server.url));
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain("Supported platforms");
    }
    expect(await (await fetch(new URL("/install/worker/darwin/arm64", server.url))).text()).toContain("No verified worker binary");
  });

  test("installer refuses a corrupted download before execution or enrollment", async () => {
    corruptDownload = true;
    const home = join(directory, "corrupt-home");
    const invitation = await gw.api.createWorkerEnrollment({ name: "Corrupt download" });
    try {
      const proc = Bun.spawn(["sh", "scripts/install-worker.sh", "--origin", server.url.origin, "--gateway", gw.grpcUrl, "--token", invitation.token, "--no-service"], {
        env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
      });
      const [output, errors, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(1); expect(errors).toContain("SHA-256 mismatch");
      expect(existsSync(join(home, ".config/canopy/worker.json"))).toBe(false);
      expect(existsSync(join(home, ".local/share/canopy/bin/canopy-worker"))).toBe(false);
      expect((await gw.api.getWorkerSetup({})).enrollments.find((e) => e.id === invitation.enrollment!.id)?.usedAt).toBeUndefined();
      expect(output + errors).not.toContain(invitation.token);
    } finally { corruptDownload = false; }
  });

  test.skipIf(!realBinary)("real binary installs under temporary HOME, enrolls, connects, refuses config overwrite", async () => {
    expect(existsSync(binary)).toBe(true);
    const home = join(directory, "home");
    const invitation = await gw.api.createWorkerEnrollment({ name: "Script installation" });
    const proc = Bun.spawn(["sh", "scripts/install-worker.sh", "--origin", server.url.origin, "--gateway", gw.grpcUrl, "--token", invitation.token, "--no-service"], {
      env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe",
    });
    const [output, errors, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, errors }).toEqual({ code: 0, errors: "" });
    const configPath = join(home, ".config/canopy/worker.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { credential: string; worker_id: string };
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    expect(output).not.toContain(invitation.token); expect(output).not.toContain(config.credential);
    const installed = join(home, ".local/share/canopy/bin/canopy-worker");
    expect(Bun.spawnSync([installed, "--version"]).stdout.toString().trim()).toBe(gw.core.updates.version);
    const worker = Bun.spawn([installed, "--config", configPath], { env: { ...process.env, HOME: home }, stdout: "ignore", stderr: "ignore" });
    try {
      expect((await eventually(() => gw.api.getOverview({}), (o) => o.workers.some((w) => w.id === config.worker_id && w.online), 15_000)).workers.some((w) => w.id === config.worker_id && w.online)).toBe(true);
    } finally { worker.kill("SIGTERM"); await worker.exited; }
    const rerun = Bun.spawn(["sh", "scripts/install-worker.sh", "--origin", server.url.origin, "--gateway", gw.grpcUrl, "--token", invitation.token, "--no-service"], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    const [rerunOutput, , rerunCode] = await Promise.all([new Response(rerun.stdout).text(), new Response(rerun.stderr).text(), rerun.exited]);
    expect(rerunCode).toBe(0);
    expect(rerunOutput).toContain("Existing config preserved");
    expect(readFileSync(configPath, "utf8")).toContain(config.worker_id);
  }, 60_000);

  test.skipIf(!realBinary || !sshContainer)("real sshd: confirmed host, wrong key, service dry-run, worker connects, changed host rejected", async () => {
    const name = `canopy-ssh-install-${Bun.randomUUIDv7().slice(-12)}`;
    const reservation = createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const run = Bun.spawnSync(["docker", "run", "-d", "--rm", "--name", name, "--network", "host", "canopy-worker-install-sshd:test", "sh", "-c",
      `ssh-keygen -A && exec /usr/sbin/sshd -D -e -p ${port} -o PasswordAuthentication=no -o PermitEmptyPasswords=no -o AllowUsers=canopy`]);
    expect(run.exitCode).toBe(0);
    const target = `canopy@127.0.0.1:${port}`;
    async function ssh(action: string, fingerprint = "") {
      const events: ui.WorkerSshEvent[] = [];
      for await (const event of gw.api.workerSsh({ action, target, fingerprint, name: "SSH-installed worker", webOrigin: server.url.origin }, { timeoutMs: 90_000 })) events.push(event);
      return events;
    }
    try {
      await eventually(async () => Bun.spawnSync(["docker", "exec", name, "test", "-f", "/etc/ssh/ssh_host_ed25519_key"]).exitCode, (code) => code === 0, 10_000);
      await gw.api.updateUserSettings({ expectedVersion: (await gw.api.getSettings({})).user!.version, workerGatewayUrl: gw.grpcUrl });
      const key = (await ssh("key"))[0]!.publicKey;
      const probe = await ssh("probe");
      const fingerprint = probe.find((e) => e.fingerprint)!.fingerprint;
      expect(probe.find((e) => e.fingerprint)!.trusted).toBe(false);
      const wrong = await ssh("install", fingerprint).then(() => "", (e: Error) => e.message);
      expect(wrong).toContain("Add this Canopy public key");
      const publicFile = join(directory, "authorized_keys");
      await Bun.write(publicFile, key + "\n");
      expect(Bun.spawnSync(["docker", "cp", publicFile, `${name}:/home/canopy/.ssh/authorized_keys`]).exitCode).toBe(0);
      expect(Bun.spawnSync(["docker", "exec", name, "chown", "canopy:canopy", "/home/canopy/.ssh/authorized_keys"]).exitCode).toBe(0);
      expect(Bun.spawnSync(["docker", "exec", name, "chmod", "600", "/home/canopy/.ssh/authorized_keys"]).exitCode).toBe(0);
      const events = await ssh("install", fingerprint);
      const invitation = events.find((e) => e.enrollment)!.enrollment!;
      const overview = await eventually(() => gw.api.getOverview({}), (o) => o.workers.some((w) => w.name === "SSH-installed worker" && w.online), 15_000);
      expect(overview.workers.some((w) => w.name === "SSH-installed worker" && w.online)).toBe(true);
      const output = events.map((e) => e.output).join("");
      expect(output).toContain("Worker enrolled");
      expect(output).not.toContain("credential");
      const unit = Bun.spawnSync(["docker", "exec", name, "cat", "/home/canopy/.config/systemd/user/canopy-worker.service"]).stdout.toString();
      expect(unit).toContain("Restart=always"); expect(unit).toContain("/home/canopy/.local/bin");
      expect(unit).toContain("mise"); expect(unit).toContain(".npm-global/bin");
      const activation = Bun.spawnSync(["docker", "exec", name, "cat", "/home/canopy/systemctl-calls"]).stdout.toString();
      expect(activation).toContain("--user restart canopy-worker.service");
      expect((await gw.api.getWorkerSetup({})).enrollments.find((e) => e.id === invitation.id)?.usedAt).toBeDefined();
      expect(Bun.spawnSync(["docker", "exec", name, "sh", "-c", "rm -f /etc/ssh/ssh_host_* && ssh-keygen -A"]).exitCode).toBe(0);
      expect(Bun.spawnSync(["docker", "restart", name]).exitCode).toBe(0);
      const mismatch = await eventually(() => ssh("probe").then(() => "", (e: Error) => e.message), (message) => message.includes("host key changed"), 10_000);
      expect(mismatch).toContain("host key changed");
    } finally { Bun.spawnSync(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" }); }
  }, 120_000);
});
