import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { Button, Field, Sheet } from "../../ui/components";
import { SettingsGroup, SettingToggle } from "./SettingsGroup";
import { SettingsInput } from "./SettingsInput";
import { ResourceState, useSettingsResource } from "./resource";

export function ProviderModels({ instance, onChanged }: { instance: ui.ProviderInstance; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const resource = useSettingsResource(`models:${instance.harness}/${instance.id}`, (api) =>
    api.listModels({ unfiltered: true }),
  );

  const [draft, setDraft] = useState<ui.InstanceModels>();
  const models = draft ?? instance.models ?? create(ui.InstanceModelsSchema);

  const save = async (patch: Partial<ui.InstanceModels>) => {
    const next = create(ui.InstanceModelsSchema, { ...models, ...patch });

    const result = await resource.run((api) =>
      api.setInstanceModels({ harness: instance.harness, id: instance.id, models: next }),
    );

    if (result) setDraft(result.instance?.models);
    onChanged();

    return !!result;
  };

  const toggle = (key: "favorites" | "hidden" | "shown", id: string, enabled: boolean) =>
    void save({ [key]: enabled ? [...models[key], id] : models[key].filter((m) => m !== id) });

  const catalog = [
    ...new Set([
      ...(resource.data?.workers.flatMap((w) =>
        w.profiles
          .filter(
            (p) => p.provider === instance.harness && p.profileId === (instance.id === "native" ? "" : instance.id),
          )
          .flatMap((p) => p.models.map((m) => m.id)),
      ) ?? []),
      ...models.custom,
    ]),
  ];

  const listed = catalog.length ? catalog : resource.initialLoading ? [" "] : [];

  return (
    <>
      <Button title="Manage models" onPress={() => setOpen(true)} />
      <Sheet title="Models" visible={open} onClose={() => setOpen(false)}>
        <ResourceState resource={resource}>
          <Field label="Search models" value={query} onChangeText={setQuery} />
          <SettingsInput
            title="Custom model IDs"
            description="One model ID per line."
            value={models.custom.join("\n")}
            multiline
            onSave={(value) =>
              save({
                custom: value
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            }
          />
          {listed.flatMap((id) =>
            id.toLowerCase().includes(query.toLowerCase())
              ? [
                  <SettingsGroup key={id} title={id}>
                    <SettingToggle
                      title="Favorite"
                      value={models.favorites.includes(id)}
                      disabled={resource.busy}
                      onChange={(value) => toggle("favorites", id, value)}
                    />
                    <SettingToggle
                      title="Hidden"
                      value={models.hidden.includes(id)}
                      disabled={resource.busy}
                      onChange={(value) => toggle("hidden", id, value)}
                    />
                    <SettingToggle
                      title="Show provider-hidden model"
                      value={models.shown.includes(id)}
                      disabled={resource.busy}
                      onChange={(value) => toggle("shown", id, value)}
                    />
                  </SettingsGroup>,
                ]
              : [],
          )}
        </ResourceState>
      </Sheet>
    </>
  );
}
