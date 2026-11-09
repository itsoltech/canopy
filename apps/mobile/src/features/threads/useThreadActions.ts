import { useRef, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { router, useGlobalSearchParams, usePathname } from "expo-router";
import { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { useAppearance } from "../../state/appearance";
import { confirm } from "../../ui/Confirm";
import { toast } from "../../ui/Toast";
import { useComputerHome } from "../computers/presence";

export type ThreadAction = "side" | "goal" | "pin" | "rename" | "regenerate" | "read" | "archive" | "delete";

export function useThreadActions(thread: ui.Thread) {
  const { client, online } = useSession();
  const appearance = useAppearance();
  const home = useComputerHome(thread.nodeId);
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const path = usePathname();
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const pinned = appearance.user?.sidebar?.pinnedThreadIds.includes(thread.id) ?? false;
  const archived = Boolean(thread.archivedAt) || thread.status === "archived";
  const disabled = !client || !online || home.away || Boolean(thread.deletedAt) || !appearance.user;

  async function execute(action: Exclude<ThreadAction, "side" | "goal">, title?: string) {
    if (!client || disabled || running.current) return false;
    running.current = true;
    setBusy(true);

    try {
      if (action === "rename") await client.api.updateThread({ threadId: thread.id, title });
      else if (action === "pin") {
        const user = (await client.api.getSettings({})).user;

        if (!user) throw new Error("Settings unavailable");
        const sidebar = create(ui.SidebarSettingsSchema, user.sidebar);
        sidebar.pinnedThreadIds = pinned
          ? sidebar.pinnedThreadIds.filter((value) => value !== thread.id)
          : [...new Set([...sidebar.pinnedThreadIds, thread.id])];
        await client.api.updateUserSettings({ expectedVersion: user.version, sidebar });
        await appearance.reload();
      } else if (action === "regenerate") await client.api.regenerateTitle({ threadId: thread.id });
      else if (action === "read")
        await client.api.setThreadRead({ threadId: thread.id, unread: !(thread.markedUnread || thread.unseenResult) });
      else if (action === "archive") {
        await client.api.setThreadArchived({
          threadId: archived && thread.archivedBy === "cascade" ? thread.parentThreadId : thread.id,
          archived: !archived,
        });
      } else if (action === "delete") {
        const result = await client.api.deleteThread({ threadId: thread.id });
        const reopen = path.startsWith("/thread/") && id && result.threadIds.includes(id) ? id : undefined;

        if (reopen) router.replace("/");
        toast("Thread deleted", {
          label: "Undo",
          run: async () => {
            await client.api.restoreThread({ threadId: thread.id });

            if (reopen) router.push({ pathname: "/thread/[id]", params: { id: reopen } });
          },
        });
      }

      return true;
    } catch {
      toast("Could not update the thread. Check the connection and retry.");

      return false;
    } finally {
      running.current = false;
      setBusy(false);
    }
  }

  function run(action: Exclude<ThreadAction, "side" | "goal" | "rename">) {
    const general = appearance.user?.general;

    if (action === "delete" && general?.confirmDelete !== false) {
      confirm({
        title: "Delete thread?",
        description: `This deletes “${thread.title || "Untitled thread"}” and its side threads. Running turns stop and schedules are cancelled. You can undo this for a few seconds.`,
        confirm: "Delete thread",
        action: () => void execute(action),
      });
    } else if (action === "archive" && !archived && general?.confirmArchive) {
      confirm({
        title: "Archive thread?",
        description: "This also archives its side threads.",
        confirm: "Archive thread",
        danger: false,
        action: () => void execute(action),
      });
    } else if (action === "pin" && pinned && general?.confirmUnpin) {
      confirm({
        title: "Unpin thread?",
        description: "This removes the thread from pinned threads.",
        confirm: "Unpin thread",
        danger: false,
        action: () => void execute(action),
      });
    } else void execute(action);
  }

  return { busy, disabled, pinned, archived, run, rename: (title: string) => execute("rename", title) };
}
