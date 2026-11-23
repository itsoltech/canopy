import { ui } from "@canopy/contracts";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";

const fields = {
  location: "Worktree location",
  startFromRemote: "Start from remote",
  remote: "Remote",
  branchNaming: "Branch naming",
  branchPrefix: "Branch prefix",
  defaultMode: "Default workspace",
  cleanupDeletedThreads: "Deleted threads",
  cleanupMerged: "Merged branches",
  cleanupInactiveDays: "Inactive for days",
  cleanupSettled: "Archived threads",
  cleanupUnchanged: "Unchanged worktrees",
  keepLocalChanges: "Keep worktrees with local changes",
  deleteLocalBranch: "Delete safe local branches",
};

const labels = new Map(Object.entries(fields));

const branches = new Map([
  [ui.BranchNaming.PREFIX, "Fixed prefix"],
  [ui.BranchNaming.SEMANTIC, "Semantic prefix"],
  [ui.BranchNaming.TITLE, "Thread title"],
]);

export function RecordedWorktreeSettings({ settings, reason }: { settings?: ui.WorktreeSettings; reason: string }) {
  const rows = Object.entries(settings ?? {}).flatMap(([key, value]) => {
    const title = labels.get(key);

    if (!title || value === undefined || (!value && (key === "branchNaming" || key === "defaultMode"))) return [];
    let description = String(value);

    if (key === "branchNaming") description = branches.get(Number(value)) ?? description;
    else if (key === "defaultMode")
      description = value === ui.WorkspaceMode.CHECKOUT ? "Current checkout" : "New worktree";
    else if (value === true || value === false) description = value ? "On" : "Off";

    return [{ title, description }];
  });

  return (
    <SettingsGroup title="Saved worker overrides" description={reason}>
      {rows.length ? (
        rows.map((row) => <SettingsRow key={row.title} {...row} />)
      ) : (
        <SettingsRow title="No overrides saved for this scope." />
      )}
    </SettingsGroup>
  );
}
