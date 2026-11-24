import { useState } from "react";
import { useIsFocused } from "expo-router";
import { createSettingsViewState } from "./SettingsScroll";
import { useOverview } from "../../state/overview";
import { Button, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";
import { Skeleton, SkeletonScope } from "../../ui/Skeleton";
import { AddProjectSheet } from "./AddProject";
import { ProjectSettingsRow } from "./ProjectSettingsRow";
import { ProjectDetailsSheet } from "./ProjectDetailsSheet";

const useSelectedProject = createSettingsViewState<string | undefined>(undefined);

export function ProjectSettings() {
  const { projects: records, projectChoices, loaded } = useOverview();
  const resource = useSettingsResource("GetSettings", (api) => api.getSettings({}));
  const [adding, setAdding] = useState(false);
  const [selectedId, setSelectedId] = useSelectedProject();
  const focused = useIsFocused();
  const projects = projectChoices.filter((project) => project.kind !== "scratch" && !project.archivedAt);

  const selected = projects.find(
    (project) => project.id === selectedId || project.projectIds.includes(selectedId ?? ""),
  );

  return (
    <ResourceState resource={resource}>
      <SettingsGroup
        title="Projects"
        description="Choose a project to manage its workspaces and threads."
        actions={<Button variant="primary" title="Add project" onPress={() => setAdding(true)} />}
      >
        {!loaded ? (
          <SkeletonScope loading>
            <Skeleton style={{ height: 64, width: "100%" }} />
          </SkeletonScope>
        ) : projects.length ? (
          projects.map((project) => (
            <ProjectSettingsRow key={project.id} project={project} onPress={() => setSelectedId(project.id)} />
          ))
        ) : (
          <SettingsRow
            title="No projects yet"
            description="A project groups threads. Its workspaces are directories on your workers."
          />
        )}
      </SettingsGroup>
      <AddProjectSheet visible={adding} onClose={() => setAdding(false)} />
      <Sheet
        title={selected?.name ?? "Project"}
        visible={!!selected && focused}
        onClose={() => !resource.busy && setSelectedId(undefined)}
      >
        {selected && (
          <ProjectDetailsSheet
            key={selected.id}
            project={selected}
            onClose={() => setSelectedId(undefined)}
            defaultsProject={records.find((record) => record.id === selected.id) ?? selected}
            resource={resource}
          />
        )}
      </Sheet>
    </ResourceState>
  );
}
