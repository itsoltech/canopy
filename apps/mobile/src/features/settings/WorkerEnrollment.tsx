import { useState } from "react";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { useAppearance } from "../../state/appearance";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { SettingChoice, SettingsActions, SettingsGroup } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";
import { useTimeLabel } from "../../ui/time";
import { useForegroundInterval } from "../../ui/interval";
import { copyText } from "../viewers/useCopyText";
import { WorkerSsh } from "./WorkerSsh";
import { WorkerInstallCommands } from "./WorkerInstallCommands";
import { useOpenSettingsSection } from "./navigation";

function useEnrollment(setup: ui.GetWorkerSetupResponse) {
  const resource = useSettingsResource("GetWorkerSetup", (api) => api.getWorkerSetup({}));
  const settings = useAppearance();
  const overview = useOverview();
  const [name, setName] = useState("");
  const [tags, setTags] = useState("");
  const [gateway, setGateway] = useState(setup.gatewayUrl);
  const [invitation, setInvitation] = useState<ui.CreateWorkerEnrollmentResponse>();
  const [method, setMethod] = useState("script");
  const [step, setStep] = useState<"name" | "install" | "connect">("name");
  const [sshBusy, setSshBusy] = useState(false);
  const busy = resource.busy || sshBusy;
  const active = resource.data?.enrollments.find((e) => e.id === invitation?.enrollment?.id) ?? invitation?.enrollment;
  const worker = overview.workers.find((w) => active?.workerId && w.id === active.workerId);
  const expiration = Number(active?.expiresAt?.seconds ?? 0) * 1000;
  const expired = useTimeLabel((now) => (expiration && expiration <= now ? "expired" : ""), !!active && !active.usedAt);
  const usable = !!active && !active.usedAt && !active.revokedAt && !expired;
  useForegroundInterval(() => void resource.reload(), 3000, usable && !busy && !resource.loading);

  const manualTags = tags
    .split(/[\n,]/)
    .map((v) => v.trim())
    .filter(Boolean);

  async function prepare() {
    const result = await resource.run(async (api) => {
      let address = gateway.trim();

      if (!setup.gatewayUrl) {
        await api.updateNetworkAccess({ action: "set_enabled", enabled: true });
        address ||= (await api.getWorkerSetup({})).gatewayUrl;
      }

      if (!address) throw new Error("Gateway address unavailable");

      if (
        address !== setup.gatewayUrl &&
        address === gateway.trim() &&
        !(await settings.update({ workerGatewayUrl: address }))
      )
        throw new Error("Could not save gateway address");

      if (active && !active.usedAt && !active.revokedAt) await api.revokeWorkerEnrollment({ id: active.id });

      const next =
        method === "ssh" ? undefined : await api.createWorkerEnrollment({ name: name.trim(), tags: manualTags });

      return { address, invitation: next };
    });

    if (result) {
      setGateway(result.address);
      setInvitation(result.invitation);
      setStep("install");
    }
  }

  return {
    resource,
    settings,
    setup,
    name,
    setName,
    tags,
    setTags,
    gateway,
    setGateway,
    invitation,
    setInvitation,
    method,
    setMethod,
    step,
    setStep,
    setSshBusy,
    busy,
    active,
    worker,
    usable,
    manualTags,
    prepare,
  };
}

type Enrollment = ReturnType<typeof useEnrollment>;

