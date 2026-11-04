import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { HttpError } from "#lib/shared/http.ts";
import { saveWorktreeSettings, worktreeSettings } from "./api.ts";

/** A scope of the worktree settings: "" = all projects / all computers. */
export interface WorktreeScope {
  readonly projectId: string;
  readonly workerId: string;
}

export type WorktreeField =
  | "location"
  | "startFromRemote"
  | "remote"
  | "branchNaming"
  | "branchPrefix"
  | "defaultMode"
  | "cleanupDeletedThreads"
  | "cleanupMerged"
  | "cleanupInactiveDays"
  | "cleanupSettled"
  | "cleanupUnchanged"
  | "keepLocalChanges"
  | "deleteLocalBranch";

/** A change of one field; `undefined` resets it to the inherited value. */
export type WorktreeChange = { [K in WorktreeField]?: ui.WorktreeSettings[K] };

/** Whether the scope sets the field itself (otherwise it inherits it). */
export function overrides(settings: ui.WorktreeSettings | undefined, field: WorktreeField): boolean {
  const value = settings?.[field];

  return field === "branchNaming" || field === "defaultMode" ? Boolean(value) : value !== undefined;
}

/**
 * Settings → Worktrees (docs/worktrees.md): one scope at a time, loaded from the gateway. A change writes the
 * scope's overrides with the version it started from; a conflict (changed elsewhere) reloads and applies it again.
 */
export class WorktreeSettingsState {
  current = $state.raw<ui.WorktreeSettingsResponse | undefined>(undefined);
  error = $state<string | undefined>(undefined);
  saving = $state(0);
  #scope: WorktreeScope = { projectId: "", workerId: "" };
  #pending = Promise.resolve();

  get scope(): WorktreeScope {
    return this.#scope;
  }

  async load(scope: WorktreeScope): Promise<void> {
    this.#scope = scope;
    this.error = undefined;
    this.current = undefined;

    try {
      const loaded = await worktreeSettings(scope.projectId, scope.workerId);

      if (this.#scope === scope) this.current = loaded;
    } catch (cause) {
      if (this.#scope === scope) this.error = cause instanceof Error ? cause.message : "Settings are unavailable";
    }
  }

  update(change: WorktreeChange): Promise<void> {
    const scope = this.#scope;
    this.saving++;
    this.#pending = this.#pending.then(() => this.#update(scope, change));

    return this.#pending;
  }

  async #update(scope: WorktreeScope, change: WorktreeChange): Promise<void> {
    try {
      if (this.#scope !== scope) return;
      await this.#write(scope, change).catch(async (cause: unknown) => {
        if (!(cause instanceof HttpError) || cause.status !== 409) throw cause;
        await this.load(scope);
        await this.#write(scope, change);
      });

      if (this.#scope === scope) this.error = undefined;
    } catch (cause) {
      if (this.#scope === scope) this.error = cause instanceof Error ? cause.message : "The change was not saved";
    } finally {
      this.saving--;
    }
  }

  async #write(scope: WorktreeScope, change: WorktreeChange): Promise<void> {
    const own = this.current?.settings ?? create(ui.WorktreeSettingsSchema);
    const next = create(ui.WorktreeSettingsSchema, { ...own, ...change });

    const saved = await saveWorktreeSettings({
      ...scope,
      settings: next,
      expectedVersion: this.current?.version ?? 0n,
    });

    if (this.#scope === scope) this.current = saved;
  }
}
