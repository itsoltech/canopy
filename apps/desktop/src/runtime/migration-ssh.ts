import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Schema } from "effect";
import type { CutoverRequest } from "../../../gateway/src/migration/cutover-protocol.ts";
import { targetHost } from "./migration-state.ts";

const parseTarget = Schema.decodeUnknownSync(targetHost);
const outputLimit = 4 * 1024 * 1024;

type MigrationBody = { bundle: string } | { secrets: Buffer };

export function migrationSshTarget(invitation: string) {
  try {
    return parseTarget(invitation.trim());
  } catch {
    throw new Error("Enter an SSH host or an SSH target in the form user@host.");
  }
}

async function* streamRequest(request: CutoverRequest, body?: MigrationBody) {
  yield Buffer.from(JSON.stringify(request) + "\n");

  if (!body) return;

  if ("bundle" in body) {
    yield* createReadStream(join(body.bundle, "manifest.json"));
    yield* createReadStream(join(body.bundle, "database.dump"));
  } else yield body.secrets;
}

export async function bundleSizes(path: string) {
  const [manifest, archive] = await Promise.all([stat(join(path, "manifest.json")), stat(join(path, "database.dump"))]);

  return { manifestBytes: manifest.size, archiveBytes: archive.size };
}

/** Only the fixed receiver can be invoked. The host must already be trusted by OpenSSH. */
export async function migrationSsh(
  target: string,
  request: CutoverRequest,
  env: NodeJS.ProcessEnv,
  signal: AbortSignal,
  body?: MigrationBody,
) {
  const controller = new AbortController();
  const deadline = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(60 * 60_000)]);

  const args = [
    "-T",
    "-oBatchMode=yes",
    "-oStrictHostKeyChecking=yes",
    "-oConnectTimeout=10",
    "-oClearAllForwardings=yes",
    "-oUpdateHostKeys=no",
    "-oPermitLocalCommand=no",
    "-oForwardAgent=no",
    "-oControlPath=none",
    "-oServerAliveInterval=15",
    "-oServerAliveCountMax=3",
    "--",
    parseTarget(target),
    "canopy-gateway",
    "migration",
    "cutover-target",
  ];

  const child = spawn("ssh", args, { env, signal: deadline, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  child.on("error", () => {});
  const sent = pipeline(Readable.from(streamRequest(request, body)), child.stdin);
  sent.catch(() => {});

  try {
    const output: Buffer[] = [];
    let bytes = 0;

    for await (const part of child.stdout) {
      const chunk = Buffer.from(part);
      bytes += chunk.length;

      if (bytes > outputLimit) throw new Error("The destination sent a migration report that exceeds the size limit.");
      output.push(chunk);
    }

    const code = await closed;

    if (code !== 0)
      throw new Error(
        "The destination did not confirm this migration step. Check SSH access and the migration configuration on the server.",
      );
    await sent;

    return Buffer.concat(output).toString("utf8");
  } finally {
    controller.abort();
    await Promise.allSettled([closed, sent]);
  }
}
