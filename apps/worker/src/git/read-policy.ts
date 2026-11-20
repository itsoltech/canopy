import {
  runPreparedProcess,
  runProcess,
  type ProcessInput,
  type ProcessPolicy,
  type ProcessResult,
} from "@canopy/process-governor";

const disabled = ["core.fsmonitor=false", "diff.external=", "diff.autoRefreshIndex=false", "submodule.recurse=false"];

const hooksPath = process.platform === "win32" ? "NUL" : "/dev/null";

export const withoutGitHooks = ["-c", `core.hooksPath=${hooksPath}`];

export function gitReadEnv() {
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_ALLOW_PROTOCOL: "",
  };
}

export function gitReadArgv(args: readonly string[], options: readonly string[] = []) {
  return ["git", ...withoutGitHooks, ...disabled.flatMap((value) => ["-c", value]), ...options, ...args];
}

function filterQuery(cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal): ProcessInput {
  return {
    argv: gitReadArgv([
      "config",
      "--null",
      "--name-only",
      "--get-regexp",
      "^filter\\..*\\.(clean|smudge|process|required)$",
    ]),
    cwd,
    env,
    ...(signal && { signal }),
    timeoutMs: 5_000,
    maxBytes: 1024 * 1024,
  };
}

function disableFilters(result: ProcessResult): string[] {
  if (result.code !== 0 && result.code !== 1) throw new Error("Could not read Git settings.");

  const drivers = new Set(
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map((name) => name.slice(0, name.lastIndexOf("."))),
  );

  return [...drivers].flatMap((driver) =>
    ["clean=", "smudge=", "process=", "required=false"].flatMap((value) => ["-c", `${driver}.${value}`]),
  );
}

/** Determine all effective filter names before opening worktree files. */
export async function gitReadFilters(cwd: string, signal: AbortSignal): Promise<string[]> {
  const result = await runProcess(filterQuery(cwd, gitReadEnv(), signal), { kind: "git" });

  return disableFilters(result);
}

/** Discover filters for each actual scan. Identical readers can share the finished scan, including its setup. */
export function runGitScan(input: ProcessInput & { cwd: string; env: NodeJS.ProcessEnv }, policy: ProcessPolicy) {
  const { onStart, ...scan } = input;
  const setup = { ...filterQuery(scan.cwd, scan.env, scan.signal), ...(onStart && { onStart }) };

  return runPreparedProcess(
    setup,
    (result) => ({ ...scan, argv: gitReadArgv(scan.argv.slice(1), disableFilters(result)) }),
    policy.key === undefined ? policy : { ...policy, key: `git-scan:${policy.key}` },
  );
}
