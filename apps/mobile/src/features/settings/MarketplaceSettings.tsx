import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { pluginComponents } from "@canopy/domain/plugin-components";
import { Button, EmptyState, Field, Notice, Sheet } from "../../ui/components";
import { SettingChoice, SettingToggle, SettingsGroup, SettingsRow } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { EnvironmentFiles } from "./EnvironmentFiles";
import { EnvironmentDestinations } from "./EnvironmentAssignment";
import { EnvironmentWizard } from "./EnvironmentWizard";

export function MarketplaceSettings({
  snapshot,
  onChanged,
}: {
  snapshot: ui.AgentEnvironmentSnapshot;
  onChanged: () => void;
}) {
  const resource = useSettingsResource("marketplaces", (api) => api.getAgentEnvironment({}));
  const [adding, setAdding] = useState<ui.EnvironmentMarketplace | "new">();
  const [plugin, setPlugin] = useState<{ market: ui.EnvironmentMarketplace; candidate: ui.MarketplacePlugin }>();

  return (
    <ResourceState resource={resource}>
      <Button variant="primary" title="Add marketplace" onPress={() => setAdding("new")} />
      {!snapshot.marketplaces.length && (
        <EmptyState title="No marketplaces yet" description="Add a repository to review its plugins." />
      )}
      {snapshot.marketplaces.map((market) => (
        <SettingsGroup key={market.id} title={market.name} description={market.source?.url}>
          <SettingsValue title="Catalog commit" value={market.source?.commit} />
          <Button title="Check upstream" onPress={() => setAdding(market)} />
          {market.plugins.map((candidate) => (
            <SettingsRow
              key={candidate.artifact?.name}
              title={candidate.artifact?.name || "Plugin"}
              description={candidate.unavailableReason || candidate.harnesses.join(" · ")}
            >
              <Button
                title="Review plugin"
                disabled={!!candidate.unavailableReason}
                onPress={() => setPlugin({ market, candidate })}
              />
            </SettingsRow>
          ))}
          {snapshot.plugins
            .filter(
              (p) =>
                p.marketplaceId === market.id &&
                !market.plugins.some((c) => c.artifact?.name === p.assignment?.artifact?.name),
            )
            .map((p) => (
              <SettingsRow
                key={p.assignment?.id}
                title={p.assignment?.name || "Saved plugin"}
                description="No longer in the catalog. The approved version remains available."
              >
                <Button
                  title="Edit plugin"
                  onPress={() =>
                    setPlugin({
                      market,
                      candidate: create(ui.MarketplacePluginSchema, {
                        artifact: p.assignment?.artifact,
                        harnesses: p.assignment?.harnesses,
                      }),
                    })
                  }
                />
              </SettingsRow>
            ))}
          <Button
            variant="danger"
            title="Delete marketplace"
            busy={resource.busy}
            onPress={() =>
              confirmAction(
                "Delete marketplace",
                "Approved plugins keep their saved versions.",
                () =>
                  void resource
                    .run((api) => api.deleteMarketplace({ id: market.id, expectedRevision: snapshot.revision }))
                    .then((r) => {
                      if (r) onChanged();
                    }),
              )
            }
          />
        </SettingsGroup>
      ))}
      <Sheet
        title={adding === "new" ? "Add marketplace" : "Check upstream"}
        visible={!!adding}
        onClose={() => setAdding(undefined)}
      >
        {adding && (
          <MarketplaceImport
            market={adding === "new" ? undefined : adding}
            revision={snapshot.revision}
            onSaved={() => {
              setAdding(undefined);
              onChanged();
            }}
          />
        )}
      </Sheet>
      <Sheet title="Review plugin" visible={!!plugin} onClose={() => setPlugin(undefined)}>
        {plugin && (
          <PluginEditor
            {...plugin}
            snapshot={snapshot}
            onSaved={() => {
              setPlugin(undefined);
              onChanged();
            }}
          />
        )}
      </Sheet>
    </ResourceState>
  );
}

