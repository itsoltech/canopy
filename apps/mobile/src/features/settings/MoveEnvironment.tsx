import { useState } from "react";
import { Provider, ProviderProfileKind, type ui } from "@canopy/contracts";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { providerName } from "../models/catalog";
import { ResourceState, useSettingsResource } from "./resource";

export function MoveEnvironment({ instance, onSaved }: { instance: ui.ProviderInstance; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(`${providerName(instance.harness)} proxy`);

  const resource = useSettingsResource(`move-proxy:${instance.harness}:${instance.id}`, (api) =>
    api.listProviderInstances({}),
  );

  const names = new Set(instance.env.map((entry) => entry.name.toUpperCase()));

  const detected =
    instance.kind === ProviderProfileKind.NATIVE &&
    (instance.harness === Provider.CLAUDE
      ? names.has("ANTHROPIC_BASE_URL") && (names.has("ANTHROPIC_AUTH_TOKEN") || names.has("ANTHROPIC_API_KEY"))
      : (names.has("OPENAI_BASE_URL") || names.has("CODEX_BASE_URL")) &&
        (names.has("OPENAI_API_KEY") || names.has("CLIPROXY_API_KEY")));

  if (!detected) return null;

  return (
    <>
      <Button title="Move to a proxy" onPress={() => setOpen(true)} />
      <Sheet
        title="Move to a proxy"
        visible={open}
        onClose={() => {
          if (!resource.busy) setOpen(false);
        }}
      >
        <ResourceState resource={resource}>
          <Notice>
            The gateway moves the saved URL and secret into a reusable proxy. Existing sessions stay available.
          </Notice>
          <Field label="Proxy and instance name" value={name} onChangeText={setName} editable={!resource.busy} />
          <Button
            title="Move to a proxy"
            variant="primary"
            busy={resource.busy}
            disabled={!name.trim()}
            onPress={() => {
              const current = resource.data?.instances.find(
                (row) => row.harness === instance.harness && row.id === instance.id,
              );

              if (!current) return;
              void resource
                .run((api) =>
                  api.moveInstanceToProxy({
                    harness: current.harness,
                    id: current.id,
                    expectedRevision: current.revision,
                    name: name.trim(),
                  }),
                )
                .then((result) => {
                  if (result) {
                    setOpen(false);
                    onSaved();
                  }
                });
            }}
          />
        </ResourceState>
      </Sheet>
    </>
  );
}
