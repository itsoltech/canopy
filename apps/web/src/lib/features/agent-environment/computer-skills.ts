import type { EnvironmentSkillStatus } from "@canopy/contracts";

export interface SkillLibraryEntry {
  id: string;
  name: string;
  artifactName: string;
}

export interface ComputerSkill {
  key: string;
  name: string;
  skillId: string;
  files: EnvironmentSkillStatus[];
  membership: string;
  missingFromLibrary: boolean;
  overlappingAgents: string[];
}

export const needsAttention = (file: EnvironmentSkillStatus) => file.status === "drift" || file.status === "error";

function groupOrder(group: ComputerSkill) {
  if (group.files.some(needsAttention) || group.overlappingAgents.length) return 0;

  return group.skillId ? 2 : 1;
}

function priority(file: EnvironmentSkillStatus) {
  if (file.status === "error") return 0;

  if (file.status === "drift") return 1;

  if (file.status === "kept") return 2;

  return 3;
}

function personalSkill(file: EnvironmentSkillStatus) {
  return file.scope === "device" && file.localName ? `${file.harness}/${file.localName}` : "";
}

function overlappingAgents(files: readonly EnvironmentSkillStatus[]) {
  const paths = new Map<string, Set<string>>();
  const local = new Set<string>();

  for (const file of files) {
    const key = personalSkill(file);

    if (!key) continue;

    if (!file.skillId) local.add(key);
    const locations = paths.get(key) ?? new Set<string>();
    locations.add(file.path);
    paths.set(key, locations);
  }

  return [
    ...new Set(
      files.flatMap((f) => {
        const key = personalSkill(f);

        return local.has(key) && (paths.get(key)?.size ?? 0) > 1 ? [agentLabel(f.harness)] : [];
      }),
    ),
  ].sort();
}

export function computerSkills(files: readonly EnvironmentSkillStatus[], library?: readonly SkillLibraryEntry[]) {
  const groups = new Map<string, ComputerSkill>();
  const assignedNames = new Map<string, string>();

  for (const file of files) {
    const key = personalSkill(file);

    if (!key || !file.skillId || file.status === "removed") continue;
    const previous = assignedNames.get(key);
    assignedNames.set(key, previous === undefined || previous === file.skillId ? file.skillId : "");
  }

  for (const file of files) {
    if (file.status === "removed") continue;
    const localName = file.localName || file.path.split(/[\\/]/u).at(-1) || "";
    const skillId = file.skillId || assignedNames.get(personalSkill(file)) || "";
    const key = skillId ? `assigned/${skillId}` : `local/${localName || file.targetId}`;
    let group = groups.get(key);

    if (!group) {
      const assigned = skillId ? library?.find((item) => item.id === skillId) : undefined;
      const name = assigned?.name || localName || "Skill locations";
      const matches = file.localName ? library?.filter((item) => item.artifactName === file.localName) : undefined;
      const missingFromLibrary = !skillId && matches?.length === 0 && !!library?.every((item) => item.artifactName);
      let membership = "";

      if (!skillId && matches?.length === 1) membership = `Name matches “${matches[0]!.name}” in library`;
      else if (!skillId && matches && matches.length > 1) membership = "Name matches multiple library skills";
      else if (missingFromLibrary) membership = "Not in library";

      group = { key, name, skillId, files: [], membership, missingFromLibrary, overlappingAgents: [] };
      groups.set(key, group);
    }

    group.files.push(file);
  }

  for (const group of groups.values()) {
    group.files.sort((a, b) => priority(a) - priority(b) || a.path.localeCompare(b.path));
    group.overlappingAgents = overlappingAgents(group.files);
  }

  return [...groups.values()].sort((a, b) => groupOrder(a) - groupOrder(b) || a.name.localeCompare(b.name));
}

export function skillLocation(file: EnvironmentSkillStatus) {
  const agent = agentLabel(file.harness);

  if (file.scope === "device") return `${agent} CLI`;

  if (file.scope === "platform") return `${agent} in Canopy`;

  return agent || "Skill locations";
}

export function groupStatus(group: ComputerSkill) {
  const first = group.files[0]!;

  if (first.status === "error") return first.harness ? `${skillLocation(first)} sync failed` : "Sync failed";

  if (first.status === "drift")
    return first.owned ? `Edited in ${skillLocation(first)}` : `Conflict in ${skillLocation(first)}`;

  if (group.overlappingAgents.length) return `Multiple ${group.overlappingAgents.join(", ")} CLI locations`;

  return group.membership || fileState(first);
}

export function agentLabel(harness: string) {
  return harness.slice(0, 1).toUpperCase() + harness.slice(1);
}

export function canArchive(file: EnvironmentSkillStatus) {
  return (
    file.scope === "device" &&
    !file.owned &&
    Boolean(file.archiveToken && file.localName && file.path) &&
    ["local", "kept", "drift", "error"].includes(file.status)
  );
}

/** The gateway consumes this token before the worker reports the outcome. */
export function awaitingArchive(file: EnvironmentSkillStatus, request: EnvironmentSkillStatus) {
  return (
    file.targetId === request.targetId &&
    !file.archiveToken &&
    file.status === request.status &&
    file.detail === request.detail &&
    file.observedChecksum === request.observedChecksum
  );
}

export function archiveLocation(file: EnvironmentSkillStatus) {
  // A worker path may be Windows-style even when this browser is running on Unix.
  const separator = file.path.startsWith("/") ? "/" : "\\";
  const root = file.path.slice(0, file.path.lastIndexOf(separator));
  const parent = root.slice(0, root.lastIndexOf(separator));

  return [parent, ".canopy-skill-archive", file.archiveToken, file.localName].join(separator);
}

export function fileState(file: EnvironmentSkillStatus) {
  switch (file.status) {
    case "error":
      return "Sync failed";
    case "drift":
      return file.owned ? "Local edits" : "Local copy blocks sync";
    case "kept":
      return "Kept locally";
    case "local":
      return file.localLink ? "Local link" : "Local directory";
    case "applied":
      return "Installed by Canopy";
    default:
      return file.status;
  }
}

export function skillProblem(file: EnvironmentSkillStatus) {
  if (/local link occupies/iu.test(file.detail))
    return canArchive(file)
      ? "A local link blocks installation. Archive the link to install the library version."
      : "A local link blocks installation. Move it out of the skills directory on this computer.";

  if (/symlink|symbolic link|regular director/iu.test(file.detail)) {
    if (canArchive(file)) return "A link or file blocks this directory. Archive the local copy to install the skill.";

    return "Check this path for links. Canopy needs a regular directory to sync the skill.";
  }

  if (/permission|EACCES|EPERM/iu.test(file.detail)) return "Check that the worker can read and write this directory.";

  if (/ownership manifest/iu.test(file.detail))
    return "Restore the worker’s skill ownership file from a backup before syncing.";

  if (/comparisons fill/iu.test(file.detail)) return "Resolve the other local changes to see this comparison.";

  if (/two skills|same destination/iu.test(file.detail)) return "Review the library assignments for this computer.";

  if (/user-owned files/iu.test(file.detail)) return "Move the conflicting local files out of the skill directory.";

  if (/copy changed|assignment changed/iu.test(file.detail))
    return "This copy changed. Refresh the report and review its current location.";

  if (/too large|too many /iu.test(file.detail))
    return "This copy exceeds the archive limit. Move it manually on this computer.";

  if (/overlaps a Canopy installation/iu.test(file.detail)) return "Check the managed skill that uses this directory.";

  return "Review the worker details and check this location on the computer.";
}
