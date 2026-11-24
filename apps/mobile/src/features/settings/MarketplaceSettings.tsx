import { useState } from "react";
import { View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { pluginComponents, pluginHarnesses } from "@canopy/domain/plugin-components";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { SettingToggle, SettingsGroupHeader } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { useSourcePreview } from "./source-preview";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { EnvironmentFiles } from "./EnvironmentFiles";
import { EnvironmentDestinations } from "./EnvironmentAssignment";
import { EnvironmentWizard } from "./EnvironmentWizard";
import { EnvironmentPluginRow } from "./EnvironmentPluginRow";
import { EnvironmentActionMenu } from "./EnvironmentActionMenu";
import { EnvironmentRow, EnvironmentRows } from "./EnvironmentRows";

export function MarketplaceSettings({
  snapshot,
  workers,
  onChanged,
}: {
  snapshot: ui.AgentEnvironmentSnapshot;
  workers: ui.EnvironmentWorker[];
  onChanged: () => void;
}) {
  const resource = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));
  const [adding, setAdding] = useState<ui.EnvironmentMarketplace | "new">();
  const [plugin, setPlugin] = useState<{ market: ui.EnvironmentMarketplace; candidate: ui.MarketplacePlugin }>();

  function remove(market: ui.EnvironmentMarketplace) {
    confirmAction(
      "Delete marketplace",
      "Approved plugins keep their saved versions.",
      () =>
        void resource
          .run((api) => api.deleteMarketplace({ id: market.id, expectedRevision: snapshot.revision }))
          .then((r) => {
            if (r) onChanged();
          }),
    );
  }

  return (
    <ResourceState resource={resource} gap={12}>
      <View style={{ gap: 4 }}>
        <View style={{ alignItems: "flex-end" }}>
          <Button title="Add marketplace" variant="text" size="sm" icon="plus" onPress={() => setAdding("new")} />
        </View>
        {!snapshot.marketplaces.length && (
          <EnvironmentRows>
            <EnvironmentRow
              title="No marketplaces yet"
              description="Add a repository to review its plugins."
              wrapDescription
            />
          </EnvironmentRows>
        )}
        {snapshot.marketplaces.map((market) => (
          <MarketplaceCatalog
            key={market.id}
            market={market}
            plugins={snapshot.plugins.filter((p) => p.marketplaceId === market.id)}
            workers={workers}
            busy={resource.busy}
            onRefresh={() => setAdding(market)}
            onDelete={() => remove(market)}
            onReview={(candidate) => setPlugin({ market, candidate })}
          />
        ))}
      </View>
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

function MarketplaceCatalog({
  market,
  plugins,
  workers,
  busy,
  onRefresh,
  onDelete,
  onReview,
}: {
  market: ui.EnvironmentMarketplace;
  plugins: ui.AgentEnvironmentSnapshot["plugins"];
  workers: ui.EnvironmentWorker[];
  busy: boolean;
  onRefresh: () => void;
  onDelete: () => void;
  onReview: (candidate: ui.MarketplacePlugin) => void;
}) {
  const candidates = market.plugins;

  const missing = plugins.filter(
    (plugin) => !candidates.some((c) => c.artifact?.name === plugin.assignment?.artifact?.name),
  );

  const reviewCount = candidates.filter(
    (candidate) =>
      !candidate.unavailableReason &&
      !plugins.some((plugin) => plugin.assignment?.artifact?.name === candidate.artifact?.name),
  ).length;

  return (
    <View style={{ gap: 4 }}>
      <SettingsGroupHeader
        title={market.name}
        description={reviewCount ? `${reviewCount} to review` : undefined}
        actions={
          <EnvironmentActionMenu
            title={market.name}
            label={`Actions for ${market.name}`}
            note={[market.source?.url, market.source?.ref, market.source?.commit].filter(Boolean).join("\n")}
            disabled={busy}
            actions={[
              { label: "Check upstream", icon: "arrow-path", onPress: onRefresh },
              { label: "Delete marketplace", icon: "trash", tone: "danger", onPress: onDelete },
            ]}
          />
        }
      />
      {!!(candidates.length || missing.length) && (
        <EnvironmentRows>
          {candidates.map((candidate) => (
            <EnvironmentPluginRow
              key={candidate.artifact?.name}
              candidate={candidate}
              workers={workers}
              assignment={plugins.find((p) => p.assignment?.artifact?.name === candidate.artifact?.name)?.assignment}
              onReview={() => onReview(candidate)}
            />
          ))}
          {missing.map(({ assignment }) => {
            const candidate = create(ui.MarketplacePluginSchema, {
              artifact: assignment?.artifact,
              harnesses: assignment?.harnesses,
            });

            return (
              <EnvironmentPluginRow
                key={assignment?.id}
                candidate={candidate}
                assignment={assignment}
                workers={workers}
                missing
                onReview={() => onReview(candidate)}
              />
            );
          })}
        </EnvironmentRows>
      )}
    </View>
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
  const { resource, request, fields, preview, setPreview } = useSourcePreview<ui.MarketplacePreview>(
    "marketplace",
    market,
  );

  return (
    <ResourceState resource={resource}>
      {fields}
      <Button
        variant={preview ? "secondary" : "primary"}
        title="Preview marketplace"
        busy={resource.busy}
        onPress={() => {
          setPreview(undefined);
          void resource
            .run((api) => api.previewMarketplace(market ? { id: market.id } : request))
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
              value={p.unavailableReason || p.harnesses.filter(Boolean).join(" · ")}
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

interface PluginEditorProps {
  market: ui.EnvironmentMarketplace;
  candidate: ui.MarketplacePlugin;
  snapshot: ui.AgentEnvironmentSnapshot;
  onSaved: () => void;
}

function PluginEditor({ market, candidate, snapshot, onSaved }: PluginEditorProps) {
  const previous = snapshot.plugins.find(
    (p) => p.marketplaceId === market.id && p.assignment?.artifact?.name === candidate.artifact?.name,
  );

  const resource = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));

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
                harnesses={pluginHarnesses(artifact?.files ?? [])}
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
