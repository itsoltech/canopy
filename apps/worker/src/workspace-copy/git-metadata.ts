import { lstat, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { git } from "../git/git.ts";
import { copyError } from "./safety.ts";

export const COPY_GIT_CONFIG = ".git/config";
const CONFIG_LIMIT = 256 * 1024;

/** Only checkout state, history and object storage travel. Local Git policy is rebuilt separately. */
export function copyGitMetadata(path: string): boolean {
  if (path === ".git" || path === COPY_GIT_CONFIG) return true;
  const value = path.slice(5);

  return (
    path.startsWith(".git/") &&
    (/^(?:HEAD|index|packed-refs|shallow|ORIG_HEAD|MERGE_HEAD|MERGE_MSG|CHERRY_PICK_HEAD|REVERT_HEAD|AUTO_MERGE)$/.test(
      value,
    ) ||
      /^sharedindex\.(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ||
      /^(?:refs|logs|reftable)(?:\/|$)/.test(value) ||
      /^(?:objects|objects\/pack|objects\/[a-f0-9]{2})(?:$)/.test(value) ||
      /^objects\/[a-f0-9]{2}\/(?:[a-f0-9]{38}|[a-f0-9]{62})$/.test(value) ||
      /^objects\/pack\/pack-(?:[a-f0-9]{40}|[a-f0-9]{64})\.(?:pack|idx|rev)$/.test(value) ||
      /^info(?:$|\/exclude$)/.test(value))
  );
}

function remoteUrl(value: string): boolean {
  if (/^(?:[a-zA-Z0-9_.-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*:[a-zA-Z0-9_./~-]+$/.test(value))
    return !/^[a-zA-Z]:/.test(value);

  try {
    const url = new URL(value);

    return (
      !!url.hostname &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (url.protocol === "ssh:" || (["https:", "http:", "git:"].includes(url.protocol) && !url.username))
    );
  } catch {
    return false;
  }
}

export async function copyGitConfig(path: string, cwd: string): Promise<Buffer> {
  const info = await lstat(path);

  if (!info.isFile() || info.nlink !== 1 || info.size > CONFIG_LIMIT)
    throw copyError("Could not read portable Git settings.");

  const config = await git(cwd, ["config", "--no-includes", "--file", path, "--null", "--list"], 5_000, {
    maxBytes: CONFIG_LIMIT,
  });

  if (!config.ok) throw copyError("Could not read portable Git settings.");

  const entries = config.stdout.split("\0").flatMap((field) => {
    const separator = field.indexOf("\n");

    return separator < 0 ? [] : [[field.slice(0, separator), field.slice(separator + 1)] as const];
  });

  const objectFormat = entries.findLast(([key]) => key === "extensions.objectformat")?.[1] ?? "sha1";
  const refStorage = entries.findLast(([key]) => key === "extensions.refstorage")?.[1] ?? "files";

  if (!["sha1", "sha256"].includes(objectFormat) || !["files", "reftable"].includes(refStorage))
    throw copyError("This Git repository format cannot be copied.");

  const lines = [
    "[core]",
    `\trepositoryformatversion = ${objectFormat === "sha256" || refStorage === "reftable" ? 1 : 0}`,
    "\tbare = false",
    "\tlogallrefupdates = true",
    `\tfilemode = ${process.platform !== "win32"}`,
  ];

  for (const [key, value] of entries)
    if (
      (key === "core.autocrlf" && /^(?:true|false|input)$/.test(value)) ||
      (key === "core.eol" && /^(?:lf|crlf|native)$/.test(value))
    )
      lines.push(`\t${key.slice(5)} = ${value}`);

  if (objectFormat === "sha256" || refStorage === "reftable") {
    lines.push("[extensions]");

    if (objectFormat === "sha256") lines.push("\tobjectformat = sha256");

    if (refStorage === "reftable") lines.push("\trefstorage = reftable");
  }

  for (const [key, value] of entries) {
    const match = /^(remote|branch)\.([^\r\n]+)\.(url|fetch|remote|merge)$/.exec(key);

    if (!match || !value || [...value].some((char) => char.charCodeAt(0) < 32)) continue;
    const [, section, name, field] = match;

    const allowed =
      section === "remote"
        ? (field === "url" && remoteUrl(value)) ||
          (field === "fetch" && /^\+?refs\/[\w.*/-]+:refs\/remotes\/[\w.*/-]+$/.test(value))
        : (field === "remote" && /^(?:\.|[\w/-]+)$/.test(value)) ||
          (field === "merge" && /^refs\/heads\/[\w./-]+$/.test(value));

    if (allowed) lines.push(`[${section} ${quote(name!)}]`, `\t${field} = ${quote(value)}`);
  }

  return Buffer.from(lines.join("\n") + "\n");
}

const quote = (text: string) => '"' + text.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';

/** Older sources can send the original configuration. Do not give it to Git as repository policy. */
export async function rebuildCopyGitMetadata(stage: string, paths: readonly string[]) {
  const configPath = join(stage, COPY_GIT_CONFIG);
  const config = await copyGitConfig(configPath, stage);

  for (const path of paths
    .filter((value) => value.startsWith(".git/") && !copyGitMetadata(value))
    .sort((a, b) => a.length - b.length))
    await rm(join(stage, path), { recursive: true, force: true });

  const temporary = join(stage, ".git", `canopy-config-${crypto.randomUUID()}`);
  const output = await open(temporary, "wx", 0o600);

  try {
    try {
      await output.writeFile(config);
      await output.sync();
    } finally {
      await output.close();
    }

    await rename(temporary, configPath);
  } finally {
    await rm(temporary, { force: true });
  }
}