export function WorkerEnrollment({ setup, onClose }: { setup: ui.GetWorkerSetupResponse; onClose: () => void }) {
  const openSettingsSection = useOpenSettingsSection();
  const enrollment = useEnrollment(setup);

  const {
    resource,
    name,
    gateway,
    invitation,
    setInvitation,
    method,
    step,
    setStep,
    setSshBusy,
    busy,
    active,
    worker,
    usable,
    manualTags,
    prepare,
  } = enrollment;

  return (
    <Sheet title="Add worker" visible onClose={() => !busy && onClose()}>
      <ResourceState resource={resource}>
        {step === "name" ? (
          <EnrollmentName enrollment={enrollment} />
        ) : step === "install" ? (
          <>
            {method === "ssh" ? (
              <WorkerSsh
                name={name}
                tags={manualTags}
                onBusy={setSshBusy}
                onEnrollment={(enrollment) =>
                  setInvitation(create(ui.CreateWorkerEnrollmentResponseSchema, { enrollment }))
                }
                onInstalled={() => setStep("connect")}
              />
            ) : (
              <>
                <WorkerInstallCommands method={method} setup={setup} gateway={gateway} name={name} />
                {invitation?.token && usable ? (
                  <>
                    <SettingsValue
                      title="Enrollment token"
                      description="Paste the token when the terminal prompts you. The token works once."
                      value={invitation.token}
                    />
                    <Button size="sm" title="Copy enrollment token" onPress={() => void copyText(invitation.token)} />
                  </>
                ) : null}
              </>
            )}
            <SettingsActions>
              <Button title="Back" disabled={busy} onPress={() => setStep("name")} />
              {method !== "ssh" && (
                <Button
                  variant="primary"
                  title="Check connection"
                  disabled={busy || !active}
                  onPress={() => {
                    setStep("connect");
                    void resource.reload();
                  }}
                />
              )}
            </SettingsActions>
          </>
        ) : (
          <>
            <SettingsValue
              title={name}
              value={
                worker?.online
                  ? "Connected"
                  : active?.usedAt
                    ? "Enrolled · waiting for the worker to connect"
                    : usable
                      ? "Waiting for enrollment"
                      : "Token unavailable"
              }
            />
            <SettingsActions>
              <Button title="Show installation" onPress={() => setStep("install")} />
              {worker?.online && (
                <Button
                  title="Choose providers"
                  variant="primary"
                  onPress={() => {
                    onClose();
                    openSettingsSection("providers", { worker: worker.id });
                  }}
                />
              )}
            </SettingsActions>
            {worker?.online && <Button title="Finish" onPress={onClose} />}
          </>
        )}
        {step !== "name" && method !== "ssh" && !active?.usedAt && (
          <>
            {!usable && <Notice>The token expired or was revoked. Generate a new token to enroll this worker.</Notice>}
            <Button title="Generate new token" busy={busy} onPress={() => void prepare()} />
          </>
        )}
      </ResourceState>
    </Sheet>
  );
}

function EnrollmentName({ enrollment }: { enrollment: Enrollment }) {
  const { setup, settings, name, setName, tags, setTags, gateway, setGateway, method, setMethod, busy, prepare } =
    enrollment;

  return (
    <SettingsGroup title="Name your machine">
      <Field label="Machine name" value={name} onChangeText={setName} editable={!busy} maxLength={200} />
      <Field
        label="Worker tags"
        value={tags}
        onChangeText={setTags}
        editable={!busy}
        placeholder="Optional, separated by commas"
      />
      <Field
        label="Gateway address for workers"
        value={gateway}
        onChangeText={setGateway}
        editable={!busy}
        placeholder="Chosen automatically when network access is on"
        autoCapitalize="none"
        autoCorrect={false}
      />
      <SettingChoice
        title="Installation method"
        value={method}
        onChange={setMethod}
        disabled={busy}
        options={[
          { value: "script", label: "Install script" },
          { value: "docker", label: "Docker" },
          { value: "manual", label: "Manual" },
          { value: "ssh", label: "Over SSH" },
        ]}
      />
      <Button
        variant="primary"
        title={setup.gatewayUrl ? "Continue" : "Turn on network access and continue"}
        disabled={
          !name.trim() ||
          (!!setup.gatewayUrl && !gateway.trim()) ||
          (gateway.trim() !== setup.gatewayUrl && settings.saving)
        }
        busy={busy}
        onPress={() => void prepare()}
      />
    </SettingsGroup>
  );
}
