import { expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { tempDirs } from "@canopy/testing";
import { Result } from "effect";
import {
  createRelocationSandbox,
  privateFile,
  relocationAvailable,
} from "../../../tests/integration/support/gateway-relocation.ts";
import type { SshConfig } from "../../gateway/src/migration/cutover-ssh.ts";
import { parseLocalConfig } from "../../worker/src/config/local.ts";
import { remoteWorkerDirectory } from "../src/remote-client.ts";
import { runtimePaths } from "../src/runtime/launch.ts";
import { DesktopGatewayMigration } from "../src/runtime/migration-desktop.ts";
import { MigrationJournalFile } from "../src/runtime/migration-state.ts";
import { DesktopRuntime, type Secrets } from "../src/runtime/runtime.ts";
import { postgresArchive, postgresRegistry } from "./postgres-fixture.ts";

const temp = tempDirs();
const build = process.env["CANOPY_DESKTOP_RUNTIME"] ?? resolve(import.meta.dir, "../build/runtime");

function useLoopbackSsh(directory: string, host: SshConfig) {
  const binary = Bun.which("ssh");
  const executable = process.execPath;
  const bin = join(directory, "bin");

  if (!binary || !host.port || !host.identityFile || !host.knownHostsFile || !host.destination.endsWith("@127.0.0.1"))
    throw new Error("The migration test requires isolated loopback SSH credentials");

  const args = [
    binary,
    "-F",
    "/dev/null",
    "-p",
    String(host.port),
    "-i",
    host.identityFile,
    "-oIdentitiesOnly=yes",
    "-oUserKnownHostsFile=" + host.knownHostsFile,
    "-oGlobalKnownHostsFile=/dev/null",
  ];

  mkdirSync(bin);
  symlinkSync("/usr/bin/false", join(bin, "tailscale"));
  writeFileSync(
    join(bin, "ssh"),
    `#!${executable}\nimport {appendFileSync} from "node:fs";\nconst args = Bun.argv.slice(2); if (args[args.indexOf("--") + 1] !== ${JSON.stringify(host.destination)}) process.exit(64);\nconst child=Bun.spawn([${args.map((arg) => JSON.stringify(arg)).join(",")}, ...args], {stdin:"inherit",stdout:"inherit",stderr:"pipe"});\nconst [code,error]=await Promise.all([child.exited,new Response(child.stderr).text()]);\nif(code && error) appendFileSync(${JSON.stringify(join(bin, "ssh-errors"))},error,{mode:0o600});\nprocess.exit(code);\n`,
    { mode: 0o700 },
  );

  const fixtureEnvironment = {
    PATH: [bin, "/usr/bin", "/bin"].join(delimiter),
    HOME: directory,
    XDG_CONFIG_HOME: join(directory, "config"),
    XDG_CACHE_HOME: join(directory, "cache"),
    XDG_DATA_HOME: join(directory, "data"),
  };

  const previous = Object.entries(fixtureEnvironment).map(([name]) => [name, process.env[name]] as const);
  Object.assign(process.env, fixtureEnvironment);

  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

async function migrateDesktop(kind: "move" | "join") {
  const scratch = temp("desktop-");
  const fixture = postgresArchive(join(scratch, "pg"));
  const registry = await postgresRegistry(fixture.bytes);
  const paths = { ...runtimePaths(build), postgres: fixture.manifest };
  const directory = join(scratch, "source");
  const destination = join(scratch, "server");
  mkdirSync(directory, { mode: 0o700 });
  mkdirSync(destination, { mode: 0o700 });
  const sandbox = await createRelocationSandbox(destination);
  const key = randomBytes(32);
  key[31] = 13; // A canonical 32-byte base64 key can end in 0=.

  const secrets: Secrets = {
    databasePassword: randomBytes(32).toString("hex"),
    runtimeDatabasePassword: randomBytes(32).toString("hex"),
    secretsKey: key.toString("base64"),
    serviceToken: randomBytes(32).toString("hex"),
  };

  const launch = () => new DesktopRuntime(directory, paths, secrets, undefined, { registry: registry.registry });
  let desktop: DesktopRuntime | undefined;
  let restoreEnvironment: (() => void) | undefined;

  try {
    const joining = kind === "join";

    const target = await sandbox.host("target", {
      major: 18,
      ownerEmail: "dev@localhost",
      ...(joining && { migrated: true, secretsKey: randomBytes(32).toString("base64") }),
    });

    await privateFile(target.configPath, JSON.stringify({ ...target.config, networkOrigins: [target.networkUrl] }));

    if (joining) {
      await target.start();
      await target.api.updateNetworkAccess({ action: "set_enabled", enabled: true });
      await target.api.createProject({ name: "Already on the shared gateway" });
    }

    const ssh = await sandbox.ssh(target);
    restoreEnvironment = useLoopbackSsh(directory, ssh.config);
    desktop = launch();
    await desktop.initialize(false);
    await desktop.configure({ mode: "local", allowNetwork: false, bindHost: "127.0.0.1" });
    await desktop.client().updateNetworkAccess({ action: "set_enabled", enabled: true });
    const { project } = await desktop.client().createProject({ name: "Before Desktop migration" });

    const original = Result.getOrThrow(
      parseLocalConfig(readFileSync(join(directory, "local-worker", "worker.json"), "utf8")),
    );

    const migration = new DesktopGatewayMigration(desktop, secrets.secretsKey);
    const prepared = await migration.prepare({ kind, invitation: ssh.config.destination });
    const errors = join(directory, "bin", "ssh-errors");

    if (prepared.migration.phase === "error" && existsSync(errors)) throw new Error(readFileSync(errors, "utf8"));

    expect(prepared).toMatchObject({
      migration: { phase: "prepared" },
    });
    expect(target.starts).toBe(joining ? 1 : 0);
    const token = "canopy_desktop_" + randomBytes(32).toString("base64url");

    const device = {
      id: randomUUID(),
      tokenHash: createHash("sha256").update(token).digest("hex"),
      name: "Fixture Desktop",
      platform: "linux" as const,
    };

    const lostReply = joining ? "applied" : "active";
    await ssh.dropReply(lostReply);
    let activated = await migration.activate(device);

    if (joining) {
      expect(activated.migration.phase).toBe("fenced");
      const review = activated.migration.preparation?.review;

      if (!review || review.blockers.length) throw new Error("The Desktop join review did not permit import");

      activated = await migration.activate(device, {
        reviewDigest: review.reviewDigest,
        conflictChoices: Object.fromEntries(review.conflicts.map(({ id }) => [id, "target"])),
        approvedSecretIds: [],
      });
    }

    expect(activated.migration).toMatchObject({ phase: "switching" });
    expect(await ssh.droppedReply(lostReply)).toBe(true);
    await desktop.stop();
    migration.stop();
    desktop = launch();
    await desktop.initialize(false);
    await desktop.restore();
    expect(desktop.pids).toEqual([]);
    const recovery = new DesktopGatewayMigration(desktop, secrets.secretsKey);
    const journal = new MigrationJournalFile(directory).read();

    if (!journal?.profile || !journal.routes) throw new Error("Missing durable Desktop handoff");

    expect(
      await recovery.complete({
        token,
        deviceId: device.id,
        fingerprint: journal.routes.fingerprint,
        addresses: [...journal.routes.addresses],
      }),
    ).toMatchObject({ migration: { phase: "completed" } });
    expect(desktop.status).toMatchObject({ mode: "remote", worker: "online", workerId: original.worker_id });
    const profile = remoteWorkerDirectory(directory, { mode: "remote", gatewayUrl: journal.profile });
    const remote = Result.getOrThrow(parseLocalConfig(readFileSync(join(profile, "worker.json"), "utf8")));
    expect(remote.credential === original.credential && remote.data_dir === original.data_dir).toBe(true);
    expect((await target.api.getOverview({})).projects.some(({ id }) => id === project?.id)).toBe(true);
    expect(target.starts).toBe(joining ? 2 : 1);
    recovery.stop();
  } finally {
    await desktop?.stop();
    restoreEnvironment?.();
    await Promise.all([registry.close(), sandbox.close()]);
    rmSync(scratch, { recursive: true, force: true });
  }
}

for (const kind of ["move", "join"] as const)
  test.skipIf(!relocationAvailable || !existsSync(runtimePaths(build).gateway))(
    `Desktop completes ${kind} over real SSH and resumes Remote after restarting during handoff`,
    () => migrateDesktop(kind),
    120_000,
  );
