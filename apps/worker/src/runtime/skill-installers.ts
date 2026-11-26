import { mkdtempSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import { SkillInstallerResultSchema, type SkillInstallerRequest } from "@canopy/contracts";
import { isUuid } from "@canopy/domain/humanize";
import type { EnvironmentHomes } from "../agent-environment/targets.ts";
import { supportsSkillInstaller } from "../capabilities.ts";
import { CommandError } from "./host-types.ts";
import { SkillInstallerFiles } from "./skill-installer-files.ts";
import { SkillInstallerPty } from "./skill-installer-pty.ts";

const idleMs = 5 * 60_000;
const lifetimeMs = 30 * 60_000;
const maxSessions = 4;
const maxTombstones = 1024;
const closedReason = "The installer terminal closed or expired. Start a new terminal to try again.";
const actions = new Set(["start", "read", "write", "cancel", "collect", "close"]);

interface Session {
  readonly cwd: string;
  readonly pty: SkillInstallerPty;
  readonly files: SkillInstallerFiles;
  readonly deadline: number;
  idleDeadline: number;
  skillPaths?: string[];
}

const removeWorkDir = (path: string) => rm(path, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});

export class SkillInstallers {
  readonly #sessions = new Map<string, Session>();
  readonly #tombstones = new Map<string, number>();
  readonly #cleanups = new Set<Promise<void>>();
  #closed = false;
  #overflowUntil = 0;
  #expiry: ReturnType<typeof setInterval> | undefined;

  constructor(
    readonly home: string,
    readonly deviceHomes: EnvironmentHomes["deviceHomes"],
  ) {}

  async execute(request: SkillInstallerRequest) {
    const { sessionId, action } = request;

    if (!supportsSkillInstaller())
      throw new CommandError(
        "SKILL_INSTALLER_UNAVAILABLE",
        "This computer does not support installer terminals.",
        false,
      );

    if (!isUuid(sessionId) || !actions.has(action))
      throw new CommandError("SKILL_INSTALLER_INVALID", "Invalid installer session. Open a new terminal.", false);

    if (request.command.length > 4096 || request.skillPath.length > 4096 || request.input.length > 64 * 1024)
      throw new CommandError(
        "SKILL_INSTALLER_INVALID",
        "Installer request is too large. Shorten it and try again.",
        false,
      );

    const id = sessionId.toLowerCase();
    const now = performance.now();
    this.#expire(now);

    if (action === "close") {
      await this.#discard(id, now);

      return create(SkillInstallerResultSchema, { sessionId });
    }

    if (this.#closed || this.#tombstones.has(id)) return this.#expired(request);
    const session = this.#sessions.get(id) ?? (action === "start" ? this.#start(id, request, now) : undefined);

    if (!session) return this.#expired(request);
    session.idleDeadline = now + idleMs;

    switch (action) {
      case "read":
        session.pty.resize(request.cols, request.rows);
        break;
      case "write":
        session.pty.write(request.input);
        break;
      case "cancel":
        session.pty.stop("The installer was stopped.");
        await session.pty.done;
        break;
      case "collect":
        return this.#collect(session, request);
    }

    const read = action === "start" || action === "read";

    if (read && this.#completed(session) && !session.skillPaths)
      session.skillPaths = session.files.discover(session.pty.read(0n).output);

    return create(SkillInstallerResultSchema, {
      sessionId,
      cwd: session.cwd,
      running: session.pty.running,
      exitCode: session.pty.exitCode,
      skillPaths: session.skillPaths ?? [],
      reason: session.pty.reason,
      ...(read && session.pty.read(request.offset)),
    });
  }

  async closeAll(permanent: boolean): Promise<void> {
    this.#closed ||= permanent;
    const now = performance.now();

    for (const id of this.#sessions.keys()) void this.#discard(id, now);
    await Promise.all(this.#cleanups);
  }

  #start(id: string, request: SkillInstallerRequest, now: number): Session | undefined {
    if (this.#overflowUntil > now) return undefined;

    if (!request.command.trim() || request.command.includes("\0"))
      throw new CommandError("SKILL_INSTALLER_INVALID", "Enter a valid installer command.", false);

    if (this.#sessions.size + this.#cleanups.size >= maxSessions)
      throw new CommandError("SKILL_INSTALLER_BUSY", "Close another installer terminal and try again.", false);

    let cwd: string | undefined;

    try {
      cwd = mkdtempSync(join(realpathSync(tmpdir()), "canopy-skill-installer-"));
      const files = new SkillInstallerFiles(cwd, this.home, this.deviceHomes);
      const pty = new SkillInstallerPty(request.command, cwd, this.home, request.cols, request.rows);
      const session = { cwd, pty, files, deadline: now + lifetimeMs, idleDeadline: now + idleMs };
      this.#sessions.set(id, session);
      this.#expiry ??= setInterval(() => this.#expire(performance.now()), 15_000).unref();

      return session;
    } catch {
      if (cwd) void removeWorkDir(cwd);
      throw new CommandError("SKILL_INSTALLER_START_FAILED", "The installer terminal could not start.", false);
    }
  }

  #completed(session: Session): boolean {
    return !session.pty.running && session.pty.exitCode === 0 && !session.pty.reason;
  }

  #collect(session: Session, request: SkillInstallerRequest) {
    if (!this.#completed(session) || !session.skillPaths?.includes(request.skillPath))
      throw new CommandError(
        "SKILL_INSTALLER_SKILL_UNKNOWN",
        "Choose a skill found by the completed installer.",
        false,
      );

    try {
      const artifact = session.files.collect(request.skillPath);

      if (artifact) return create(SkillInstallerResultSchema, { sessionId: request.sessionId, artifact });
    } catch {
      // File names and content come from the installer. Keep errors free of filesystem details.
    }

    throw new CommandError(
      "SKILL_INSTALLER_SKILL_INVALID",
      "The folder no longer contains a readable, valid skill.",
      false,
    );
  }

  #expired(request: SkillInstallerRequest) {
    return create(SkillInstallerResultSchema, {
      sessionId: request.sessionId,
      offset: request.action === "read" ? request.offset : 0n,
      reason: closedReason,
    });
  }

  #expire(now: number): void {
    for (const [id, expires] of this.#tombstones) {
      if (expires > now) break;
      this.#tombstones.delete(id);
    }

    for (const [id, session] of this.#sessions)
      if (session.deadline <= now || session.idleDeadline <= now) void this.#discard(id, now);
  }

  #discard(id: string, now: number): Promise<void> | undefined {
    const session = this.#sessions.get(id);

    // A close might overtake its start. Fence that UUID even when the process never existed.
    if (!this.#tombstones.has(id)) {
      if (this.#tombstones.size < maxTombstones) this.#tombstones.set(id, now + lifetimeMs);
      else this.#overflowUntil = now + lifetimeMs;
    }

    if (!session) return undefined;
    this.#sessions.delete(id);

    if (!this.#sessions.size) {
      clearInterval(this.#expiry);
      this.#expiry = undefined;
    }

    session.pty.stop(closedReason);

    const cleanup = session.pty.done
      .catch(() => {})
      .then(() => removeWorkDir(session.cwd))
      .finally(() => this.#cleanups.delete(cleanup));

    this.#cleanups.add(cleanup);

    return cleanup;
  }
}
