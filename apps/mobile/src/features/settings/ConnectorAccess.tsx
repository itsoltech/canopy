import type { connectors } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { SettingsGroup, SettingToggle } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";

export function ConnectorAccess({
  account,
  onChanged,
}: {
  account: connectors.ConnectorAccount;
  onChanged: () => void;
}) {
  const resource = useSettingsResource(`connector-access:${account.id}`, (api) => api.listBots({}), "ListBots");
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

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Access" description="All includes future workers and bots belonging to you.">
        <SettingToggle
          title="All workers"
          value={account.allWorkers}
          disabled={resource.busy}
          onChange={(allWorkers) => change({ allWorkers })}
        />
        {!account.allWorkers &&
          workers.map((worker) => (
            <SettingToggle
              key={worker.id}
              title={worker.name}
              value={account.workerIds.includes(worker.id)}
              disabled={resource.busy}
              onChange={(enabled) =>
                change({
                  workerIds: enabled
                    ? [...account.workerIds, worker.id]
                    : account.workerIds.filter((id) => id !== worker.id),
                })
              }
            />
          ))}
        <SettingToggle
          title="All bots"
          value={account.allBots}
          disabled={resource.busy}
          onChange={(allBots) => change({ allBots })}
        />
        {!account.allBots &&
          resource.data?.bots.map((bot) => (
            <SettingToggle
              key={bot.id}
              title={bot.configuration?.name || "Bot"}
              value={account.botIds.includes(bot.id)}
              disabled={resource.busy}
              onChange={(enabled) =>
                change({ botIds: enabled ? [...account.botIds, bot.id] : account.botIds.filter((id) => id !== bot.id) })
              }
            />
          ))}
      </SettingsGroup>
    </ResourceState>
  );
}
