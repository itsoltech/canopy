import { PermissionMode, Provider, type ui } from "@canopy/contracts";
import { codexMessagePermission, composerMessagePermission } from "@canopy/domain/composer-choices";
import type { WebComposerDraft } from "#lib/features/drafts/state.svelte.ts";
import { HttpError } from "#lib/shared/http.ts";
import { updateThread, updateTurnPermissions } from "../api.ts";
import { fullAutoAvailable, permissionKey, permissionLabel, type PermissionModeKey } from "../labels.ts";

interface Context {
  thread: ui.Thread;
  worker: ui.Worker | undefined;
  running: boolean;
  runningTurn: ui.Turn | undefined;
  saved: WebComposerDraft;
  onturn: ((turn: ui.Turn) => void) | undefined;
}

/** One permission choice shared by the message, editor and pending-approval tray. */
export class ComposerPermissionsState {
  busy = $state(false);
  error = $state("");
  #confirmed = $state.raw<{ source: ui.Thread; updated: ui.Thread }>();
  #previous = $state<PermissionModeKey>();
  constructor(private readonly context: () => Context) {}

  get #thread() {
    const { thread } = this.context();

    const confirmed = this.#confirmed;

    if (!confirmed || confirmed.updated.id !== thread.id) return thread;

    // A pre-selection watch frame can arrive after the save reply. It cannot undo the first explicit choice.
    if (confirmed.updated.permissionModeSelected && !thread.permissionModeSelected) return confirmed.updated;

    return thread === confirmed.source ? confirmed.updated : thread;
  }
  get #live() {
    const { thread, worker, running, runningTurn } = this.context();

    return Boolean(running && runningTurn?.id && thread.provider === Provider.CLAUDE && worker?.claudeLivePermissions);
  }
  get threadDefault() {
    const thread = this.#thread;

    return thread.provider === Provider.CODEX ? permissionKey(thread.permissionMode) : undefined;
  }
  #changesDefault(next: PermissionModeKey) {
    return (
      !this.#thread.permissionModeSelected ||
      next !== this.threadDefault ||
      this.context().saved.choices.permissionMode !== undefined
    );
  }
  get confirmFullAccess() {
    return Boolean(this.threadDefault && this.#changesDefault("FULL_ACCESS"));
  }
  get locked() {
    return this.busy || Boolean(this.threadDefault && this.context().saved.locked);
  }
  get messageMode() {
    const { saved } = this.context();
    const thread = this.#thread;

    if (thread.provider === Provider.CODEX)
      return saved.pendingSend?.permissionMode ?? codexMessagePermission(thread, saved.choices.permissionMode);

    return composerMessagePermission(thread, saved.choices.permissionMode);
  }
  get value(): PermissionModeKey {
    const { runningTurn } = this.context();

    if (this.#previous) return this.#previous;

    if (this.#live && runningTurn) return permissionKey(runningTurn.permissionMode);

    return permissionKey(this.messageMode || this.#thread.permissionMode);
  }
  get scope(): "message" | "next" | undefined {
    const { running, runningTurn } = this.context();

    if (this.#live) return undefined;

    if (
      (this.threadDefault || this.#thread.permissionModeSelected) &&
      this.value !== permissionKey(this.#thread.permissionMode)
    )
      return "message";

    if (running && (!this.threadDefault || runningTurn?.permissionMode !== PermissionMode[this.value])) return "next";

    return undefined;
  }
  get explanation() {
    if (this.threadDefault) {
      const description =
        this.scope === "message"
          ? `The thread uses ${permissionLabel(this.#thread.permissionMode)}. Choose a mode to set it for future turns.`
          : "New turns in this thread use this mode.";

      return this.context().running
        ? `${description} Steered messages use the running turn’s permissions.`
        : description;
    }

    if (this.#live)
      return this.#thread.permissionModeSelected
        ? "Applies to this turn and your next message. Full access also allows pending permissions. Other modes keep pending shell approvals."
        : "Applies to this turn and future messages. Full access also allows pending permissions. Other modes keep pending shell approvals.";

    if (this.scope === "message")
      return this.context().running
        ? "Applies to your next queued turn. Steered messages use the running turn’s permissions."
        : "Future messages without a draft choice use the thread’s permissions.";

    return this.scope === "next"
      ? "Applies to the next turn. This turn and its pending approvals stay unchanged."
      : undefined;
  }
  get fullAuto() {
    const { thread, worker } = this.context();

    return fullAutoAvailable(thread.provider, worker?.os);
  }
  async #saveDefault(next: PermissionModeKey) {
    const { thread, saved } = this.context();
    const draftMode = saved.choices.permissionMode;
    this.busy = true;

    try {
      const updated = await updateThread(thread.id, { permissionMode: next });

      if (!updated) throw new Error("Missing thread");
      this.#confirmed = { source: thread, updated };

      if (draftMode !== undefined && saved.choices.permissionMode === draftMode)
        saved.choices = { ...saved.choices, permissionMode: undefined };
    } catch (cause) {
      this.error =
        cause instanceof HttpError
          ? cause.message
          : "Could not save thread permissions. Check the connection, then retry.";
    } finally {
      this.busy = false;
    }
  }
  async select(next: PermissionModeKey) {
    if (this.locked) return;
    const { runningTurn, thread, saved, onturn } = this.context();
    this.error = "";

    if (this.threadDefault) {
      if (this.#changesDefault(next)) await this.#saveDefault(next);

      return;
    }

    if (!this.#live || !runningTurn) {
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
