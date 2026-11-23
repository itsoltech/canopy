import { spawn } from "node:child_process";
import { processGovernor, killProcessTree } from "@canopy/process-governor";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { SkillFileSchema, type ui } from "@canopy/contracts";
import { SKILL_FILE_BYTES, SKILL_TOTAL_BYTES } from "@canopy/domain/skill-artifact";
import { sourceInvalid } from "./source-command.ts";
import { publicSourceAddress } from "./source-address.ts";

export interface SourceTransport {
  signal?: AbortSignal;
  /** Only server bootstrap/test code supplies these. No RPC accepts endpoints or local paths. */
  fixtureRepo?: (url: string) => string | undefined;
}

async function diskBytes(directory: string): Promise<number> {
  let total = 0;

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    try {
      total += entry.isDirectory() ? await diskBytes(path) : (await stat(path)).size;
    } catch (cause) {
      // Git renames pack/lock files while fetching; a vanished entry is counted on the next scan.
      if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
    }

    if (total > 64 * 1024 * 1024) throw new Error("Repository transfer limit exceeded.");
  }

  return total;
}

/** stdout, stderr, time and on-disk transfer are bounded. Errors never contain git output or credentials. */
async function git(
  directory: string,
  config: string[],
  argv: string[],
  secret = "",
  maxBytes = 2 * 1024 * 1024,
  authorizationUrl = "",
  signal?: AbortSignal,
) {
  return processGovernor.run(
    { kind: "git" },
    () =>
      new Promise<Buffer>((resolve, reject) => {
        signal?.throwIfAborted();

        const child = spawn("git", ["--no-pager", ...config, ...argv], {
          cwd: directory,
          detached: process.platform !== "win32",
          env: {
            PATH: process.env["PATH"],
            HOME: directory,
            XDG_CONFIG_HOME: directory,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_COUNT: secret ? "1" : "0",
            ...(secret && {
              GIT_CONFIG_KEY_0: `http.${authorizationUrl}/.extraHeader`,
              GIT_CONFIG_VALUE_0: `Authorization: ${secret}`,
            }),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });

        const chunks: Buffer[] = [];
        let bytes = 0;
        let stopped = false;
        let finished = false;

        const stop = () => {
          if (finished) return;
          stopped = true;

          if (child.pid) void killProcessTree(child.pid);
        };

        const timer = setTimeout(stop, 60_000);
        signal?.addEventListener("abort", stop, { once: true });

        if (signal?.aborted) stop();
        let scanning = false;

        const monitor = setInterval(() => {
          if (scanning || stopped) return;
          scanning = true;
          void diskBytes(directory)
            .catch(stop)
            .finally(() => {
              scanning = false;
            });
        }, 50);

        const count = (data: Buffer) => {
          bytes += data.length;

          if (bytes > maxBytes) stop();
        };

        child.stdout.on("data", (data: Buffer) => {
          count(data);

          if (!stopped) chunks.push(data);
        });
        child.stderr.on("data", count);
        child.on("error", () => {
          finished = true;
          signal?.removeEventListener("abort", stop);
          clearTimeout(timer);
          clearInterval(monitor);
          reject(new Error("Git is unavailable in the gateway."));
        });
        child.on("close", (code) => {
          finished = true;
          signal?.removeEventListener("abort", stop);
          clearTimeout(timer);
          clearInterval(monitor);

          if (code !== 0 || stopped)
            reject(
              new Error("Source fetch failed or exceeded its limits. Check the repository, ref and connector access."),
            );
          else resolve(Buffer.concat(chunks));
        });
      }),
  );
}

export interface GitEntry {
  path: string;
  oid: string;
  executable: boolean;
  size: number;
}

export async function readGitSource<A>(
  source: ui.SkillSource,
  authorization: string,
  transport: SourceTransport,
  read: (commit: string, entries: GitEntry[], blob: (entry: GitEntry) => Promise<Uint8Array>) => Promise<A>,
): Promise<A> {
  transport.signal?.throwIfAborted();
  const url = new URL(source.url);
  const fixture = transport.fixtureRepo?.(source.url);

  const config = [
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "credential.helper=",
    "-c",
    "protocol.allow=never",
    "-c",
    "http.followRedirects=false",
    "-c",
    "http.proxy=",
    "-c",
    "fetch.fsckObjects=true",
    "-c",
    "transfer.bundleURI=false",
    "-c",
    "fetch.uriprotocols=",
  ];

  if (fixture)
    config.push(
      "-c",
      fixture.startsWith("http://127.0.0.1:") ? "protocol.http.allow=always" : "protocol.file.allow=always",
    );
  else {
    const address = await publicSourceAddress(url, transport.signal);
    config.push(
      "-c",
      "protocol.https.allow=always",
      "-c",
      `http.curloptResolve=${url.hostname}:${url.port || "443"}:${address}`,
    );
  }

  const directory = await mkdtemp(join(tmpdir(), "canopy-skill-source-"));

  const run = (argv: string[], secret = "", maxBytes = 2 * 1024 * 1024, authorizationUrl = "") =>
    git(directory, config, argv, secret, maxBytes, authorizationUrl, transport.signal);

  try {
    await run(["init", "--bare", "."]);
    // Depth is required: Git rejects dumb HTTP before walking remote object alternates.
    // Bundle/packfile URI protocols above are disabled so every network request stays on this source.
    await run(
      ["fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "--", fixture ?? source.url, source.ref || "HEAD"],
      authorization,
      2 * 1024 * 1024,
      fixture ?? source.url,
    );
    const commit = (await run(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).toString().trim();

    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Invalid source commit.");
    // -z preserves hostile path bytes, unlike git's quoted display format. No checkout, submodules or filters run.
    const tree = await run(["ls-tree", "-r", "-l", "-z", commit]);
    const entries: GitEntry[] = [];
    let total = 0;

    for (const record of tree.toString("utf8").split("\0")) {
      if (!record) continue;
      const match = record.match(/^(\d+) (\w+) ([a-f0-9]+) +([\d-]+)\t([\s\S]+)$/);

      if (!match || !["100644", "100755"].includes(match[1]!) || match[2] !== "blob")
        sourceInvalid("Repositories containing symlinks, submodules or special entries are rejected.");
      const path = match[5]!;
      const size = Number(match[4]);
      total += size;

      if (size > 16 * SKILL_FILE_BYTES || total > 2 * SKILL_TOTAL_BYTES || entries.length >= 5000)
        sourceInvalid("Repository files exceed the source limits: 16 MiB per repository file, 50 MiB or 5000 files.");
      entries.push({ path, oid: match[3]!, executable: match[1] === "100755", size });
    }

    return await read(commit, entries, async (entry) => {
      // All selected objects arrived in the bounded initial fetch. No lazy fetch may inherit a credential.
      if (entry.size > SKILL_FILE_BYTES) sourceInvalid("Skill files exceed the 1 MiB file limit.");
      const data = await run(["cat-file", "blob", entry.oid], "", SKILL_FILE_BYTES + 1);

      if (data.length !== entry.size) throw new Error("Source file size changed.");

      return data;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export const gitFile = (entry: GitEntry, content: Uint8Array, root: string) =>
  create(SkillFileSchema, {
    path: entry.path.slice(root ? root.length + 1 : 0),
    content,
    executable: entry.executable,
  });
