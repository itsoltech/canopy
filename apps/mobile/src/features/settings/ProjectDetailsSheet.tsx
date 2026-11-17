import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { projectAwayReason } from "@canopy/domain/linked-snapshot";
import { useOverview } from "../../state/overview";
import { Button, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsTextInput } from "./SettingsTextInput";
import { ResourceState } from "./resource";
import { ProjectDefaults, type ProjectResource } from "./ProjectDefaults";
import { useProjectDetails } from "../computers/project-details";
import { AddWorkspace } from "./AddWorkspace";
import { WorkspaceRow } from "./WorkspaceRow";

/** Content lives inside the detail sheet so workspace actions open above it. */
export function ProjectDetailsSheet({
  project,
  defaultsProject,
  resource,
}: {
  project: ui.Project;
  defaultsProject: ui.Project;
  resource: ProjectResource;
}) {
  const { workers, computers } = useOverview();
  const details = useProjectDetails();
  const [adding, setAdding] = useState(false);
  const [addingWorkspace, setAddingWorkspace] = useState(false);

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Project" description={details.places(project)}>
        {project.nodeId ? (
          <SettingsRow
            title={project.name}
            description={
              projectAwayReason(project, workers, computers) ?? "This project is on a linked computer. Manage it there."
            }
          />
        ) : (
          <SettingsTextInput
            title="Project name"
            value={project.name}
            busy={resource.busy}
            onSave={async (name) => !!(await resource.run((api) => api.renameProject({ projectId: project.id, name })))}
          />
        )}
      </SettingsGroup>
      <SettingsGroup
        title="Workspaces"
        description="New threads run in these directories on your workers."
        actions={<Button title="Add workspace" onPress={() => setAdding(true)} />}
      >
        {project.workspaces.length ? (
          project.workspaces.map((workspace) => <WorkspaceRow key={workspace.id} workspace={workspace} />)
        ) : (
          <SettingsRow title="No workspaces yet" description="Add a directory on a worker to start threads." />
        )}
      </SettingsGroup>
      {!project.nodeId && <ProjectDefaults project={defaultsProject} resource={resource} />}
      <Sheet title="Add workspace" visible={adding} scroll={false} onClose={() => !addingWorkspace && setAdding(false)}>
        {adding && <AddWorkspace project={project} onBusy={setAddingWorkspace} onSaved={() => setAdding(false)} />}
      </Sheet>
    </ResourceState>
  );
}
