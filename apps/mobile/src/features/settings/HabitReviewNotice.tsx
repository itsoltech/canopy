import { useEffect, useEffectEvent, useRef } from "react";
import { usePathname } from "expo-router";
import { useOverviewEvents, useOverviewStream } from "../../state/overview-bus";
import { useSession } from "../../state/session";
import { toast } from "../../ui/Toast";
import { useDevicePreferences } from "./device-preferences";
import { MEMORY_HABITS, useMemoryHabits } from "./memory-habits";
import { openSettingsSection } from "./navigation";

type Baseline = { ids?: Set<string>; changed: boolean };

/** Each overview subscription starts with a quiet read of the currently reviewable suggestions. */
export function HabitReviewNotice() {
  const { active, online, queries } = useSession();
  const { connection } = useOverviewStream();
  const { loaded, values } = useDevicePreferences();
  const pathname = usePathname();
  const { data, error, loading, stale } = useMemoryHabits();
  const baseline = useRef<Baseline>({ changed: false });
  const dismiss = useRef<(() => void) | undefined>(undefined);
  const live = active && online && connection === "live";
  const canNotify = live && loaded && values.inAppNotifications === "on" && pathname !== "/settings/memory";

  useOverviewEvents(({ change }) => {
    if (change.case === "mobileSnapshot") {
      baseline.current = { changed: false };
      queries.invalidate(MEMORY_HABITS);
    } else if (change.case === "memoryHabitsChanged" && change.value) {
      baseline.current.changed = true;
      queries.invalidate(MEMORY_HABITS);
    }
  });

  const notify = useEffectEvent((count: number) => {
    if (!canNotify) return;
    dismiss.current?.();
    dismiss.current = toast(count === 1 ? "New habit suggestion" : "New habit suggestions", {
      label: "Review habits",
      run: () => openSettingsSection("memory"),
      failure: "Could not open Memory. Open it from Settings.",
    });
  });

  useEffect(() => {
    if (!live || error) {
      baseline.current = { changed: false };

      return;
    }

    if (data === undefined || loading || stale) return;
    const prior = baseline.current;
    const ids = new Set(data?.suggestions.map(({ id, suspended }) => `${id}:${suspended}`));
    baseline.current = { ids, changed: false };

    const previous = prior.ids;

    if (!prior.changed || !previous) return;
    const added = [...ids].filter((id) => !previous.has(id)).length;

    if (added) notify(added);
  }, [data, error, live, loading, stale]);

  useEffect(() => {
    if (!canNotify || !data?.suggestions.length) dismiss.current?.();
  }, [canNotify, data?.suggestions.length]);

  useEffect(() => () => dismiss.current?.(), []);

  return null;
}
