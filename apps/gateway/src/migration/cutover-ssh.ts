import { spawn } from "node:child_process";
import { once } from "node:events";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Schema } from "effect";
import { CutoverError } from "./cutover-files.ts";
import { decodeTargetState, type CutoverRequest } from "./cutover-protocol.ts";

export const sshConfig = Schema.Struct({
  destination: Schema.String.check(
    Schema.makeFilter((value) => {
      const parts = value.split("@");
      const host = parts.at(-1) ?? "";

      return (
        value.length <= 300 &&
        parts.length <= 2 &&
        (parts.length === 1 || /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(parts[0] ?? "")) &&
        (isIP(host) !== 0 || /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host))
      );
    }),
  ),
  port: Schema.optional(Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  knownHostsFile: Schema.optional(Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/))),
  identityFile: Schema.optional(Schema.String.check(Schema.isPattern(/^\/[A-Za-z0-9_./-]+$/))),
});

export type SshConfig = typeof sshConfig.Type;

const sshError =
  "The SSH cutover request failed. Check host key authentication, target configuration, and the current cutover status.";

function sshArgs(config: SshConfig) {
  const args = [
    "-F",
    "/dev/null",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "UpdateHostKeys=no",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ConnectTimeout=15",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
  ];

  if (config.port) args.push("-p", String(config.port));

  if (config.knownHostsFile)
    args.push("-o", `UserKnownHostsFile=${config.knownHostsFile}`, "-o", "GlobalKnownHostsFile=/dev/null");

  if (config.identityFile) args.push("-i", config.identityFile, "-o", "IdentitiesOnly=yes");

  return [...args, "--", config.destination, "canopy-gateway migration cutover-target"];
}

async function readReply(stream: Readable) {
  const chunks: Buffer[] = [];
  let bytes = 0;

  for await (const chunk of stream) {
    if (!Buffer.isBuffer(chunk)) throw new CutoverError(sshError);
    bytes += chunk.length;

    if (bytes > 8192) throw new CutoverError(sshError);
    chunks.push(chunk);
  }

  return decodeTargetState(Buffer.concat(chunks).toString("utf8"));
}

export async function sshCutover(config: SshConfig, input: AsyncIterable<Buffer> | CutoverRequest) {
  try {
    const child = spawn("ssh", sshArgs(config), { stdio: ["pipe", "pipe", "ignore"] });
    const exited = once(child, "close");
    const body = Symbol.asyncIterator in input ? Readable.from(input) : Readable.from([JSON.stringify(input) + "\n"]);

    try {
      const [[code], output] = await Promise.all([exited, readReply(child.stdout), pipeline(body, child.stdin)]);

      if (code !== 0) throw new CutoverError(sshError);

      return output;
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await exited.catch(() => undefined);
    }
  } catch {
    throw new CutoverError(sshError);
  }
}
