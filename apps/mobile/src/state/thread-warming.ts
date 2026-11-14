import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { usePathname } from "expo-router";
import type { ui } from "@canopy/contracts";
import { ThreadWarmer } from "@canopy/domain/thread-warmer";
import { threadWarmSet } from "@canopy/domain/thread-warm-set";
import { sidebarThreads } from "@canopy/domain/sidebar-threads";
import { expandProjectIds, projectChoices } from "@canopy/domain/projects";
import { useSession } from "./session";
import { useAppearance } from "./appearance";
import { useOverviewEvents, useOverviewHeadSelection } from "./overview-bus";
import { useLowPowerMode } from "./low-power";
import { mobileMeasurements } from "../features/settings/client-diagnostics";
import { whileForeground } from "./foreground-work";

const limits = { recent: 10, count: 16, intervalMs: 5000, retryMs: 30_000 };

/** Pairing lifetime, one job, persistent sequence checkpoints, no inactive/background network work. */
export function useThreadWarming(threads: ui.Thread[], projects: ui.Project[], live: boolean, query: string) {
  const { client, threadCache, active, online } = useSession();
  const { sidebar } = useAppearance();
  const setHeadIds = useOverviewHeadSelection();
  const lowPower = useLowPowerMode();
  const pathname = usePathname();

  const warming = useMemo(
    () =>
      client && threadCache
        ? new ThreadWarmer(
            threadCache.warming,
            (threadId, syncCursor, signal) =>
              client.api.watchThread(
                { threadId, syncCursor, sequence: true, background: true, pageSize: 24 },
                { signal },
              ),
            { ...limits, requested: () => mobileMeasurements.record(14, 1) },
          )
        : undefined,
    [client, threadCache],
  );

  const ids = useMemo(() => {
    const choices = projectChoices(projects.filter((project) => !project.archivedAt));
    const settings = { ...sidebar, projectIds: expandProjectIds(sidebar.projectIds, choices) };

    const visible = sidebarThreads(
      threads,
      settings,
      query,
      (id) => projects.find((project) => project.id === id)?.name ?? "",
    ).roots;

    return threadWarmSet(
      threads,
      sidebar.pinnedThreadIds,
      visible.map((thread) => thread.id),
      limits,
    );
  }, [threads, projects, sidebar, query]);

  const selection = [...ids].sort().join(",");
  const priority = ids.join(",");

  useEffect(() => {
    setHeadIds(selection);
  }, [selection, setHeadIds]);
  useEffect(() => {
    warming?.select(priority ? priority.split(",") : []);
  }, [warming, priority]);
  useEffect(() => {
    warming?.activate(pathname.startsWith("/thread/") ? decodeURIComponent(pathname.slice(8)) : "");
  }, [warming, pathname]);
  useEffect(() => {
    warming?.enable(active && online && live && !lowPower && AppState.currentState === "active");
  }, [warming, active, online, live, lowPower]);
  useEffect(() => {
    const app = AppState.addEventListener("change", (state) => {
      if (state !== "active") warming?.enable(false);
    });

    const stop = whileForeground(AppState, () => {
      const timer = setInterval(() => {
        if (threadCache) mobileMeasurements.record(15, threadCache.usage.bytes);
      }, 60_000);

      return () => clearInterval(timer);
    });

    return () => {
      app.remove();
      stop();
      warming?.close();
    };
  }, [warming, threadCache]);
  useOverviewEvents((update) => {
    if (update.change.case === "threadHeads") warming?.heads(update.change.value.heads);
  });

  return warming;
}
