import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { goto } from "$app/navigation";
import { getContext, setContext } from "svelte";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import type { SettingsState } from "#lib/features/settings/settings-state.svelte.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { revealThreadDirectory, updateThread } from "./api.ts";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { requestTitleRegeneration } from "./title-actions.ts";
import type { ThreadActionId } from "./thread-actions.ts";

const KEY = Symbol("thread-actions");
export const provideThreadActions = (actions: ThreadActions) => setContext(KEY, actions);
export const useThreadActions = () => getContext<ThreadActions>(KEY);

export class ThreadActions {
  dialog = $state.raw<{
    kind: "rename" | "delete" | "unpin" | "archive";
    thread: ui.Thread;
    afterArchive?: () => void;
  }>();
  /** The thread "Move to…" is open for (MoveDialog). */
  moving = $state.raw<ui.Thread>();
  saving = $state(false);
  returnFocus: HTMLElement | undefined;
  constructor(
    readonly overview: OverviewState,
    readonly settings: SettingsState,
    readonly currentId: () => string | undefined,
  ) {}

  async copy(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      toast("Copied");
    } catch {
      toast("Could not copy to the clipboard", { tone: "error" });
    }
  }

  link(thread: ui.Thread): string {
    return new URL(`/threads/${thread.id}`, location.origin).href;
  }

  async run(action: ThreadActionId, thread: ui.Thread, confirmed = false, afterArchive?: () => void): Promise<void> {
    try {
      const unpin = action === "pin" && this.settings.sidebar.pinnedThreadIds.includes(thread.id);

      const ask =
        !confirmed &&
        ((unpin && this.settings.general.confirmUnpin) ||
          (action === "archive" && thread.status !== "archived" && this.settings.general.confirmArchive));

      if (ask) {
        this.openDialog(unpin ? "unpin" : "archive", thread);

        if (this.dialog && afterArchive) this.dialog = { ...this.dialog, afterArchive };

        return;
      }

      switch (action) {
        case "open":
          window.open(this.link(thread), "_blank", "noopener,noreferrer");
          break;
        case "new":
          await goto(`/?project=${encodeURIComponent(thread.projectId)}`);
          break;
        case "pin":
          await this.settings.pinThread(thread.id, !this.settings.sidebar.pinnedThreadIds.includes(thread.id));
          break;
        case "rename":
        case "delete": {
          this.openDialog(action, thread);

          if (action === "delete" && this.settings.general.confirmDelete === false) await this.confirm();
          break;
        }

        case "move":
          this.moving = thread;
          break;
        case "regenerate":
          await requestTitleRegeneration(thread.id);
          break;
        case "read":
          await this.lifecycle(thread.id, thread.markedUnread || thread.unseenResult ? "read" : "unread");
          break;
        case "reveal":
          await revealThreadDirectory(thread.id);
          break;
        case "filter":
          if (thread.status === "archived") devicePreferences.setView({ archivedThreadsExpanded: true });
          await this.settings.updateSidebar({
            projectIds: [thread.projectId],
          });
          break;
        case "settings":
          await goto(
            this.overview.project(thread.projectId)?.kind === "scratch"
              ? "/settings/threads"
              : `/settings/projects/${thread.projectId}`,
          );
          break;
        case "archive":
          await this.archive(thread);
          afterArchive?.();
          break;
      }
    } catch (cause) {
      this.error(cause);
    }
  }

  async confirm(title?: string): Promise<void> {
    const dialog = this.dialog;

    if (!dialog || this.saving) return;
    this.saving = true;

    try {
      if (dialog.kind === "rename") {
        const thread = await updateThread(dialog.thread.id, { title: title?.trim() ?? "" });

        if (thread) this.publish(thread);
      } else if (dialog.kind === "unpin") {
        await this.settings.pinThread(dialog.thread.id, false);
      } else if (dialog.kind === "archive") {
        await this.archive(dialog.thread);
      } else {
        const id = dialog.thread.id;
        const currentId = this.currentId();
        const result = decode(ui.DeleteThreadResponseSchema, await this.post(id, "delete"));
        const reopenId = currentId && result.threadIds.includes(currentId) ? currentId : undefined;

        for (const deletedId of result.threadIds) {
          const thread = this.overview.threads.get(deletedId);

          if (thread)
            this.publish({
              ...thread,
              deletedAt: {
                $typeName: "google.protobuf.Timestamp",
                seconds: BigInt(Math.floor(Date.now() / 1000)),
                nanos: 0,
              },
            });
        }

        if (reopenId) await goto("/");
        toast("Thread deleted", {
          action: {
            label: "Undo",
            run: () => {
              void this.restore(id, reopenId).catch((cause) => this.error(cause));
            },
          },
        });
      }

      this.dialog = undefined;

      if (dialog.kind === "archive") dialog.afterArchive?.();
    } catch (cause) {
      this.error(cause);
    } finally {
      this.saving = false;
    }
  }

  private post(id: string, action: string) {
    return requestJson("POST", `/api/threads/${encodeURIComponent(id)}/lifecycle`, { action });
  }
  private async archive(thread: ui.Thread) {
    const archived = thread.status === "archived";
    const id = archived && thread.archivedBy === "cascade" ? thread.parentThreadId : thread.id;

    await this.lifecycle(id, archived ? "unarchive" : "archive");

    if (!archived)
      toast("Thread archived", {
        action: {
          label: "Undo",
          run: () => {
            void this.lifecycle(id, "unarchive").catch((cause) => this.error(cause));
          },
        },
      });
  }
  private openDialog(kind: "rename" | "delete" | "unpin" | "archive", thread: ui.Thread): void {
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const menu = focused?.closest('[role="menu"]');
    this.returnFocus = menu?.id
      ? (document.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(menu.id)}"]`) ?? focused)
      : focused;
    this.dialog = { kind, thread };
  }
  private publish(thread: ui.Thread) {
    this.overview.apply(create(ui.OverviewUpdateSchema, { change: { case: "thread", value: thread } }));
  }
  private async lifecycle(id: string, action: string) {
    const result = decode(ui.GetThreadResponseSchema, await this.post(id, action));

    if (result.thread) this.publish(result.thread);
  }
  private async restore(id: string, reopenId?: string) {
    const result = decode(ui.ListThreadsResponseSchema, await this.post(id, "restore"));

    for (const thread of result.threads) this.publish(thread);

    if (reopenId) await goto(`/threads/${reopenId}`);
  }
  private error(cause: unknown) {
    toast(cause instanceof Error ? cause.message : "Could not change the thread", { tone: "error" });
  }
}
