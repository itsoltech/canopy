import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import { GITHUB_ACCOUNTS, GITHUB_HOME, qualifyId } from "@canopy/domain/computers";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { Button } from "../../ui/components";
import { ResourceState, useSettingsResource } from "./resource";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ConnectGitHub } from "../github/ConnectGitHub";
import { GitHubAccount } from "../github/GitHubAccount";

export function GitHubSettings() {
  const { computers } = useOverview();
  const { session } = useSession();
  const [homeId, setHomeId] = useState("");
  const [choosing, setChoosing] = useState(false);
  const resource = useSettingsResource(`ListGitHubAccounts:${homeId}`, (api) => api.listGitHubAccounts({ homeId }));

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

  const reload = resource.reload;
  useEffect(() => {
    const listener = AppState.addEventListener("change", (state) => {
      if (state === "active") void reload();
    });

    return () => listener.remove();
  }, [reload]);
  const data = resource.data;

  return (
    <ResourceState resource={resource}>
      <SettingsGroup title="GitHub" description="Connect accounts and choose which repositories Canopy can access.">
        {homes.length > 1 && (
          <View style={{ padding: 16, gap: 8 }}>
            <SelectField
              label="Store accounts on"
              value={homes.find((h) => h.value === homeId)?.label ?? "This computer"}
              onPress={() => setChoosing(true)}
            />
            <SettingsRow
              title="Accounts and tokens stay on the selected computer"
              description="It must be online to connect or refresh access."
            />
          </View>
        )}
        {data && (
          <View style={{ padding: 16 }}>
            <ConnectGitHub
              key={`${session?.deviceId}:${homeId}`}
              homeId={homeId}
              configured={data.configured}
              hasAccounts={data.accounts.length > 0}
              onconnected={() => void reload()}
            />
          </View>
        )}
      </SettingsGroup>
      {!!data?.patCandidates.length && (
        <SettingsGroup
          title="Use an existing personal access token"
          description="Choose a GitHub account from Connectors explicitly. Canopy checks its GitHub identity before using it."
        >
          <View style={{ padding: 16, gap: 8 }}>
            {data.patCandidates.map((pat) => (
              <Button
                key={pat.connectorAccountId}
                title={`Use ${pat.name}`}
                disabled={resource.busy}
                onPress={() =>
                  void resource.run((api) => api.useGitHubPat({ homeId, connectorAccountId: pat.connectorAccountId }))
                }
              />
            ))}
          </View>
        </SettingsGroup>
      )}
      {!!data?.accounts.length && (
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
      )}
      {data && !data.accounts.length && <SettingsRow title="No GitHub accounts connected on this computer" />}
      <PickerSheet
        title="Store accounts on"
        visible={choosing}
        value={homeId}
        sections={[{ title: "Computers", options: homes }]}
        onClose={() => setChoosing(false)}
        onSelect={(value) => {
          setHomeId(value);
          setChoosing(false);
        }}
      />
    </ResourceState>
  );
}