function MarketplaceImport({
  market,
  revision,
  onSaved,
}: {
  market?: ui.EnvironmentMarketplace;
  revision: bigint;
  onSaved: () => void;
}) {
  const resource = useSettingsResource("marketplace-import", (api) => api.listConnectors({}));
  const [command, setCommand] = useState(market?.source?.url ?? "");
  const [account, setAccount] = useState(market?.source?.credentialAccountId ?? "");
  const [preview, setPreview] = useState<ui.MarketplacePreview>();

  return (
    <ResourceState resource={resource}>
      <Field
        label="Repository or marketplace command"
        value={command}
        onChangeText={setCommand}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!market}
      />
      <SettingChoice
        title="Source access"
        value={account}
        onChange={setAccount}
        options={[
          { value: "", label: "Public repository" },
          ...(resource.data?.accounts.map((a) => ({ value: a.id, label: a.name })) ?? []),
        ]}
      />
      <Button
        variant={preview ? "secondary" : "primary"}
        title="Preview marketplace"
        busy={resource.busy}
        onPress={() => {
          setPreview(undefined);
          void resource
            .run((api) => api.previewMarketplace({ command, credentialAccountId: account, id: market?.id ?? "" }))
            .then((r) => {
              if (r) setPreview(r);
            });
        }}
      />
      {preview && (
        <>
          <SettingsValue
            title={preview.marketplace?.name || "Marketplace"}
            value={preview.marketplace?.source?.commit}
          />
          {preview.marketplace?.plugins.map((p) => (
            <SettingsValue
              key={p.artifact?.name}
              title={p.artifact?.name || "Plugin"}
              value={p.unavailableReason || p.harnesses.join(" · ")}
            />
          ))}
          <Notice>Saving the catalog keeps enabled plugins on their approved versions.</Notice>
          <Button
            variant="primary"
            title={market ? "Save updated catalog" : "Save marketplace"}
            busy={resource.busy}
            onPress={() =>
              void resource
                .run((api) => api.saveMarketplace({ previewId: preview.id, expectedRevision: revision }))
                .then((r) => {
                  if (r) onSaved();
                })
            }
          />
        </>
      )}
    </ResourceState>
  );
}

function PluginEditor({
  market,
  candidate,
  snapshot,
  onSaved,
}: {
  market: ui.EnvironmentMarketplace;
  candidate: ui.MarketplacePlugin;
  snapshot: ui.AgentEnvironmentSnapshot;
  onSaved: () => void;
}) {
  const previous = snapshot.plugins.find(
    (p) => p.marketplaceId === market.id && p.assignment?.artifact?.name === candidate.artifact?.name,
  );

  const resource = useSettingsResource("plugin-editor", (api) => api.getAgentEnvironment({}));

  const [assignment, setAssignment] = useState(() =>
    create(
      ui.LibrarySkillSchema,
      previous?.assignment ?? {
        name: candidate.artifact?.name,
        harnesses: candidate.harnesses,
        platformHome: true,
        selector: { everyone: true },
      },
    ),
  );

  const [latest, setLatest] = useState(!previous);
  const [confirmed, setConfirmed] = useState(false);
  const artifact = latest ? candidate.artifact : previous?.assignment?.artifact;

  const remove = () => {
    const id = previous?.assignment?.id;

    if (!id) return;
    confirmAction(
      "Delete plugin",
      "This removes its assignment. Local edits stay available for review.",
      () =>
        void resource
          .run((api) => api.deleteLibraryPlugin({ id, expectedRevision: snapshot.revision }))
          .then((r) => {
            if (r) onSaved();
          }),
    );
  };

  return (
    <ResourceState resource={resource}>
      <EnvironmentWizard
        steps={["Review code", "Assign computers", "Confirm version"]}
        title="Approve and save plugin"
        busy={resource.busy}
        disabled={!confirmed || !artifact || !assignment.name.trim()}
        onSave={() =>
          void resource
            .run((api) =>
              api.saveLibraryPlugin({
                marketplaceId: market.id,
                pluginName: `${candidate.artifact?.name}@${market.name}`,
                assignment,
                confirmedChecksum: artifact?.checksum ?? "",
                useLatest: latest,
                expectedRevision: snapshot.revision,
              }),
            )
            .then((r) => {
              if (r) onSaved();
            })
        }
      >
        {(step) =>
          step === 0 ? (
            <>
              <Notice>
                Plugins can execute code with the agent’s permissions. Review manifests, hooks, MCP definitions and
                scripts before enabling this version.
              </Notice>
              {previous && candidate.artifact?.checksum !== previous.assignment?.artifact?.checksum && (
                <SettingToggle
                  title="Apply the marketplace update"
                  value={latest}
                  onChange={(v) => {
                    setLatest(v);
                    setConfirmed(false);
                  }}
                />
              )}
              <SettingsValue title="Components" value={artifact ? pluginComponents(artifact.files).join(" · ") : ""} />
              <EnvironmentFiles artifact={artifact} before={latest ? previous?.assignment?.artifact : undefined} />
            </>
          ) : step === 1 ? (
            <>
              <Field
                label="Library name"
                value={assignment.name}
                onChangeText={(name) => setAssignment(create(ui.LibrarySkillSchema, { ...assignment, name }))}
              />
              <EnvironmentDestinations
                value={assignment}
                workers={snapshot.workers}
                onChange={(v) => {
                  setAssignment(v);
                  setConfirmed(false);
                }}
              />
            </>
          ) : (
            <>
              <SettingsValue title="SHA-256" value={artifact?.checksum} />
              <SettingToggle
                title="I reviewed this version and allow its components to execute on assigned computers"
                description="This confirmation is recorded with the exact checksum and commit."
                value={confirmed}
                onChange={setConfirmed}
              />
            </>
          )
        }
      </EnvironmentWizard>
      {previous?.assignment && <Button variant="danger" title="Delete plugin" busy={resource.busy} onPress={remove} />}
    </ResourceState>
  );
}
