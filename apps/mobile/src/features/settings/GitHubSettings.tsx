import { useEffect, useRef, type ComponentRef } from "react";
import { AppState } from "react-native";
import { GITHUB_ACCOUNTS, GITHUB_HOME, qualifyId } from "@canopy/domain/computers";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { Button } from "../../ui/components";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingChoice, SettingsActions, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ConnectGitHub } from "../github/ConnectGitHub";
import { GitHubAccount } from "../github/GitHubAccount";

import { SettingsSkeletonGroups } from "./SettingsSkeleton";
import { SettingsTopics } from "./SettingsTopics";
import { createSettingsViewState } from "./SettingsScroll";

const useGitHubHome = createSettingsViewState("");

export function GitHubSettings() {
  const { computers } = useOverview();
  const [homeId, setHomeId] = useGitHubHome();

  const homes = [
    { value: "", label: "This computer" },
    ...computers
      .filter((c) => !c.viaNodeId)
      .map((c) => ({
        value: qualifyId(GITHUB_HOME, c.nodeId),
        label: c.displayName || c.name,
        disabled: c.status !== "connected" || !c.capabilities.includes(GITHUB_ACCOUNTS),
      })),
  ];

  return (
    <>
      {(homes.length > 1 || !!homeId) && (
        <SettingsGroup>
          <SettingChoice
            title="Store accounts on"
            description="Accounts and tokens stay on the selected computer. It must be online to connect or refresh access."
            value={homeId}
            onChange={setHomeId}
            options={homes}
          />
        </SettingsGroup>
      )}
      <GitHubHome key={homeId} homeId={homeId} />
    </>
  );
}

function GitHubHome({ homeId }: { homeId: string }) {
  const { session } = useSession();
  const topics = useRef<ComponentRef<typeof SettingsTopics>>(null);
  const resource = useSettingsResource(`ListGitHubAccounts:${homeId}`, (api) => api.listGitHubAccounts({ homeId }));
  const data = resource.data;
  const reload = resource.reload;
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void reload();
    });

    return () => listener.remove();
  }, [reload]);

  return (
    <ResourceState resource={resource}>
      {resource.initialLoading && <SettingsSkeletonGroups titles={["GitHub"]} />}
      {data && (
        <SettingsTopics
          scopeKey={homeId}
          ref={topics}
          topics={[
            {
              id: "accounts",
              label: "Accounts and access",
              hidden: !data.accounts.length,
              content: (
                <SettingsGroup title="Your accounts">
                  {data.accounts.map((account) => (
                    <GitHubAccount
                      key={`${homeId}:${account.id}:${account.revision}`}
                      account={account}
                      installUrl={data.installUrl}
                      onchanged={() => void reload()}
                    />
                  ))}
                </SettingsGroup>
              ),
            },
            {
              id: "connect",
              label: "Connect account",
              content: (
                <>
                  <SettingsGroup description="Connect accounts and choose which repositories Canopy can access.">
                    <ConnectGitHub
                      key={`${session?.deviceId}:${homeId}`}
                      homeId={homeId}
                      configured={data.configured}
                      hasAccounts={data.accounts.length > 0}
                      onconnected={(justConnected) => {
                        void reload();

                        if (justConnected) topics.current?.selectTopic("accounts");
                      }}
                    />
                  </SettingsGroup>
                  {!!data.patCandidates.length && (
                    <SettingsGroup
                      title="Use an existing personal access token"
                      description="Choose a GitHub account from Connectors explicitly. Canopy checks its GitHub identity before using it."
                    >
                      <SettingsActions>
                        {data.patCandidates.map((pat) => (
                          <Button
                            key={pat.connectorAccountId}
                            title={`Use ${pat.name}`}
                            disabled={resource.busy}
                            onPress={async () => {
                              if (
                                await resource.run((api) =>
                                  api.useGitHubPat({ homeId, connectorAccountId: pat.connectorAccountId }),
                                )
                              )
                                topics.current?.selectTopic("accounts");
                            }}
                          />
                        ))}
                      </SettingsActions>
                    </SettingsGroup>
                  )}
                  {!data.accounts.length && <SettingsRow title="No GitHub accounts connected on this computer" />}
                </>
              ),
            },
          ]}
        />
      )}
    </ResourceState>
  );
}
