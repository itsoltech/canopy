import { useState } from "react";
import type { github } from "@canopy/contracts";
import { Button, Notice, Sheet } from "../../ui/components";
import { ConnectorForm } from "./ConnectorForm";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { SettingsActions, SettingsGroup } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";

export function GitHubAdvancedConnections({
  local,
  candidates,
  busy,
  onUse,
  onChanged,
}: {
  local: boolean;
  candidates: github.GitHubPatCandidate[];
  busy: boolean;
  onUse: (connectorAccountId: string) => void;
  onChanged: () => void;
}) {
  return (
    <SettingsDisclosure title="Advanced connections">
      {candidates.length > 0 && (
        <SettingsGroup
          title="Use an existing personal access token"
          description="Canopy checks the GitHub identity of the tool account you choose."
        >
          <SettingsActions>
            {candidates.map((pat) => (
              <Button
                key={pat.connectorAccountId}
                title={`Use ${pat.name}`}
                multiline
                disabled={busy}
                onPress={() => onUse(pat.connectorAccountId)}
              />
            ))}
          </SettingsActions>
        </SettingsGroup>
      )}
      {local ? (
        <AdvancedMcpAccount onChanged={onChanged} />
      ) : (
        <Notice>Open GitHub settings on the selected computer to add a personal access token or MCP account.</Notice>
      )}
    </SettingsDisclosure>
  );
}

const mcpActions = [
  { id: "github", title: "Connect GitHub MCP" },
  { id: "custom", title: "Connect custom MCP server" },
] as const;

function AdvancedMcpAccount({ onChanged }: { onChanged: () => void }) {
  const [selected, setSelected] = useState<(typeof mcpActions)[number]>();
  const [notice, setNotice] = useState("");
  const resource = useSettingsResource("ListConnectors", (api) => api.listConnectors({}), !!selected);
  const type = resource.data?.types.find((entry) => entry.id === selected?.id);

  return (
    <>
      {!!notice && <Notice>{notice}</Notice>}
      <SettingsGroup description="Use a personal access token or your own OAuth app for GitHub’s MCP server.">
        <SettingsActions>
          {mcpActions.map((action) => (
            <Button
              key={action.id}
              title={action.title}
              onPress={() => {
                setNotice("");
                setSelected(action);
              }}
            />
          ))}
        </SettingsActions>
      </SettingsGroup>
      {selected && (
        <Sheet title={selected.title} visible onClose={() => setSelected(undefined)}>
          <ResourceState resource={resource}>
            {type ? (
              <ConnectorForm
                type={type}
                onSaved={(alreadyConnected) => {
                  setSelected(undefined);
                  setNotice(alreadyConnected ? "Already connected." : "MCP account connected.");
                  onChanged();
                }}
              />
            ) : resource.initialLoading ? (
              <Notice>Loading account options…</Notice>
            ) : resource.data ? (
              <Notice>This connector is unavailable on this computer. Choose another connection.</Notice>
            ) : null}
          </ResourceState>
        </Sheet>
      )}
    </>
  );
}
