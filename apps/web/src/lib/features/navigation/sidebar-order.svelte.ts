import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { threadMove, threadOrderGroup } from "@canopy/domain/thread-order";
import type { SidebarEntry } from "@canopy/domain/sidebar-entries";
import { getContext, setContext, tick } from "svelte";
import type { OverviewState } from "#lib/features/overview/overview-state.svelte.ts";
import type { SettingsState } from "#lib/features/settings/settings-state.svelte.ts";
import { devicePreferences } from "#lib/features/settings/device-preferences.svelte.ts";
import { requestJson } from "#lib/shared/http.ts";
import { decode } from "#lib/shared/wire.ts";
import { toast } from "#lib/shared/ui/toast.svelte.ts";
import { Match } from "effect";

export type MoveDirection = "up" | "down" | "top" | "bottom";

type Position = { afterThreadId: string; beforeThreadId: string };

const KEY = Symbol("sidebar-order");
export const provideSidebarOrder = (order: SidebarOrder) => setContext(KEY, order);
export const useSidebarOrder = () => getContext<SidebarOrder | undefined>(KEY);

export class SidebarOrder {
  dragging = $state(false);
  pinTarget = $state(false);
  message = $state("");
  saving = $state(false);
  unpin = $state.raw<{ thread: ui.Thread; target: string; before: boolean }>();

  constructor(
    readonly overview: OverviewState,
    readonly settings: SettingsState,
    readonly entries: () => readonly SidebarEntry[],
    readonly unpinnedEntries: (id: string) => readonly SidebarEntry[],
  ) {}

  get custom() {
    return devicePreferences.view.threadSortMode === "custom";
  }
  available(thread: ui.Thread) {
    return this.custom && !thread.nodeId && !this.saving && !!threadOrderGroup(this.entries(), thread.id);
  }
  peers(thread: ui.Thread) {
    const group = threadOrderGroup(this.entries(), thread.id);
    let heading = "";

    return this.entries().flatMap((entry) => {
      if (entry.heading) heading = entry.key;

      return heading === group && entry.thread && !entry.thread.nodeId && this.sameProject(thread, entry.thread)
        ? [entry.thread]
        : [];
    });
  }
  private sameProject(from: ui.Thread, to: ui.Thread) {
    return (
      !this.settings.sidebar.groupByProject ||
      this.settings.sidebar.pinnedThreadIds.includes(from.id) ||
      from.projectId === to.projectId
    );
  }
  canMove(thread: ui.Thread, direction: MoveDirection) {
    if (!this.available(thread)) return false;
    const peers = this.peers(thread);
    const index = peers.findIndex((t) => t.id === thread.id);

    return direction === "up" || direction === "top" ? index > 0 : index < peers.length - 1;
  }
  async move(thread: ui.Thread, direction: MoveDirection) {
    if (!this.canMove(thread, direction)) return;
    const peers = this.peers(thread);
    const index = peers.findIndex((t) => t.id === thread.id);
    const before = direction === "up" || direction === "top";

    const at = Match.value(direction).pipe(
      Match.when("top", () => 0),
      Match.when("bottom", () => peers.length - 1),
      Match.orElse(() => index + (before ? -1 : 1)),
    );

    const target = peers[at];

    if (target) await this.drop(thread.id, target.id, before);
  }
  position(id: string, target: string, before: boolean): Position | undefined {
    const from = this.overview.threads.get(id);
    const to = this.overview.threads.get(target);

    if (
      this.settings.sidebar.groupByProject &&
      !this.settings.sidebar.pinnedThreadIds.includes(id) &&
      from?.projectId !== to?.projectId
    )
      return;

    const entries = this.entries().filter((entry) => !entry.thread || (from && this.sameProject(from, entry.thread)));

    return threadMove(entries, id, target, before);
  }
  canDrop(id: string, target: string, before: boolean) {
    const from = this.overview.threads.get(id);
    const to = this.overview.threads.get(target);

    if (!from || !to || to.nodeId || id === target) return false;

    if (this.position(id, target, before)) return true;
    const pins = this.settings.sidebar.pinnedThreadIds;

    if (pins.includes(target) && !pins.includes(id)) return true;

    return (
      pins.includes(id) &&
      !!target &&
      (!this.settings.sidebar.groupByProject || from.projectId === to.projectId) &&
      threadOrderGroup(this.unpinnedEntries(id), id) === threadOrderGroup(this.entries(), target)
    );
  }
  async drop(id: string, target: string, before: boolean, pin = false) {
    const thread = this.overview.threads.get(id);

    if (!thread || !this.available(thread)) return;
    const pinned = this.settings.sidebar.pinnedThreadIds.includes(id);
    const targetPinned = pin || this.settings.sidebar.pinnedThreadIds.includes(target);

    if (targetPinned && (!pinned || pin)) {
      if (pinned || (await this.changePin(thread, true))) {
        await tick();
        const first = this.peers(thread).find((t) => t.id !== id);
        const destination = pin ? first?.id : target || first?.id;
        const position = destination ? this.position(id, destination, pin ? true : before) : undefined;

        if (position) await this.save(thread, position);
      }

      return;
    }

    if (pinned && !targetPinned) {
      if (!this.canDrop(id, target, before)) return;

      if (this.settings.general.confirmUnpin) this.unpin = { thread, target, before };
      else await this.finishUnpin(thread, target, before);

      return;
    }

    const position = this.position(id, target, before);

    if (position) await this.save(thread, position);
  }
  async confirmUnpin() {
    const pending = this.unpin;

    if (!pending) return;
    this.unpin = undefined;
    await this.finishUnpin(pending.thread, pending.target, pending.before);
  }
  private async finishUnpin(thread: ui.Thread, target: string, before: boolean) {
    if (!(await this.changePin(thread, false))) return;
    await tick();
    const position = this.position(thread.id, target, before);

    if (position) await this.save(thread, position);
  }
  private async changePin(thread: ui.Thread, pinned: boolean) {
    this.saving = true;

    try {
      await this.settings.pinThread(thread.id, pinned);
      this.message = `${pinned ? "Pinned" : "Unpinned"} “${thread.title}”`;

      return true;
    } catch {
      toast("Could not change the pin. Try again.", { tone: "error" });

      return false;
    } finally {
      this.saving = false;
    }
  }
  private async save(thread: ui.Thread, position: Position) {
    this.saving = true;

    try {
      const response = decode(
        ui.GetThreadResponseSchema,
        await requestJson("POST", `/api/threads/${encodeURIComponent(thread.id)}/order`, {
          ...position,
          withinProject:
            this.settings.sidebar.groupByProject && !this.settings.sidebar.pinnedThreadIds.includes(thread.id),
        }),
      );

      if (response.thread)
        this.overview.apply(create(ui.OverviewUpdateSchema, { change: { case: "thread", value: response.thread } }));
      this.message = `Moved “${thread.title}”`;
      await tick();
      document
        .querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(thread.id)}"] a`)
        ?.focus({ preventScroll: true });
    } catch {
      toast("Could not move the thread. Try again.", { tone: "error" });
    } finally {
      this.saving = false;
    }
  }
}
