import type { ui } from "@canopy/contracts";
import type { ProjectChoice } from "@canopy/domain/projects";
import { computerName } from "@canopy/domain/computer-presence";
import { nodeRef, splitId } from "@canopy/domain/computers";
import { useOverview } from "../../state/overview";

/** Keep separate same-name projects identifiable; merged projects choose their computer through a worker. */
export function useProjectDetails() {
  const { projectChoices, workers, computers } = useOverview();

  const computer = (node: string) =>
    node
      ? computerName(computers.find((peer) => peer.nodeId === node || nodeRef(peer.nodeId) === node))
      : "This computer";

  const places = (project: ui.Project) => {
    const nodes = project.workspaces.map(
      (workspace) =>
        workers.find((worker) => worker.id === workspace.workerId)?.nodeId ?? splitId(workspace.workerId).node ?? "",
    );

    return [...new Set(nodes.length ? nodes : [project.nodeId])].map(computer).join(" · ");
  };

  const detail = (project: ProjectChoice) => {
    const aliases = project.aliases.length ? `Also named ${project.aliases.map((name) => `“${name}”`).join(", ")}` : "";

    if (!projectChoices.some((other) => other.id !== project.id && other.name === project.name)) return aliases;

    const paths = [...new Set(project.workspaces.map((workspace) => workspace.rootPath || workspace.label))]
      .filter(Boolean)
      .join(" · ");

    return [places(project), paths, aliases].filter(Boolean).join(" · ");
  };

  return { places, detail };
}
