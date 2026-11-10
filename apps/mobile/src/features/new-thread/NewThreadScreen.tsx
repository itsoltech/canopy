import { useState } from "react";
import { Text, View } from "react-native";
import { Redirect } from "expo-router";
import { ScreenFrame } from "../../ui/ScreenFrame";
import { ScreenScroll } from "../../ui/ScreenScroll";
import { KeyboardViewport } from "../../ui/KeyboardViewport";
import { useSession } from "../../state/session";
import { Button, Notice, ScreenHeader } from "../../ui/components";
import { openSettingsSection } from "../settings/navigation";
import { PickerSheet } from "../../ui/Picker";
import { ProjectMark } from "../../ui/ProjectMark";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { styles, useColors } from "../../ui/theme";
import { ComposerBox, ComposerPill } from "../threads/ComposerBox";
import { AttachButton, AttachmentChips } from "../attachments/Attachments";
import { DropZone, PasteTarget } from "../attachments/FileIntake";
import { EffortPickerSheet, ModelPickerSheet } from "../models/ModelPicker";
import { useEffortLabel } from "../settings/display";
import { permissionLabel, permissionLook, PermissionPickerSheet } from "../threads/permissions";
import { useNewThread } from "./useNewThread";
import { WorkerPickerSheet } from "./WorkerPickerSheet";
import { WorkspacePills } from "./WorkspacePickers";
import { MentionSuggestions } from "../composer/MentionSuggestions";
import { SkeletonScope } from "../../ui/Skeleton";
import { useProjectDetails } from "../computers/project-details";

type State = ReturnType<typeof useNewThread>;

type Picker = "project" | "worker" | "model" | "effort" | "permission";

/** One screen: the message box with model, effort and files; under it project, worker and permissions. */
export function NewThreadScreen() {
  const c = useColors();
  const { session } = useSession();
  const state = useNewThread();
  const [picker, setPicker] = useState<Picker | null>(null);
  const { project, worker, selected, effort, permissionMode, message, blocker, error } = state;
  const effortLabel = useEffortLabel();
  const look = permissionLook(permissionMode);

  if (!session) return <Redirect href="/pair" />;

  return (
    <ScreenFrame header={<ScreenHeader title="New thread" subtitle={project?.name} />}>
      <KeyboardViewport>
        <DropZone draft={message.files} disabled={state.busy}>
          <ScreenScroll
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
          >
            <Text style={[styles.title, { color: c.text, textAlign: "center", marginBottom: 16 }]}>
              What should we work on?
            </Text>
            <MentionSuggestions
              scope={state.mentionScope}
              trigger={message.trigger}
              onPick={(option) => message.pickMention(option.mention)}
            />
            <SkeletonScope loading={state.initialLoading}>
              <PasteTarget draft={message.files}>
                <ComposerBox
                  text={message.value.text}
                  onChange={message.setText}
                  badges={message.badges}
                  triggers
                  onSend={() => void state.create()}
                  disabled={state.initialLoading || Boolean(blocker)}
                  busy={state.busy}
                  files={message.files.ids.length}
                  label="Task for the agent"
                  top={<AttachmentChips files={message.files.files} onRemove={message.remove} />}
                  attachment={<AttachButton draft={message.files} disabled={state.busy} />}
                  controls={
                    <>
                      {selected && (
                        <ComposerPill
                          icon="cpu-chip"
                          leading={<ProviderIcon provider={selected.provider} />}
                          title={selected.name}
                          onPress={() => setPicker("model")}
                        />
                      )}
                      {selected?.efforts.length ? (
                        <ComposerPill
                          icon="light-bulb"
                          title={effortLabel(effort)}
                          onPress={() => setPicker("effort")}
                        />
                      ) : null}
                    </>
                  }
                />
              </PasteTarget>
              <View style={[styles.row, { justifyContent: "space-between", paddingHorizontal: 6, flexWrap: "wrap" }]}>
                <View style={[styles.row, { gap: 0, flexShrink: 1 }]}>
                  <ComposerPill
                    icon="folder-open"
                    leading={project ? <ProjectMark name={project.name} kind={project.kind} /> : undefined}
                    title={project?.name ?? "No project"}
                    onPress={() => setPicker("project")}
                  />
                  <ComposerPill
                    icon="computer-desktop"
                    title={worker?.name ?? "Choose a worker"}
                    warning={!state.workerPresence.online}
                    onPress={() => setPicker("worker")}
                  />
                </View>
                <ComposerPill
                  icon={look.icon}
                  title={permissionLabel(permissionMode)}
                  warning={look.tone === "warning"}
                  danger={look.tone === "danger"}
                  onPress={() => setPicker("permission")}
                />
              </View>
              <WorkspacePills draft={state.workspaceDraft} />
            </SkeletonScope>
            {!state.initialLoading && blocker && blocker !== message.files.blocker ? <Notice>{blocker}</Notice> : null}
            {!state.initialLoading && (
              <Button
                title="Manage projects"
                variant="ghost"
                size="sm"
                onPress={() => openSettingsSection("projects")}
              />
            )}
            {error ? <Notice error>{error}</Notice> : null}
          </ScreenScroll>
        </DropZone>
      </KeyboardViewport>
      <NewThreadPickers state={state} picker={picker} close={() => setPicker(null)} />
    </ScreenFrame>
  );
}

function NewThreadPickers({ state, picker, close }: { state: State; picker: Picker | null; close: () => void }) {
  const { projects, workers, project, workspace, sections, selected, effort, permissionMode } = state;
  const details = useProjectDetails();

  return (
    <>
      <PickerSheet
        title="Project"
        visible={picker === "project"}
        onClose={close}
        search={projects.length > 6 ? "Search projects" : undefined}
        value={project?.id}
        onSelect={state.pickProject}
        sections={[
          {
            options: projects.map((p) => ({
              value: p.id,
              label: p.name,
              leading: <ProjectMark name={p.name} kind={p.kind} />,
              badge: state.projectAway(p) ? "Offline" : p.workspaces.length ? undefined : "Not on a worker",
              description: [state.projectAway(p), details.detail(p)].filter(Boolean).join(" · "),
              keywords: p.aliases.join(" "),
              disabled: Boolean(state.projectAway(p)),
            })),
          },
        ]}
      />
      <WorkerPickerSheet
        visible={picker === "worker"}
        onClose={close}
        project={project}
        workers={workers}
        value={workspace?.id}
        onSelect={state.pickWorkspace}
      />
      <ModelPickerSheet
        visible={picker === "model"}
        onClose={close}
        sections={sections}
        value={selected?.key}
        onSelect={(choice) => state.pickModel(choice.key)}
      />
      <EffortPickerSheet
        visible={picker === "effort"}
        onClose={close}
        choice={selected}
        value={effort}
        onSelect={state.setEffort}
      />
      <PermissionPickerSheet
        visible={picker === "permission"}
        onClose={close}
        value={permissionMode}
        onSelect={state.setPermission}
      />
    </>
  );
}
