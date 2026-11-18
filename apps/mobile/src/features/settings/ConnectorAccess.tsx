import type { connectors } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { SettingsGroup } from "./SettingsGroup";
import { ResourceState, useSettingsAction, workersFollowStream } from "./resource";
import { useBotList } from "../../state/bot-list";
import { SettingAccess } from "./SettingAccess";

export function ConnectorAccess({
  account,
  onChanged,
}: {
  account: connectors.ConnectorAccount;
  onChanged: () => void;
}) {
  const list = useBotList();
  const { botsEnabled, threadsEnabled } = useAppearance();
  const resource = useSettingsAction(botsEnabled ? list : workersFollowStream);
  const { workers } = useOverview();

  const change = (patch: { allWorkers?: boolean; workerIds?: string[]; allBots?: boolean; botIds?: string[] }) =>
    void resource
      .run((api) =>
        api.setConnectorAccess({
          accountId: account.id,
          expectedRevision: account.revision,
          allWorkers: account.allWorkers,
          workerIds: account.workerIds,
          allBots: account.allBots,
          botIds: account.botIds,
          ...patch,
        }),
      )
      .then(onChanged);

  const bots = (list.data?.bots ?? [])
    .filter((bot) => !bot.archived)
    .map((bot) => ({ id: bot.id, name: bot.configuration?.name || "Bot" }));

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Access" description="Choose who can use this account.">
        {threadsEnabled && (
          <SettingAccess
            title="Workers"
            options={workers.map((w) => ({ id: w.id, name: w.name, online: w.online }))}
            all={account.allWorkers}
            ids={account.workerIds}
            disabled={resource.busy}
            onChange={(next) => change({ allWorkers: next.all, workerIds: [...next.ids] })}
          />
        )}
        {botsEnabled && (
          <SettingAccess
            title="Bots"
            options={bots}
            all={account.allBots}
            ids={account.botIds}
            disabled={resource.busy}
            onChange={(next) => change({ allBots: next.all, botIds: [...next.ids] })}
          />
        )}
      </SettingsGroup>
    </ResourceState>
  );
}
