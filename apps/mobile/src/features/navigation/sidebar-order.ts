import { useCallback, useRef } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { threadMove, threadOrderGroup } from "@canopy/domain/thread-order";
import type { SidebarEntry } from "@canopy/domain/sidebar-entries";
import { useSession } from "../../state/session";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { confirm } from "../../ui/Confirm";
import { toast } from "../../ui/Toast";

export type SidebarMove = "up" | "down" | "top" | "bottom";

export function useSidebarOrder(
  entries: readonly SidebarEntry[],
  unpinnedEntries: readonly SidebarEntry[],
  settings: ui.SidebarSettings,
) {
  const { client, online } = useSession();
  const { updateThread } = useOverview();
  const appearance = useAppearance();
  const latest = useRef({ entries, unpinnedEntries, settings, client, online, appearance, updateThread });
  latest.current = { entries, unpinnedEntries, settings, client, online, appearance, updateThread };
  const busy = useRef(false);

  const drop = useCallback(async (id: string, target: string, before: boolean, pin = false) => {
    if (pin) target = "";
    const state = latest.current;
    const thread = state.entries.find((e) => e.thread?.id === id)?.thread;
    const to = state.entries.find((e) => e.thread?.id === target)?.thread;

    if (!thread || thread.nodeId || !state.client || !state.online || busy.current || to?.nodeId) return;
    const pins = state.settings.pinnedThreadIds;
    const wasPinned = pins.includes(id);
    const willPin = pin || pins.includes(target);
    const sameProject = !state.settings.groupByProject || willPin || thread.projectId === to?.projectId;
    const source = wasPinned && !willPin ? state.unpinnedEntries : state.entries;

    if (!sameProject || (!willPin && threadOrderGroup(source, id) !== threadOrderGroup(source, target))) return;

    const save = async () => {
      if (busy.current || !state.client) return;
      busy.current = true;

      try {
        if (wasPinned !== willPin) {
          const user = (await state.client.api.getSettings({})).user;

          if (!user) throw new Error("Settings unavailable");
          const sidebar = create(ui.SidebarSettingsSchema, user.sidebar);
          sidebar.pinnedThreadIds = willPin
            ? [...new Set([...sidebar.pinnedThreadIds, id])]
            : sidebar.pinnedThreadIds.filter((value) => value !== id);
          await state.client.api.updateUserSettings({ expectedVersion: user.version, sidebar });
          await state.appearance.reload();
        }

        // Compute against the destination section immediately; do not wait for a React settings render.
        const section = willPin ? "pinned" : threadOrderGroup(source, id);
        let heading = "";

        const peers = source.filter((entry) => {
          if (entry.heading) heading = entry.key;
          const row = entry.thread;

          return (
            row &&
            row.id !== id &&
            !row.nodeId &&
            (willPin
              ? pins.includes(row.id)
              : heading === section && (!state.settings.groupByProject || row.projectId === thread.projectId))
          );
        });

        const at = target ? peers.findIndex((entry) => entry.thread?.id === target) + (before ? 0 : 1) : 0;

        if (target && !peers.some((entry) => entry.thread?.id === target)) return;

        const response = await state.client.api.reorderThread({
          threadId: id,
          afterThreadId: peers[at - 1]?.thread?.id ?? "",
          beforeThreadId: peers[at]?.thread?.id ?? "",
          withinProject: state.settings.groupByProject && !willPin,
        });

        if (response.thread) state.updateThread(response.thread);
        toast(wasPinned !== willPin ? (willPin ? "Thread pinned" : "Thread unpinned") : "Thread moved");
      } catch {
        toast("Could not move the thread. Check the connection and retry.");
      } finally {
        busy.current = false;
      }
    };

    if (wasPinned && !willPin && state.appearance.user?.general?.confirmUnpin)
      confirm({
        title: "Unpin thread?",
        description: `Remove “${thread.title || "Untitled thread"}” from Pinned? The thread stays in the inbox.`,
        confirm: "Unpin thread",
        danger: false,
        action: () => void save(),
      });
    else await save();
  }, []);

  const move = useCallback(
    (id: string, direction: SidebarMove) => {
      const { entries: current, settings: sidebar } = latest.current;
      const thread = current.find((entry) => entry.thread?.id === id)?.thread;

      if (!thread || thread.nodeId) return;

      const peers = current.filter(
        (entry) =>
          !entry.thread ||
          !sidebar.groupByProject ||
          sidebar.pinnedThreadIds.includes(id) ||
          entry.thread.projectId === thread.projectId,
      );

      const group = threadOrderGroup(peers, id);
      let heading = "";

      const rows = peers.flatMap((entry) => {
        if (entry.heading) heading = entry.key;

        return heading === group && entry.thread && !entry.thread.nodeId ? [entry.thread] : [];
      });

      const at = rows.findIndex((row) => row.id === id);
      const before = direction === "up" || direction === "top";
      const index = direction === "top" ? 0 : direction === "bottom" ? rows.length - 1 : at + (before ? -1 : 1);
      const target = rows[index];

      if (target && threadMove(peers, id, target.id, before)) void drop(id, target.id, before);
    },
    [drop],
  );

  return { drop, move };
}
