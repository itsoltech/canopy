import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ui } from "@canopy/contracts";
import { router, useGlobalSearchParams } from "expo-router";
import { useOverview } from "../../state/overview";
import { useDevicePreferences } from "../settings/device-preferences";
import { needsYou } from "@canopy/domain/thread-activity";
import { sidebarChildren } from "@canopy/domain/sidebar-threads";
import { isThreadSnoozed } from "@canopy/domain/thread-snooze";
import { useAppearance } from "../../state/appearance";
import { useSession } from "../../state/session";
import { InAppAlertBanner } from "./InAppAlertBanner";
import { useBotAlerts, type InAppAlert } from "./useBotAlerts";

type NoticeRevision = { revision: string; snoozed: boolean };

function threadSnoozed(threads: ReadonlyMap<string, ui.Thread>, id: string) {
  const thread = threads.get(id);

  return !!thread && isThreadSnoozed(thread, (parentId) => threads.get(parentId));
}

/** Alert only for live changes after the initial snapshot, never replay historical results. */
export function InAppAlerts() {
  const { threads, loaded } = useOverview();
  const { active } = useSession();
  const { threadsEnabled, botsEnabled } = useAppearance();
  const { values } = useDevicePreferences();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const previous = useRef<Map<string, NoticeRevision> | null>(null);
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const sequence = useRef(0);
  const [alert, setAlert] = useState<(InAppAlert & { sequence: number }) | undefined>();

  const showAlert = useCallback((notice: InAppAlert) => {
    setAlert({ ...notice, sequence: ++sequence.current });
  }, []);

  useBotAlerts(id, (threadId) => threadSnoozed(byId, threadId), showAlert);

  useEffect(() => {
    if (!loaded || !active || !threadsEnabled) {
      previous.current = null;

      return;
    }

    // A subagent's result belongs inside its parent. Questions routed to the user alert once on that parent.
    const notices = threads
      .filter((t) => !t.spawnedByAgent && !t.deletedAt && t.status !== "archived")
      .map((t) => {
        const { subagentsNeedingInput } = sidebarChildren(threads.filter((child) => child.parentThreadId === t.id));
        const needs = needsYou(t) || subagentsNeedingInput.length > 0;

        return {
          thread: t,
          status: needs ? "Needs input" : t.unseenResult,
          snoozed: isThreadSnoozed(t, (threadId) => byId.get(threadId)),
          revision: `${t.status}:${t.unseenResult}:${needsYou(t) ? t.pendingInteractions : 0}:${subagentsNeedingInput
            .map((child) => child.id)
            .sort()
            .join(",")}`,
        };
      });

    const current = new Map(notices.map(({ thread, revision, snoozed }) => [thread.id, { revision, snoozed }]));

    // Advance the baseline during snooze too. The transition back to awake only sets a new baseline.
    const changed = notices.find((notice) => {
      const prior = previous.current?.get(notice.thread.id);

      return (
        notice.thread.id !== id &&
        prior &&
        !prior.snoozed &&
        !notice.snoozed &&
        prior.revision !== notice.revision &&
        notice.status
      );
    });

    previous.current = current;

    if (changed && values.inAppNotifications === "on")
      showAlert({
        id: changed.thread.id,
        kind: "thread",
        title: changed.thread.title || "Untitled thread",
        status: changed.status,
      });
  }, [threads, byId, loaded, id, active, values.inAppNotifications, threadsEnabled, showAlert]);
  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(() => setAlert((current) => (current === alert ? undefined : current)), 6000);

    return () => clearTimeout(timer);
  }, [alert]);

  const alertedThreadId = alert?.kind === "thread" ? alert.id : alert?.threadId;
  const muted = alertedThreadId && threadSnoozed(byId, alertedThreadId);

  if (alert && (!active || muted || !(alert.kind === "bot" ? botsEnabled : threadsEnabled))) {
    setAlert(undefined);

    return null;
  }

  if (!alert || values.inAppNotifications !== "on") return null;

  function dismiss() {
    setAlert((current) => (current === alert ? undefined : current));
  }

  return (
    <InAppAlertBanner
      key={alert.sequence}
      alert={alert}
      onDismiss={dismiss}
      onOpen={() => {
        router.push({ pathname: alert.kind === "bot" ? "/bot/[id]" : "/thread/[id]", params: { id: alert.id } });
        dismiss();
      }}
    />
  );
}
