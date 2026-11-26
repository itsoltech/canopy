import { useCallback, useEffect, useMemo, useState } from "react";
import { create } from "@bufbuild/protobuf";
import { useGlobalSearchParams, usePathname } from "expo-router";
import { ui } from "@canopy/contracts";
import { expandProjectIds } from "@canopy/domain/projects";
import { sidebarThreads } from "@canopy/domain/sidebar-threads";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { projectAwayReason } from "@canopy/domain/linked-snapshot";
import { useDevicePreferences } from "../settings/device-preferences";

export function useSidebarThreads(query: string) {
  const { threads, projectChoices: choices, workers, computers, setWarmQuery } = useOverview();
  const { sidebar, updateSidebar } = useAppearance();
  const { client } = useSession();

  const {
    view: { threadSortMode: sortMode },
  } = useDevicePreferences();

  const params = useGlobalSearchParams<{ id?: string }>();
  const id = usePathname().startsWith("/thread/") ? params.id : undefined;
  const [fetchedCurrent, setFetchedCurrent] = useState<ui.Thread>();
  const { groupByProject, pinnedThreadIds, projectIds, projectOrder, workingSection } = sidebar;

  const settings = useMemo(
    () =>
      create(ui.SidebarSettingsSchema, {
        groupByProject,
        pinnedThreadIds,
        projectIds: expandProjectIds(projectIds, choices),
        projectOrder,
        workingSection,
      }),
    [choices, groupByProject, pinnedThreadIds, projectIds, projectOrder, workingSection],
  );

  const projectName = useCallback(
    (id: string) => {
      const choice = choices.find((p) => p.projectIds.includes(id));

      return choice ? [choice.name, ...choice.aliases].join(" ") : "";
    },
    [choices],
  );

  const filtered = useMemo(
    () => sidebarThreads(threads, settings, query, projectName, sortMode),
    [threads, settings, query, projectName, sortMode],
  );

  const current = threads.find((t) => t.id === id) ?? (fetchedCurrent?.id === id ? fetchedCurrent : undefined);

  useEffect(() => {
    const timer = setTimeout(() => setWarmQuery(query), 500);

    return () => clearTimeout(timer);
  }, [query, setWarmQuery]);

  useEffect(() => {
    let active = true;

    if (client && id)
      void client.api.getThread({ threadId: id }).then(
        (r) => {
          if (active) setFetchedCurrent(r.thread);
        },
        () => undefined,
      );

    return () => {
      active = false;
    };
  }, [client, id]);

  return {
    query,
    current,
    choices,
    projectAway: (project: ui.Project) => projectAwayReason(project, workers, computers),
    settings,
    sortMode,
    filtered,
    projectName,
    setProjectId: (id: string) => updateSidebar({ projectIds: id ? [id] : [] }),
  };
}
