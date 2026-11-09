import { View } from "react-native";
import { agentCliName } from "@canopy/domain/import-look";
import { useOverview } from "../../state/overview";
import { Button, Notice } from "../../ui/components";
import { Checkbox } from "../../ui/Checkbox";
import { SettingChoice } from "../settings/SettingsGroup";
import type { useImportDraft } from "./useImportDraft";

export function ImportThreadChoices({
  draft,
  workerId,
}: {
  draft: ReturnType<typeof useImportDraft>;
  workerId: string;
}) {
  const { projects } = useOverview();
  const { result, disabled, targets, setTargets, all, excluded, included, toggle, offset, pageSize, setOffset } = draft;

  return (
    <View style={{ gap: 12 }}>
      {result?.groups.map((group) => (
        <SettingChoice
          key={group.directory}
          title={group.directory}
          value={targets[group.directory] ?? ""}
          disabled={disabled}
          description={
            group.exists
              ? `${group.threads.toLocaleString("en")} ${group.threads === 1 ? "thread" : "threads"}`
              : "Directory no longer exists · History only"
          }
          onChange={(value) => setTargets({ ...targets, [group.directory]: value })}
          options={[
            {
              value: "",
              label:
                group.suggestion?.kind === "workspace"
                  ? `Project “${group.suggestion.projectName}”`
                  : group.exists
                    ? "Create project from directory"
                    : "No project · History only",
            },
            { value: "create_project", label: "Create project from directory", disabled: !group.exists },
            ...projects
              .filter((p) => !p.nodeId && p.kind !== "scratch")
              .flatMap((p) =>
                p.workspaces
                  .filter((w) => w.workerId === workerId)
                  .map((w) => ({
                    value: `workspace:${w.id}`,
                    label: p.name,
                    description: w.rootPath,
                    disabled: !group.exists,
                  })),
              ),
            { value: "no_project", label: "No project" },
            { value: "skip", label: "Skip this directory" },
          ]}
        />
      ))}
      {result?.candidates.map((thread) => (
        <Checkbox
          key={thread.sourceKey}
          label={thread.title || "Untitled thread"}
          description={[
            agentCliName(thread.agentCli),
            thread.cwd,
            thread.reason,
            thread.status === "imported" || thread.status === "in_canopy" ? "Already imported" : "",
            thread.flaggedSecrets ? "Secrets masked" : "",
          ]
            .filter(Boolean)
            .join(" · ")}
          checked={
            ["new", "has_new_turns"].includes(thread.status) &&
            (all ? !excluded.includes(thread.sourceKey) : included.includes(thread.sourceKey))
          }
          disabled={disabled || !["new", "has_new_turns"].includes(thread.status)}
          onChange={(selected) => toggle(thread.sourceKey, selected)}
        />
      ))}
      {result && !result.total && <Notice>No threads match these filters.</Notice>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        <Button
          title="Previous page"
          disabled={disabled || !offset}
          onPress={() => setOffset(Math.max(0, offset - pageSize))}
        />
        <Button
          title="Next page"
          disabled={disabled || !result || offset + result.candidates.length >= result.total}
          onPress={() => setOffset(offset + pageSize)}
        />
      </View>
    </View>
  );
}
