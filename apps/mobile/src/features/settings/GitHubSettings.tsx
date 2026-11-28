import { useEffect, useRef, useState, type ComponentRef } from "react";
import { useLocalSearchParams } from "expo-router";
import { AppState } from "react-native";
import { GITHUB_ACCOUNTS, GITHUB_AGENT_ACCESS, GITHUB_HOME, qualifyId } from "@canopy/domain/computers";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { GitHubAgentAccess, type AgentAccessTarget } from "../github/GitHubAgentAccess";
import { GitHubAdvancedConnections } from "./GitHubAdvancedConnections";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingChoice, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ConnectGitHub } from "../github/ConnectGitHub";
import { GitHubAccount } from "../github/GitHubAccount";

import { SettingsSkeletonGroups } from "./SettingsSkeleton";
import { SettingsTopics } from "./SettingsTopics";
import { createSettingsViewState } from "./SettingsScroll";

const useGitHubHome = createSettingsViewState("");

export function GitHubSettings() {
  const { computers } = useOverview();
  const [homeId, setHomeId] = useGitHubHome();
  const home = computers.find((computer) => qualifyId(GITHUB_HOME, computer.nodeId) === homeId);

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
      <GitHubHome
        key={homeId}
        homeId={homeId}
        agentAccessHome={!homeId || !!home?.capabilities.includes(GITHUB_AGENT_ACCESS)}
      />
    </>
  );
}

function GitHubHome({ homeId, agentAccessHome }: { homeId: string; agentAccessHome: boolean }) {
  const { session } = useSession();
  const { topic } = useLocalSearchParams<{ topic?: string }>();
  const topics = useRef<ComponentRef<typeof SettingsTopics>>(null);
  const resource = useSettingsResource(`ListGitHubAccounts:${homeId}`, (api) => api.listGitHubAccounts({ homeId }));
  const capabilities = useSettingsResource("GetClientCapabilities", (api) => api.getClientCapabilities({}));
  const agentAccess = agentAccessHome && capabilities.data?.methods.includes("SetGitHubAgentAccess");
  const [editing, setEditing] = useState<{ target: AgentAccessTarget; removeOnly: boolean }>();
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
          defaultTopic={topic}
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
                      onAccess={
                        agentAccess ? (target, removeOnly = false) => setEditing({ target, removeOnly }) : undefined
                      }
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
                  <GitHubAdvancedConnections
                    local={!homeId}
                    candidates={data.patCandidates}
                    busy={resource.busy}
                    onChanged={() => void reload()}
                    onUse={async (connectorAccountId) => {
                      if (await resource.run((api) => api.useGitHubPat({ homeId, connectorAccountId })))
                        topics.current?.selectTopic("accounts");
                    }}
                  />
                  {!data.accounts.length && <SettingsRow title="No GitHub accounts connected on this computer" />}
                </>
              ),
            },
          ]}
        />
      )}
      {editing && (
        <GitHubAgentAccess
          target={editing.target}
          removeOnly={editing.removeOnly}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing((current) => (current === editing ? undefined : current));
            void reload();
          }}
        />
      )}
    </ResourceState>
  );
}
