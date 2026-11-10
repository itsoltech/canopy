import type { ui } from "@canopy/contracts";
import { agentCliName } from "@canopy/domain/import-look";
import { Button, Field, Notice } from "../../ui/components";
import { Checkbox } from "../../ui/Checkbox";
import { SettingChoice, SettingsGroup } from "../settings/SettingsGroup";
import { ResourceState } from "../settings/resource";
import { ImportLibraryChoices } from "./ImportLibraryChoices";
import { ImportThreadChoices } from "./ImportThreadChoices";
import { useImportDraft } from "./useImportDraft";
import { ImportSkillInstall } from "./ImportSkillInstall";

export function ImportReview({ scan, onStarted }: { scan: ui.ScanImportResponse; onStarted: () => void }) {
  const draft = useImportDraft(scan, onStarted);
  const { filters, refilter, resource, library, result, busy, disabled, count } = draft;

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Threads">
        <SettingChoice
          title="Agent CLI"
          value={filters.cli}
          disabled={busy}
          onChange={(cli) => refilter({ cli })}
          options={[
            { value: "", label: "All agents" },
            ...scan.overview.map((source) => ({ value: source.agentCli, label: agentCliName(source.agentCli) })),
          ]}
        />
        <SettingChoice
          title="Last active"
          value={filters.days}
          disabled={busy}
          onChange={(days) => refilter({ days })}
          options={[
            { value: 7, label: "Last 7 days" },
            { value: 30, label: "Last 30 days" },
            { value: 90, label: "Last 90 days" },
            { value: 0, label: "All time" },
          ]}
        />
        <Field
          label="Search threads"
          value={filters.search}
          editable={!busy}
          onChangeText={(search) => refilter({ search })}
        />
        <Field
          label="Source directory"
          value={filters.directory}
          editable={!busy}
          autoCorrect={false}
          autoCapitalize="none"
          onChangeText={(directory) => refilter({ directory })}
        />
        <Checkbox
          label="Include subagents"
          checked={filters.subagents}
          disabled={busy}
          onChange={(subagents) => refilter({ subagents })}
        />
        <Checkbox
          label="Select all matching threads"
          checked={draft.all && !draft.excluded.length}
          disabled={disabled || !result}
          onChange={draft.selectAll}
        />
        <Notice>
          {count.toLocaleString("en")} {count === 1 ? "thread" : "threads"} selected. Canopy copies their history.
        </Notice>
        <ImportThreadChoices draft={draft} workerId={scan.workerId} />
      </SettingsGroup>
      <ResourceState resource={library}>
        <ImportSkillInstall draft={draft} />
        <ImportLibraryChoices
          items={library.data?.items ?? []}
          choices={draft.choices}
          onChange={draft.setChoices}
          disabled={disabled}
        />
      </ResourceState>
      <SettingChoice
        title="Import mode"
        value={draft.mode}
        onChange={draft.setMode}
        disabled={disabled}
        options={[
          { value: "continue", label: "Continue where possible" },
          { value: "history", label: "History only" },
        ]}
      />
      <Button
        title="Import selection"
        variant="primary"
        busy={busy}
        disabled={disabled || !result || (!count && !Object.keys(draft.choices).length)}
        onPress={() => void draft.start()}
      />
    </ResourceState>
  );
}
