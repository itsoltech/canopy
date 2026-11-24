import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { instructionDirectory } from "../../agent-environment/files.ts";
import { instanceShadowHome } from "../../config/homes.ts";
import { antigravityHomeProblem } from "../home-paths.ts";
import type { ResolvedProfile } from "../profiles.ts";

const id = /^[a-z0-9][a-z0-9_-]{0,159}$/i;

export function antigravitySessionRoot(dataDir: string, profileId: string): string {
  if (!id.test(profileId)) throw new Error("Invalid Antigravity instance ID.");

  return resolve(dataDir, "antigravity", profileId, "sessions");
}

// The CLI walks parents up to the enclosing repository, even with the ACP
// include-default-customizations flag disabled. Scratch must stop at its own cwd.
export function checkAntigravityScratch(cwd: string): void {
  const root = realpathSync(cwd);

  if (existsSync(join(root, ".git"))) return;

  for (let parent = dirname(root); ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git")))
      throw new Error("Antigravity needs a scratch directory outside the enclosing Git repository.");

    if (parent === dirname(parent)) return;
  }
}

export function antigravityProcessHome(options: {
  dataDir: string;
  profile: ResolvedProfile;
  deviceHome: string;
  linkLogin: boolean;
  threadId?: string;
}) {
  const { dataDir, deviceHome, profile, threadId } = options;

  if (threadId !== undefined && !id.test(threadId)) throw new Error("Invalid Antigravity thread ID.");

  const privateHome =
    instanceShadowHome(dataDir, "antigravity", profile.id, profile.runtime) ?? resolve(dataDir, "antigravity-home");

  const problem = antigravityHomeProblem(privateHome, deviceHome);

  if (problem) throw new Error(problem);
  const sessions = antigravitySessionRoot(dataDir, profile.id);
  const root = threadId ? join(sessions, threadId) : dirname(sessions);
  instructionDirectory(root, true);
  const gemini = mkdtempSync(join(root, "process-"));
  const app = join(gemini, "antigravity-cli");
  const skills = resolve(privateHome, "skills");
  const cleanup = () => rmSync(gemini, { recursive: true, force: true });

  try {
    mkdirSync(app, { mode: 0o700 });

    if (threadId) {
      // session/load reopens the conversation database (including SQLite sidecars)
      // and per-session artifacts. Settings, logs and account caches stay per process.
      for (const name of ["conversations", "brain"]) {
        const durable = join(root, name);
        instructionDirectory(durable, true);
        symlinkSync(durable, join(app, name), process.platform === "win32" ? "junction" : "dir");
      }

      instructionDirectory(skills, true);
      symlinkSync(skills, join(app, "skills"), process.platform === "win32" ? "junction" : "dir");
    }

    if (options.linkLogin) {
      // agy checks the system keyring first. Headless Linux also uses this
      // single-file fallback. The worker never opens or copies its contents.
      const token = "antigravity-oauth-token";
      const source = resolve(deviceHome, token);

      if (existsSync(source)) symlinkSync(source, join(app, token), "file");
    }

    return { gemini, app, skills: threadId ? skills : undefined, policies: threadId ? root : app, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}
