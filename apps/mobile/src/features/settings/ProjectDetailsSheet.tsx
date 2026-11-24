import { useState } from "react";
import type { ui } from "@canopy/contracts";
import { projectAwayReason } from "@canopy/domain/linked-snapshot";
import { useOverview } from "../../state/overview";
import { Button, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { ConfigNoticesFor } from "./ConfigNoticesFor";
import { ProjectWorktreeDefaults } from "./ProjectWorktreeDefaults";
import { useOpenSettingsSection } from "./navigation";
import { ResourceState, confirmAction } from "./resource";
import { ProjectDefaults, type ProjectResource } from "./ProjectDefaults";
import { ProjectColorSetting } from "./ProjectColorSetting";
import { useProjectDetails } from "../computers/project-details";
import { AddWorkspace } from "./AddWorkspace";
import { WorkspaceRow } from "./WorkspaceRow";

/** Content lives inside the detail sheet so workspace actions open above it. */
export function ProjectDetailsSheet({
  project,
  defaultsProject,
  resource,
  onClose,
}: {
  project: ui.Project;
  defaultsProject: ui.Project;
  resource: ProjectResource;
  onClose: () => void;
}) {
  const { workers, computers } = useOverview();
  const details = useProjectDetails();
  const openSettingsSection = useOpenSettingsSection();
  const [adding, setAdding] = useState(false);
  const [addingWorkspace, setAddingWorkspace] = useState(false);

  return (
    <ResourceState resource={resource}>
      <ConfigNoticesFor
        match={(notice) =>
          ["project", "project_settings", "worktree_policy"].includes(notice.kind) && notice.localId === project.id
        }
        onChanged={resource.reload}
      />
      <SettingsGroup title="Project" description={details.places(project)}>
        {project.nodeId ? (
          <SettingsRow
            title={project.name}
            description={
              projectAwayReason(project, workers, computers) ?? "This project is on a linked computer. Manage it there."
            }
          />
        ) : (
          <SettingsInput
            title="Project name"
            value={project.name}
            busy={resource.busy}
            onSave={async (name) => !!(await resource.run((api) => api.renameProject({ projectId: project.id, name })))}
          />
        )}
        {!project.nodeId && project.kind !== "scratch" && <ProjectColorSetting project={project} resource={resource} />}
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
      {!project.nodeId && (
        <ProjectWorktreeDefaults
          projectId={project.id}
          onOpen={() => openSettingsSection("worktrees", { projectId: project.id })}
        />
      )}
      {!project.nodeId && project.kind === "project" && (
        <SettingsGroup>
          <SettingsRow
            title="Archive project"
            description="Remove the project and its threads from Canopy. Files stay on the workers."
            control={
              <Button
                title="Archive project…"
                variant="danger"
                disabled={resource.busy}
                onPress={() =>
                  confirmAction(
                    "Archive project",
                    `This archives “${project.name}” and its threads. Running turns stop and Canopy cancels the project's schedules. Files stay on the workers.`,
                    () =>
                      void resource
                        .run((api) => api.archiveProject({ projectId: project.id }, { timeoutMs: 60_000 }))
                        .then((result) => {
                          if (result) onClose();
                        }),
                  )
                }
              />
            }
          />
        </SettingsGroup>
      )}
      <Sheet title="Add workspace" visible={adding} scroll={false} onClose={() => !addingWorkspace && setAdding(false)}>
        {adding && <AddWorkspace project={project} onBusy={setAddingWorkspace} onSaved={() => setAdding(false)} />}
      </Sheet>
    </ResourceState>
  );
}
