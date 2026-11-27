import { ui } from "@canopy/contracts";
import { goto } from "$app/navigation";
import { tick } from "svelte";
import { awayReason } from "#lib/features/computers/computers.ts";
import { formatCount } from "#lib/shared/format.ts";
import { decode } from "#lib/shared/wire.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { focusOrigin, restoreSnoozeFocus, type ThreadActions } from "./thread-actions.svelte.ts";

/** "3 threads", "1 thread". */
export const threadCount = (count: number): string => `${formatCount(count)} ${count === 1 ? "thread" : "threads"}`;

/** Threads whose parent is also chosen: archiving or deleting the parent already covers them. */
const roots = (threads: readonly ui.Thread[]): ui.Thread[] => {
  const ids = new Set(threads.map((thread) => thread.id));

  return threads.filter((thread) => !thread.parentThreadId || !ids.has(thread.parentThreadId));
};

const unread = (thread: ui.Thread) => thread.markedUnread || thread.unseenResult;

/**
 * Thread actions applied to several threads (the sidebar's selection). Each thread goes through the same
 * lifecycle requests as its row menu; threads of an unreachable computer are skipped. Archive and delete keep
 * the confirmations from Settings and offer one Undo for the whole group.
 */
export class ThreadBulkActions {
  dialog = $state.raw<{ kind: "archive" | "delete"; threads: ui.Thread[]; done?: () => void }>();
  saving = $state(false);
  returnFocus: HTMLElement | undefined;

  constructor(private readonly actions: ThreadActions) {}

  /** The threads an action can change now: not deleted, on a reachable computer. */
  editable(threads: readonly ui.Thread[]): ui.Thread[] {
    return threads.filter(
      (thread) => !thread.deletedAt && !(thread.nodeId && awayReason(this.actions.overview.computer(thread.nodeId))),
    );
  }

  pinned(thread: ui.Thread): boolean {
    return this.actions.settings.sidebar.pinnedThreadIds.includes(thread.id);
  }

  async markRead(threads: readonly ui.Thread[]): Promise<void> {
    const read = threads.some(unread);
    const changed = threads.filter((thread) => Boolean(unread(thread)) === read);

    await this.each(changed, (thread) => this.actions.lifecycle(thread.id, read ? "read" : "unread"));
  }

  async pin(threads: readonly ui.Thread[]): Promise<void> {
    const pin = !threads.every((thread) => this.pinned(thread));

    // One settings write at a time: each one rewrites the whole pinned list.
    for (const thread of threads.filter((each) => this.pinned(each) !== pin))
      await this.each([thread], async () => {
        await this.actions.settings.pinThread(thread.id, pin);
      });
  }

  async snooze(threads: readonly ui.Thread[], until?: Date): Promise<void> {
    const source = focusOrigin();

    await this.snoozeEach(threads, until);
    await tick();

    if (document.activeElement === document.body) restoreSnoozeFocus(source);
  }

  /** Snoozes the threads that can be snoozed until `until` (none: until woken). */
  async snoozeEach(threads: readonly ui.Thread[], until?: Date): Promise<void> {
    await this.each(
      threads.filter((thread) => thread.status !== "archived" && !thread.spawnedByAgent),
      (thread) => this.actions.setSnooze(thread.id, true, until),
    );
  }

  /** The snooze dialog for the group, on its date and time field. */
  openSnooze(threads: readonly ui.Thread[], done?: () => void): void {
    const [first] = threads;

    if (!first) return;
    this.actions.returnFocus = focusOrigin();
    this.actions.snoozing = { thread: first, custom: true, group: { threads: [...threads], done } };
  }

  async wake(threads: readonly ui.Thread[]): Promise<void> {
    await this.each(
      threads.filter((thread) => thread.snoozed),
      (thread) => this.actions.setSnooze(thread.id, false),
    );
  }

  async unarchive(threads: readonly ui.Thread[]): Promise<void> {
    // A side thread archived with its parent comes back with it.
    const ids = new Set(
      threads.flatMap((thread) =>
        thread.status === "archived" ? [(thread.archivedBy === "cascade" && thread.parentThreadId) || thread.id] : [],
      ),
    );

    await this.each([...ids], (id) => this.actions.lifecycle(id, "unarchive"));
  }

  /** Archive or delete, asking first when Settings asks for it. */
  request(kind: "archive" | "delete", threads: readonly ui.Thread[], done?: () => void): void {
    const chosen = roots(kind === "archive" ? threads.filter((thread) => thread.status !== "archived") : threads);

    if (!chosen.length) return;
    const settings = this.actions.settings.general;

    if (kind === "archive" ? settings.confirmArchive : settings.confirmDelete !== false) {
      this.returnFocus = focusOrigin();
      this.dialog = { kind, threads: chosen, done };
    } else void this.apply(kind, chosen).then(done);
  }

  async confirm(): Promise<void> {
    const dialog = this.dialog;

    if (!dialog || this.saving) return;
    this.saving = true;

    try {
      await this.apply(dialog.kind, dialog.threads);
      this.dialog = undefined;
      dialog.done?.();
    } finally {
      this.saving = false;
    }
  }

  private async apply(kind: "archive" | "delete", threads: readonly ui.Thread[]): Promise<void> {
    if (kind === "archive") {
      const archived = await this.each(threads, (thread) => this.actions.lifecycle(thread.id, "archive"));

      if (archived.length)
        toast(`${threadCount(archived.length)} archived`, {
          action: {
            label: "Undo",
            run: () => void this.each(archived, (t) => this.actions.lifecycle(t.id, "unarchive")),
          },
        });

      return;
    }

    const currentId = this.actions.currentId();
    const deletedIds: string[] = [];

    const deleted = await this.each(threads, async (thread) => {
      const result = decode(ui.DeleteThreadResponseSchema, await this.actions.post(thread.id, "delete"));
      deletedIds.push(...result.threadIds);
    });

    const now = BigInt(Math.floor(Date.now() / 1000));

    for (const id of deletedIds) {
      const thread = this.actions.overview.threads.get(id);

      if (thread)
        this.actions.publish({
          ...thread,
          deletedAt: { $typeName: "google.protobuf.Timestamp", seconds: now, nanos: 0 },
        });
    }

    const reopenId = currentId && deletedIds.includes(currentId) ? currentId : undefined;

    if (reopenId) await goto("/threads/new");

    if (deleted.length)
      toast(`${threadCount(deleted.length)} deleted`, {
        action: { label: "Undo", run: () => void this.restore(deleted, reopenId) },
      });
  }

  private async restore(threads: readonly ui.Thread[], reopenId?: string) {
    await this.each(threads, async (thread) => {
      const result = decode(ui.ListThreadsResponseSchema, await this.actions.post(thread.id, "restore"));

      for (const restored of result.threads) this.actions.publish(restored);
    });

    if (reopenId) await goto(`/threads/${reopenId}`);
  }

  /** Runs `change` for every item together; returns the ones that succeeded and reports the rest once. */
  private async each<T>(items: readonly T[], change: (item: T) => Promise<void>): Promise<T[]> {
    const results = await Promise.allSettled(items.map(change));
    const failed = results.filter((result) => result.status === "rejected").length;

    if (failed)
      toast(
        items.length === 1
          ? "Could not change the thread. Try again."
          : `Could not change ${threadCount(failed)}. Try again.`,
        { tone: "error" },
      );

    return items.filter((_, index) => results[index]?.status === "fulfilled");
  }
}
