import type { connectors } from "@canopy/contracts";
import { useAppearance } from "../../state/appearance";
import { useOverview } from "../../state/overview";
import { SettingsGroup } from "./SettingsGroup";
import { ResourceState, useSettingsAction, workersFollowStream } from "./resource";
import { useBotList } from "../../state/bot-list";
import { SettingAccess } from "./SettingAccess";
import { Notice } from "../../ui/components";

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
  const { projects, loaded } = useOverview();

  const change = (
    patch:
      | Pick<connectors.SetConnectorAccessRequest, "allProjects" | "projectIds">
      | {
          allBots: boolean;
          botIds: string[];
        },
  ) =>
    void resource
      .run((api) =>
        api.setConnectorAccess({
          accountId: account.id,
          expectedRevision: account.revision,
          // A bot-only edit on an older gateway must carry its existing worker access.
          ...(account.allProjects === undefined && { allWorkers: account.allWorkers, workerIds: account.workerIds }),
          allBots: account.allBots,
          botIds: account.botIds,
          ...patch,
        }),
      )
      .then(onChanged);

  const projectOptions = projects
    .filter((project) => !project.nodeId && !project.archivedAt && project.kind !== "scratch")
    .map(({ id, name }) => ({ id, name }));

  const bots = (list.data?.bots ?? [])
    .filter((bot) => !bot.archived)
    .map((bot) => ({ id: bot.id, name: bot.configuration?.name || "Bot" }));

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="Access" description="Choose who can use this account.">
        {threadsEnabled &&
          (account.allProjects === undefined ? (
            <Notice>Update the gateway to manage project access.</Notice>
          ) : (
            <SettingAccess
              title="Projects"
              description="Each thread in a selected project can use this account within its permission mode."
              options={projectOptions}
              all={account.allProjects}
              ids={account.projectIds}
              disabled={resource.busy || !loaded}
              onChange={(next) => change({ allProjects: next.all, projectIds: [...next.ids] })}
            />
          ))}
        {botsEnabled && (
          <SettingAccess
            title="Bots"
            options={bots}
            all={account.allBots}
            ids={account.botIds}
            disabled={resource.busy || !list.loaded || !!list.error}
            onChange={(next) => change({ allBots: next.all, botIds: [...next.ids] })}
          />
        )}
      </SettingsGroup>
    </ResourceState>
  );
}
