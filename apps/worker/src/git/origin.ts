import { normalizeGitOrigin } from "@canopy/domain/projects";
import { processKey, runProcess } from "@canopy/process-governor";
import { cloneUrl } from "./project-sources.ts";
import { resolve } from "node:path";
import { originFiles } from "./origin-files.ts";

type Origin = { workspaceOrigin: string; workspaceCloneUrl: string };

const origins = new Map<string, { signature: string; value: Origin }>();
const pending = new Map<string, Promise<Origin>>();

const DISCOVERY_ENV = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
];

/** No fetch, shell or prompts. A safe clone URL leaves the worker only when explicitly requested. */
export async function workspaceOrigin(cwd: string, includeCloneUrl = false) {
  const key = resolve(cwd);
  let read = pending.get(key);

  if (!read) {
    read = readOrigin(key).finally(() => pending.delete(key));
    pending.set(key, read);
  }

  const value = await read;

  return { ...value, workspaceCloneUrl: includeCloneUrl ? value.workspaceCloneUrl : "" };
}

async function readOrigin(cwd: string): Promise<Origin> {
  const signature = await originFiles(cwd);
  const cached = origins.get(cwd);

  // Explicit Git environment overrides need Git's own discovery, not the checkout's files.
  const cacheable =
    !!signature &&
    !Object.keys(process.env).some((name) => name.startsWith("GIT_CONFIG") || DISCOVERY_ENV.includes(name));

  if (cacheable && cached?.signature === signature) return cached.value;

  const command = {
    argv: ["git", "config", "--local", "--get", "remote.origin.url"],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: 2_000,
  };

  const result = await runProcess(command, { kind: "git", key: `${processKey(command)}:origin:${signature}` });

  if (result.code !== 0 && result.code !== 1) throw new Error("Could not read the workspace Git origin.");

  const raw = result.code === 0 ? result.stdout.trim() : "";
  let url = "";

  if (raw) {
    try {
      url = cloneUrl(raw);
    } catch {
      // Unsafe origins (including credentials) never leave this worker.
    }
  }

  const value = { workspaceOrigin: normalizeGitOrigin(raw), workspaceCloneUrl: url };

  if (cacheable && (await originFiles(cwd)) === signature) {
    origins.delete(cwd);
    origins.set(cwd, { signature, value });

    if (origins.size > 256) origins.delete(origins.keys().next().value ?? "");
  }

  return value;
}
