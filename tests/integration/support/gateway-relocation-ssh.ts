import { mkdir, readFile, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";
import { type CutoverTargetState } from "../../../apps/gateway/src/migration/cutover-protocol.ts";
import { sshCutover, type SshConfig } from "../../../apps/gateway/src/migration/cutover-ssh.ts";
import { bun, relocationEntry } from "./gateway-relocation-entry.ts";

export function loopbackPort() {
  const reservation = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = reservation.port;
  reservation.stop();

  return port;
}

const shellWord = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";

type FaultPhase = Extract<CutoverTargetState["phase"], "restored" | "active"> | "applied";

export async function relocationSsh(directory: string, environmentFile: string) {
  const sshd = Bun.which("sshd");

  if (!sshd) throw new Error("OpenSSH sshd is required by the relocation fixture");

  const port = loopbackPort();
  const username = userInfo().username;
  const hostKey = join(directory, "host-key");
  const identityFile = join(directory, "client-key");
  const knownHostsFile = join(directory, "known-hosts");
  const authorizedKeys = join(directory, "authorized-keys");
  const faults = join(directory, "faults");
  const forceCommand = [...bun, relocationEntry, "receiver", environmentFile, faults].map(shellWord).join(" ");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(faults, { mode: 0o700 });

  const keys = [hostKey, identityFile].map(
    (path) =>
      Bun.spawn(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", path], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
      }).exited,
  );

  if ((await Promise.all(keys)).some((code) => code !== 0)) throw new Error("Could not generate loopback SSH keys");

  await writeFile(authorizedKeys, `restrict ${await readFile(identityFile + ".pub", "utf8")}`, { mode: 0o600 });
  await writeFile(knownHostsFile, `[127.0.0.1]:${port} ${await readFile(hostKey + ".pub", "utf8")}`, { mode: 0o600 });

  const daemon = Bun.spawn(
    [
      sshd,
      "-D",
      "-e",
      "-f",
      "/dev/null",
      "-p",
      String(port),
      "-h",
      hostKey,
      "-o",
      "ListenAddress=127.0.0.1",
      "-o",
      `PidFile=${join(directory, "pid")}`,
      "-o",
      `AuthorizedKeysFile=${authorizedKeys}`,
      "-o",
      `AllowUsers=${username}`,
      "-o",
      "StrictModes=no",
      "-o",
      "PubkeyAuthentication=yes",
      "-o",
      "AuthenticationMethods=publickey",
      "-o",
      "PasswordAuthentication=no",
      "-o",
      "KbdInteractiveAuthentication=no",
      "-o",
      "UsePAM=no",
      "-o",
      "PermitUserRC=no",
      "-o",
      "DisableForwarding=yes",
      "-o",
      "PermitTTY=no",
      "-o",
      `ForceCommand=${forceCommand}`,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );

  const stderr = new Response(daemon.stderr).text();
  const config: SshConfig = { destination: `${username}@127.0.0.1`, port, knownHostsFile, identityFile };

  async function close() {
    if (daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
    await daemon.exited;
    await stderr;
  }

  try {
    const status = { action: "status", version: 1, runId: crypto.randomUUID() } as const;
    const deadline = performance.now() + 6_000;

    for (;;) {
      try {
        if ((await sshCutover(config, status)).phase !== "absent") throw new Error("Unexpected SSH readiness state");
        break;
      } catch (error) {
        if (daemon.exitCode !== null || performance.now() >= deadline) throw error;
        await Bun.sleep(50);
      }
    }

    return {
      config,
      close,
      dropReply: (phase: FaultPhase) => writeFile(join(faults, phase), "", { mode: 0o600, flag: "wx" }),
      droppedReply: (phase: FaultPhase) => Bun.file(join(faults, phase + ".dropped")).exists(),
    };
  } catch {
    await close();
    throw new Error(`Could not start the private SSH receiver:\n${await stderr}`);
  }
}
