import { useState } from "react";
import { View } from "react-native";
import { timestampMs } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { Button, Sheet } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ProjectSecretForm } from "./ProjectSecretForm";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";

type Open = { mode: "add" } | { mode: "edit"; name: string };

/**
 * Project details → Secrets: names and update times only, in memory (docs/mobile.md). Values are write only and
 * never come back from the gateway. A row opens its sheet: Replace value, or Delete from the project.
 */
export function ProjectSecrets({ projectId }: { projectId: string }) {
  const resource = useSettingsResource(`ListProjectSecrets:${projectId}`, (api) =>
    api.listProjectSecrets({ projectId }),
  );

  const { active } = useSession();
  const [open, setOpen] = useState<Open>();
  const [saving, setSaving] = useState(false);
  const secrets = (resource.data?.secrets ?? []).toSorted((a, b) => a.name.localeCompare(b.name));
  const names = secrets.map((secret) => secret.name);
  const close = () => !saving && setOpen(undefined);

  const remove = (name: string) =>
    confirmAction(
      "Delete secret",
      `This deletes “${name}” from this project. Canopy revokes it in threads that use it. Agents can no longer ask for it.`,
      () =>
        void resource
          .run((api) => api.deleteProjectSecret({ projectId, name }))
          .then((result) => {
            if (result) setOpen(undefined);
          }),
    );

  return (
    <ResourceState resource={resource}>
      <SettingsGroup
        title="Secrets"
        description="Agents in this project's threads can ask for these by name."
        actions={
          <Button
            title="Add secret"
            size="sm"
            icon="plus"
            disabled={!resource.data || resource.busy}
            onPress={() => setOpen({ mode: "add" })}
          />
        }
      >
        {secrets.map((secret) => (
          <SettingsRow
            key={secret.name}
            title={secret.name}
            description={updated(secret)}
            onPress={() => setOpen({ mode: "edit", name: secret.name })}
          />
        ))}
        {resource.data && !secrets.length && (
          <SettingsRow
            title="No secrets yet"
            description="Add one so agents can use it without seeing it in a thread."
          />
        )}
      </SettingsGroup>
      <Sheet
        title={open?.mode === "edit" ? open.name : "Add secret"}
        visible={!!open && active}
        scroll={false}
        onClose={close}
      >
        {/* Leaving the app unmounts the form, which clears an unsent value. */}
        {open && active && (
          <View style={{ gap: 16 }}>
            <ProjectSecretForm
              key={open.mode === "edit" ? open.name : "add"}
              projectId={projectId}
              name={open.mode === "edit" ? open.name : undefined}
              taken={names}
              onBusy={setSaving}
              onSaved={() => {
                setOpen(undefined);
                void resource.reload();
              }}
            />
            {open.mode === "edit" && (
              <Button
                title="Delete secret…"
                variant="danger"
                disabled={saving || resource.busy}
                onPress={() => remove(open.name)}
              />
            )}
          </View>
        )}
      </Sheet>
    </ResourceState>
  );
}

function updated(secret: ui.ProjectSecret): string | undefined {
  return secret.updatedAt ? `Updated ${new Date(timestampMs(secret.updatedAt)).toLocaleString()}` : undefined;
}
