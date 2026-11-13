import { useEffect, useState } from "react";
import { useGlobalSearchParams } from "expo-router";
import { ui } from "@canopy/contracts";
import { expandProjectIds } from "@canopy/domain/projects";
import { sidebarThreads } from "@canopy/domain/sidebar-threads";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { projectAwayReason } from "@canopy/domain/linked-snapshot";
import { useDevicePreferences } from "../settings/device-preferences";

export function useSidebarThreads(query: string) {
  const { threads, projectChoices: choices, workers, computers } = useOverview();
  const { sidebar, updateSidebar } = useAppearance();
  const { client } = useSession();
  const { view } = useDevicePreferences();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const [fetchedCurrent, setFetchedCurrent] = useState<ui.Thread>();
  const settings = { ...sidebar, projectIds: expandProjectIds(sidebar.projectIds, choices) };
  const current = threads.find((t) => t.id === id) ?? (fetchedCurrent?.id === id ? fetchedCurrent : undefined);

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

  const projectName = (id: string) => {
    const choice = choices.find((p) => p.projectIds.includes(id));

    return choice ? [choice.name, ...choice.aliases].join(" ") : "";
  };

  return {
    query,
    current,
    choices,
    projectAway: (project: ui.Project) => projectAwayReason(project, workers, computers),
    settings,
    sortMode: view.threadSortMode,
    filtered: sidebarThreads(threads, settings, query, projectName, view.threadSortMode),
    projectName,
    setProjectId: (id: string) => updateSidebar({ projectIds: id ? [id] : [] }),
  };
}
