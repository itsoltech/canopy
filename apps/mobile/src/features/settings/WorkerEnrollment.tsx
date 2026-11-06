import { useState } from "react";
import { View } from "react-native";
import { ui } from "@canopy/contracts";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { SettingChoice } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";
import { WorkerSsh } from "./WorkerSsh";
import { WorkerInstallCommands } from "./WorkerInstallCommands";

export function WorkerEnrollment({ setup, onClose }: { setup: ui.GetWorkerSetupResponse; onClose: () => void }) {
  const resource = useSettingsResource("enrollment", (api) => api.getWorkerSetup({}));
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [gateway, setGateway] = useState(setup.gatewayUrl);
  const [invitation, setInvitation] = useState<ui.CreateWorkerEnrollmentResponse>();
  const [method, setMethod] = useState("script");
  const active = resource.data?.enrollments.find((e) => e.id === invitation?.enrollment?.id) ?? invitation?.enrollment;

  async function generate() {
    const result = await resource.run(async (api) => {
      if (invitation?.enrollment && !active?.usedAt) await api.revokeWorkerEnrollment({ id: invitation.enrollment.id });

      return api.createWorkerEnrollment({
        name,
        tags: tags
          .split(/[\n,]/)
          .map((v) => v.trim())
          .filter(Boolean),
      });
    });

    if (result) setInvitation(result);
  }

  return (
    <Sheet title="Add worker" visible onClose={onClose}>
      <ResourceState resource={resource}>
        <Field label="Machine name" value={name} onChangeText={setName} editable={!invitation} maxLength={200} />
        <Field
          label="Worker tags"
          value={tags}
          onChangeText={setTags}
          editable={!invitation}
          placeholder="Optional, separated by commas"
        />
        <Field
          label="Gateway address"
          value={gateway}
          onChangeText={setGateway}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <SettingChoice
          title="Installation method"
          value={method}
          onChange={setMethod}
          options={[
            { value: "script", label: "Install script" },
            { value: "docker", label: "Docker" },
            { value: "manual", label: "Manual" },
            { value: "ssh", label: "Over SSH" },
          ]}
        />
        {method === "ssh" ? (
          <WorkerSsh
            name={name}
            tags={tags
              .split(/[\n,]/)
              .map((v) => v.trim())
              .filter(Boolean)}
          />
        ) : (
          <>
            <Button
              title={invitation ? "Generate new token" : "Generate enrollment token"}
              disabled={!name.trim() || !gateway.trim()}
              busy={resource.busy}
              onPress={() => void generate()}
            />
            {invitation && (
              <View style={{ gap: 16 }}>
                <Notice>
                  Keep enrollment commands private. The token works once. Install and sign in to your agent CLIs on this
                  machine.
                </Notice>
                <WorkerInstallCommands method={method} setup={setup} gateway={gateway} token={invitation.token} />
                <Button
                  secondary
                  title="Check connection"
                  busy={resource.loading}
                  onPress={() => void resource.reload()}
                />
                <SettingsValue
                  title="Connection"
                  value={active?.usedAt ? "Connected" : active?.revokedAt ? "Revoked" : "Waiting for enrollment"}
                />
                {active?.usedAt && <Button title="Finish" onPress={onClose} />}
              </View>
            )}
          </>
        )}
      </ResourceState>
    </Sheet>
  );
}
