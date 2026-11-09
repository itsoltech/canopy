import type { ui } from "@canopy/contracts";
import { router } from "expo-router";
import { agentCliName, importItemLabel } from "@canopy/domain/import-look";
import { Button, Notice } from "../../ui/components";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingsRow } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";

export function ImportRunDetails({ run }: { run: ui.ImportRun }) {
  const resource = useSettingsResource(
    `import-detail:${run.id}:${run.done}:${run.failed}:${run.cancelled}:${run.bytesDone}:${run.status}:${run.library.map((item) => item.status).join(",")}`,
    (api) => api.getImportRun({ runId: run.id, items: true }),
  );

  const detail = resource.data;

  return (
    <ResourceState resource={resource}>
      {detail?.library.map((item) => (
        <SettingsRow
          key={item.id}
          title={item.name}
          description={`${agentCliName(item.agentCli)} · ${importItemLabel(item.status)}`}
        >
          {item.detail && <SettingsValue title="Result" value={item.detail} />}
          {item.error && <Notice error>{item.error}</Notice>}
        </SettingsRow>
      ))}
      {detail?.items.map((item) => (
        <SettingsRow
          key={item.id}
          title={item.title || "Untitled thread"}
          description={`${agentCliName(item.agentCli)} · ${importItemLabel(item.status)}`}
        >
          {item.error && <Notice error>{item.error}</Notice>}
          {item.warnings.map((warning, index) => (
            <Notice key={index}>{warning}</Notice>
          ))}
          {item.status === "done" && item.threadId && (
            <Button
              title="Open thread"
              onPress={() => router.push({ pathname: "/thread/[id]", params: { id: item.threadId } })}
            />
          )}
        </SettingsRow>
      ))}
    </ResourceState>
  );
}
