import { normalizeGitOrigin } from "@canopy/domain/projects";
import { processKey, runProcess } from "@canopy/process-governor";
import { cloneUrl } from "./project-sources.ts";

/** No fetch, shell or prompts. A safe clone URL leaves the worker only when explicitly requested. */
export async function workspaceOrigin(cwd: string, includeCloneUrl = false) {
  const command = {
    argv: ["git", "config", "--local", "--get", "remote.origin.url"],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: 2_000,
  };

  const result = await runProcess(command, { kind: "git", key: processKey(command), ttlMs: 30_000 });

  if (result.code !== 0 && result.code !== 1) throw new Error("Could not read the workspace Git origin.");

  const raw = result.code === 0 ? result.stdout.trim() : "";
  let url = "";

  if (includeCloneUrl && raw) {
    try {
      url = cloneUrl(raw);
    } catch {
      // Unsafe origins (including credentials) never leave this worker.
    }
  }

  return { workspaceOrigin: normalizeGitOrigin(raw), workspaceCloneUrl: url };
}
