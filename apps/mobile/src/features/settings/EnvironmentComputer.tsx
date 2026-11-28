import type { ui, EnvironmentFileStatus, EnvironmentSkillStatus } from "@canopy/contracts";
import { useOpenSettingsSection } from "./navigation";
import { EnvironmentPreview } from "./EnvironmentPreview";
import { Button, Notice } from "../../ui/components";
import { SettingsGroup, SettingsRow } from "./SettingsGroup";
import { ResourceState, confirmAction, useSettingsResource } from "./resource";
import { EnvironmentFiles } from "./EnvironmentFiles";
import { VersionComparison } from "./VersionComparison";
import { workerSyncState } from "@canopy/domain/environment-library";

export function EnvironmentComputer({
  worker,
  revision,
  onChanged,
}: {
  worker: ui.EnvironmentWorker;
  revision: bigint;
  onChanged: () => void;
}) {
  const resource = useSettingsResource("GetAgentEnvironment", (api) => api.getAgentEnvironment({}));
  const pending = worker.report?.revision !== worker.desiredRevision;
  const disabled = resource.busy || !worker.online || pending;

  const resolve = (file: EnvironmentFileStatus | EnvironmentSkillStatus, kind: string, action: string) => {
    const request = {
      workerId: worker.workerId,
      targetId: file.targetId,
      observedChecksum: file.observedChecksum,
      expectedRevision: revision,
      action,
    };

    const save = () =>
      void resource
        .run((api) =>
          kind === "instruction"
            ? api.resolveEnvironmentDrift(request)
            : kind === "skill"
              ? api.resolveSkillDrift(request)
              : api.resolvePluginDrift(request),
        )
        .then((r) => {
          if (r) onChanged();
        });

    if (action === "overwrite")
      confirmAction(
        "Overwrite local changes",
        "This replaces the reviewed managed content with the library version.",
        save,
      );
    else save();
  };

  return (
    <ResourceState resource={resource} gap={12}>
      <EnvironmentSyncStatus worker={worker} pending={pending} />
      {worker.compositionError ? (
        <Notice error>{worker.compositionError} The last synced files are preserved.</Notice>
      ) : !worker.supported ? (
        <Notice>Update this worker to sync its agent environment.</Notice>
      ) : !worker.online ? (
        <Notice>Offline. This computer receives the latest instructions when it reconnects.</Notice>
      ) : pending ? (
        <Notice>Waiting for this computer to report the saved instructions.</Notice>
      ) : null}
      <EnvironmentPreview worker={worker} />
      <SettingsGroup title="Files on this computer">
        {!worker.report?.files.length && <Notice>Assigned files appear here after the worker’s first sync.</Notice>}
        {worker.report?.files.map((file) => (
          <SettingsRow
            key={file.targetId}
            title={file.path || "Instruction destinations"}
            description={`${file.harness} · ${file.scope} · ${file.status}`}
          >
            {file.detail && <Notice>{file.detail}</Notice>}
            {["drift", "kept"].includes(file.status) && (
              <>
                <VersionComparison
                  before={file.managedContent}
                  after={
                    worker.preview.find(
                      (p) => p.harness === file.harness && (file.scope === "device" ? p.deviceHome : p.platformHome),
                    )?.content ?? ""
                  }
                />
                <DriftActions
                  disabled={disabled}
                  importable={file.importable}
                  onResolve={(action) => resolve(file, "instruction", action)}
                />
              </>
            )}
          </SettingsRow>
        ))}
      </SettingsGroup>
      <EnvironmentSkillReports
        title="Skills"
        files={worker.report?.skills ?? []}
        supported={worker.skillsSupported}
        disabled={disabled}
        onResolve={(file, action) => resolve(file, "skill", action)}
      />
      <EnvironmentSkillReports
        title="Plugins"
        files={worker.report?.plugins ?? []}
        supported={worker.pluginsSupported}
        disabled={disabled}
        onResolve={(file, action) => resolve(file, "plugin", action)}
      />
    </ResourceState>
  );
}

function EnvironmentSyncStatus({ worker, pending }: { worker: ui.EnvironmentWorker; pending: boolean }) {
  const openSettingsSection = useOpenSettingsSection();

  return (
    <SettingsGroup
      title="Sync and tags"
      actions={
        <Button
          title="Edit tags"
          variant="text"
          size="sm"
          onPress={() => openSettingsSection("workers", { workerId: worker.workerId, workerTopic: "tags" })}
        />
      }
    >
      <SettingsRow
        title={workerSyncState(worker)}
        description={
          !worker.compositionError && worker.supported && worker.online && !pending
            ? "New agent sessions use saved instructions after sync."
            : undefined
        }
      />
      <SettingsRow title="Automatic tags" description={worker.automaticTags.join(", ") || "None"} />
      <SettingsRow title="Manual tags" description={worker.manualTags.join(", ") || "None"} />
    </SettingsGroup>
  );
}

function EnvironmentSkillReports({
  title,
  files,
  supported,
  disabled,
  onResolve,
}: {
  title: string;
  files: EnvironmentSkillStatus[];
  supported: boolean;
  disabled: boolean;
  onResolve: (f: EnvironmentSkillStatus, action: string) => void;
}) {
  return (
    <SettingsGroup title={title}>
      {!supported && <Notice>Update this worker to sync {title.toLowerCase()}.</Notice>}
      {!files.length && <Notice>Assigned {title.toLowerCase()} appear here after sync.</Notice>}
      {files.map((file) => (
        <SettingsRow
          key={file.targetId}
          title={file.path}
          description={
            file.status === "local"
              ? `${file.harness} · Local installation`
              : [file.harness, file.scope, file.status, file.version > 0n && `Version ${file.version}`]
                  .filter(Boolean)
                  .join(" · ")
          }
        >
          {file.detail && <Notice>{file.detail}</Notice>}
          {["drift", "kept"].includes(file.status) && (
            <>
              <EnvironmentFiles
                artifact={{
                  $typeName: "canopy.worker.v1.SkillArtifact",
                  name: "Library version",
                  description: "",
                  checksum: file.desiredChecksum,
                  files: file.desiredFiles,
                }}
                before={{
                  $typeName: "canopy.worker.v1.SkillArtifact",
                  name: "On this computer",
                  description: "",
                  checksum: file.observedChecksum,
                  files: file.managedFiles,
                }}
              />
              <DriftActions
                disabled={disabled}
                importable={title === "Skills" && file.importable}
                onResolve={(action) => onResolve(file, action)}
              />
            </>
          )}
        </SettingsRow>
      ))}
    </SettingsGroup>
  );
}

function DriftActions({
  disabled,
  importable,
  onResolve,
}: {
  disabled: boolean;
  importable: boolean;
  onResolve: (action: string) => void;
}) {
  return (
    <>
      <Button title="Keep mine" disabled={disabled} onPress={() => onResolve("keep")} />
      <Button
        variant="danger"
        title="Overwrite local changes"
        disabled={disabled}
        onPress={() => onResolve("overwrite")}
      />
      {importable && <Button title="Import local changes" disabled={disabled} onPress={() => onResolve("import")} />}
    </>
  );
}
