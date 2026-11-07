import { useEffect, useState } from "react";
import { useGlobalSearchParams } from "expo-router";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { expandProjectIds, projectChoices } from "@canopy/domain/projects";
import { sidebarThreads } from "@canopy/domain/sidebar-threads";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";

export function useSidebarThreads(query: string) {
  const { threads, projects } = useOverview();
  const { user, update } = useAppearance();
  const { client } = useSession();
  const { id } = useGlobalSearchParams<{ id?: string }>();
  const [fetchedCurrent, setFetchedCurrent] = useState<ui.Thread>();
  const choices = projectChoices(projects);
  const sidebar = user?.sidebar ?? create(ui.SidebarSettingsSchema);
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
    current,
    choices,
    settings,
    filtered: sidebarThreads(threads, settings, query, projectName),
    projectName,
    setProjectId: (id: string) => void update({ sidebar: { ...sidebar, projectIds: id ? [id] : [] } }),
  };
}
