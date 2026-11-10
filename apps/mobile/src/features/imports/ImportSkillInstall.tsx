import { Notice } from "../../ui/components";
import { SettingChoice } from "../settings/SettingsGroup";
import { EnvironmentAssignment } from "../settings/EnvironmentAssignment";
import { ResourceState, useSettingsResource } from "../settings/resource";
import type { useImportDraft } from "./useImportDraft";

export function ImportSkillInstall({ draft }: { draft: ReturnType<typeof useImportDraft> }) {
  const environment = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));

  const skills =
    draft.library.data?.items.filter(
      (i) =>
        ["skill", "command"].includes(i.kind) && draft.choices[i.key] && draft.choices[i.key]?.action !== "replace",
    ) ?? [];

  if (!skills.length) return null;

  return (
    <ResourceState resource={environment}>
      <SettingChoice
        title="Install these skills on"
        value={draft.installTarget}
        onChange={draft.setInstallTarget}
        disabled={draft.disabled}
        options={[
          { value: "source", label: "This computer (import source)" },
          { value: "all", label: "All computers" },
          { value: "choose", label: "Choose…" },
        ]}
      />
      <Notice>New skills install in Canopy sessions after import. Existing skill assignments stay the same.</Notice>
      {draft.installTarget === "choose" && (
        <EnvironmentAssignment
          value={draft.skillSelector}
          workers={environment.data?.workers ?? []}
          onChange={draft.setSkillSelector}
        />
      )}
    </ResourceState>
  );
}
