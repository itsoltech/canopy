import { PermissionMode, Provider, type ui } from "@canopy/contracts";
import { composerChoices } from "@canopy/domain/composer-choices";
import type { WebComposerDraft } from "#lib/features/drafts/state.svelte.ts";
import { HttpError } from "#lib/shared/http.ts";
import { updateTurnPermissions } from "../api.ts";
import { permissionKey, type PermissionModeKey } from "../labels.ts";

interface Context {
  thread: ui.Thread;
  worker: ui.Worker | undefined;
  running: boolean;
  runningTurn: ui.Turn | undefined;
  saved: WebComposerDraft;
  onturn: ((turn: ui.Turn) => void) | undefined;
}

/** One permission choice shared by the editor and its pending-approval tray. */
export class ComposerPermissionsState {
  busy = $state(false);
  error = $state("");
  #previous = $state<PermissionModeKey>();
  constructor(private readonly context: () => Context) {}

  get live() {
    const { thread, worker, running, runningTurn } = this.context();

    return Boolean(running && runningTurn?.id && thread.provider === Provider.CLAUDE && worker?.claudeLivePermissions);
  }
  get nextTurn() {
    return this.context().running && !this.live;
  }
  get value(): PermissionModeKey {
    const { thread, runningTurn, saved } = this.context();

    return (
      this.#previous ??
      permissionKey(
        this.live && runningTurn
          ? runningTurn.permissionMode
          : composerChoices(thread, [], saved.choices).permissionMode,
      )
    );
  }
  async select(next: PermissionModeKey) {
    if (this.busy) return;
    const { thread, runningTurn, saved, onturn } = this.context();
    this.error = "";

    if (!this.live || !runningTurn) {
      saved.choices = { ...saved.choices, permissionMode: PermissionMode[next] };

      return;
    }

    if (next === this.value) return;
    this.#previous = this.value;
    this.busy = true;

    try {
      const turn = await updateTurnPermissions(thread.id, runningTurn.id, next);
      saved.choices = { ...saved.choices, permissionMode: turn.permissionMode };
      onturn?.(turn);
    } catch (cause) {
      this.error =
        cause instanceof HttpError && [404, 409].includes(cause.status)
          ? "The turn changed before permissions were updated. Choose permissions again for the current turn."
          : "Could not change permissions. Check the worker connection, then choose permissions again.";
    } finally {
      this.#previous = undefined;
      this.busy = false;
    }
  }
}
