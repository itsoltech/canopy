import { normalizeGitOrigin } from "@canopy/domain/projects";
import { processKey, runProcess } from "@canopy/process-governor";

/** No fetch, shell, prompts or raw URLs on the wire. Negative results are cached too. */
export async function workspaceOrigin(cwd: string): Promise<string> {
  const command = {
    argv: ["git", "config", "--local", "--get", "remote.origin.url"],
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    timeoutMs: 2_000,
  };

  const result = await runProcess(command, { kind: "git", key: processKey(command), ttlMs: 30_000 });

  if (result.code !== 0 && result.code !== 1) throw new Error("Could not read the workspace Git origin.");

  return result.code === 0 ? normalizeGitOrigin(result.stdout) : "";
}
