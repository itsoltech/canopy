import { spawn } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { devNull } from "node:os";
import { governNodeSpawn, processGovernor } from "@canopy/process-governor";
import { GIT_ENV, GIT_TIMEOUT_MS, git, gitOk } from "./git.ts";

export function gitDirectoryIdentity(dir: string) {
  const stat = statSync(dir, { bigint: true });

  if (!stat.isDirectory() || !stat.ino) throw new Error("Git directory identity is unavailable");

  return JSON.stringify([dir, String(stat.dev), String(stat.ino), String(stat.birthtimeNs)]);
}

function inventory(common: string) {
  const root = join(common, "worktrees");
  const ids = existsSync(root) ? readdirSync(root).sort() : [];
  const directories = [common, ...ids.map((id) => join(root, id))];
  const signature = JSON.stringify(directories.map(gitDirectoryIdentity));

  return { ids, directories, signature };
}

/** update-ref cannot verify a qualified worktree HEAD directly. A same-OID update does lock both the
 * symbolic HEAD and its branch. Abort the guard transaction afterwards so no checkout's reflog changes.
 */
async function transaction(common: string, commands: string, guard: boolean, allow: () => Promise<boolean> | boolean) {
  const child = governNodeSpawn("git", () =>
    spawn(
      "git",
      [`--git-dir=${common}`, ...(guard ? ["-c", `core.hooksPath=${devNull}`] : []), "update-ref", "--stdin", "-z"],
      {
        cwd: common,
        env: { ...process.env, ...GIT_ENV },
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    ),
  );

  const closed = new Promise<boolean>((resolve) => child.once("close", (code) => resolve(code === 0)));
  child.stdin.on("error", () => {});

  const prepared = new Promise<boolean>((resolve) => {
    let output = "";
    child.once("error", () => resolve(false));
    child.once("close", () => resolve(false));
    child.stdout.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-128);

      if (output.includes("prepare: ok\n")) resolve(true);
    });
  });

  let commit = false;
  let timeout = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);

  try {
    child.stdin.write(`start\0${commands}prepare\0`);

    if (!(await prepared)) return false;
    clearTimeout(timeout);

    if (!(await allow())) return false;
    commit = !guard;
  } finally {
    clearTimeout(timeout);
    child.stdin.end(commit ? "commit\0" : "abort\0");
    timeout = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    await closed;
    clearTimeout(timeout);

    if (commit) processGovernor.invalidate();
  }

  return await closed;
}

export async function deleteUnusedBranch(
  repo: string,
  ref: string,
  expected: string,
  current: (common: string) => boolean,
  consume = () => true,
) {
  const common = realpathSync(
    (await gitOk(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"], "GIT_FAILED")).trimEnd(),
  );

  const originalRepo = gitDirectoryIdentity(common);
  const { ids, directories, signature } = inventory(common);
  const sameCheckouts = () => inventory(common).signature === signature;
  const names = ["HEAD", ...ids.map((id) => `worktrees/${id}/HEAD`)];
  const args = [`--git-dir=${common}`];

  const tips = (await gitOk(repo, [...args, "rev-parse", "--revs-only", "--end-of-options", ...names], "GIT_FAILED"))
    .trimEnd()
    .split("\n");

  if (tips.length !== names.length || tips.some((tip) => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tip))) return false;
  const guards = names.map((name, i) => `update ${name}\0${tips[i]}\0${tips[i]}\0`).join("");

  return transaction(common, guards, true, async () => {
    // Detect added/removed registrations while Git was taking the locks. A detached rebase or bisect
    // can still be using a named branch which does not appear as a symbolic HEAD.
    if (!sameCheckouts()) return false;

    if (
      directories.some((dir) =>
        ["rebase-merge", "rebase-apply", "BISECT_START"].some((file) => existsSync(join(dir, file))),
      )
    )
      return false;
    const list = await gitOk(repo, [...args, "worktree", "list", "--porcelain", "-z"], "GIT_FAILED");

    if (list.split("\0").some((line) => line.toLowerCase() === `branch ${ref.toLowerCase()}`) || !current(common))
      return false;

    // Recheck the lease after the deletion itself has secured the expected tip and run the prepared hook.
    const deletion = `option no-deref\0delete ${ref}\0${expected}\0`;

    const deleted = await transaction(common, deletion, false, () => current(common) && sameCheckouts() && consume());

    if (!deleted || sameCheckouts()) return deleted;

    // Git has no global lock for worktree registration. If a checkout appeared during commit,
    // restore the exact tip. The empty expected value protects a branch already recreated by another client.
    if (gitDirectoryIdentity(common) === originalRepo)
      await git(repo, [...args, "update-ref", "--no-deref", ref, expected, ""]);

    return false;
  });
}
