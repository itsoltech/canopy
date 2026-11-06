import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { Redirect } from "expo-router";
import { SafeAreaView } from "react-native-safe-area-context";
import { KeyboardArea } from "../../ui/KeyboardArea";
import { useSession } from "../../state/session";
import { Notice, ScreenHeader } from "../../ui/components";
import { PickerSheet } from "../../ui/Picker";
import { ProjectMark } from "../../ui/ProjectMark";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { styles, useColors } from "../../ui/theme";
import { ComposerBox, ComposerPill } from "../threads/ComposerBox";
import { AttachButton, AttachmentChips } from "../attachments/Attachments";
import { EffortPickerSheet, ModelPickerSheet } from "../models/ModelPicker";
import { effortLabel } from "../models/catalog";
import { permissionLabel, permissionLook, PermissionPickerSheet } from "../threads/permissions";
import { useNewThread } from "./useNewThread";

type State = ReturnType<typeof useNewThread>;

type Picker = "project" | "worker" | "model" | "effort" | "permission";

/** One screen: the message box with model, effort and files; under it project, worker and permissions. */
export function NewThreadScreen() {
  const c = useColors();
  const { session } = useSession();
  const state = useNewThread();
  const [picker, setPicker] = useState<Picker | null>(null);
  const { project, worker, selected, effort, permissionMode, message, blocker, error } = state;
  const look = permissionLook(permissionMode);

  if (!session) return <Redirect href="/pair" />;

  return (
    <SafeAreaView style={styles.fill} edges={["top", "left", "right"]}>
      <ScreenHeader title="New thread" subtitle={project?.name} />
      <KeyboardArea>
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={[styles.page, { flexGrow: 1, justifyContent: "center", paddingBottom: 48 }]}
        >
          <Text style={[styles.title, { color: c.text, textAlign: "center", marginBottom: 16 }]}>
            What should we work on?
          </Text>
          <ComposerBox
            text={message.value.text}
            onChange={message.setText}
            badges={message.badges}
            onSend={() => void state.create()}
            disabled={Boolean(blocker)}
            busy={state.busy}
            files={message.files.ids.length}
            label="Task for the agent"
            top={<AttachmentChips files={message.files.files} onRemove={message.remove} />}
            controls={
              <>
                <AttachButton draft={message.files} disabled={state.busy} />
                {selected && (
                  <ComposerPill
                    icon="cpu-chip"
                    leading={<ProviderIcon provider={selected.provider} />}
                    title={selected.name}
                    onPress={() => setPicker("model")}
                  />
                )}
                {selected?.efforts.length ? (
                  <ComposerPill icon="light-bulb" title={effortLabel(effort)} onPress={() => setPicker("effort")} />
                ) : null}
              </>
            }
          />
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
                warning={!worker?.online}
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
          {blocker && blocker !== message.files.blocker ? <Notice>{blocker}</Notice> : null}
          {error ? <Notice error>{error}</Notice> : null}
        </ScrollView>
      </KeyboardArea>
      <NewThreadPickers state={state} picker={picker} close={() => setPicker(null)} />
    </SafeAreaView>
  );
}

function NewThreadPickers({ state, picker, close }: { state: State; picker: Picker | null; close: () => void }) {
  const { projects, workers, project, workspace, sections, selected, effort, permissionMode } = state;
  const workerOf = (id: string) => workers.find((w) => w.id === id);

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
              badge: p.workspaces.length ? undefined : "Not on a worker",
            })),
          },
        ]}
      />
      <PickerSheet
        title="Worker"
        visible={picker === "worker"}
        onClose={close}
        value={workspace?.id}
        onSelect={state.pickWorkspace}
        note={project?.workspaces.length ? undefined : "This project is not on any worker yet."}
        sections={[
          {
            options: (project?.workspaces ?? []).map((w) => ({
              value: w.id,
              label: workerOf(w.workerId)?.name ?? "Unknown worker",
              description: project?.kind === "scratch" ? "Scratch folder" : w.label || w.rootPath,
              icon: "computer-desktop" as const,
              badge: workerOf(w.workerId)?.online ? undefined : "Offline",
              tone: workerOf(w.workerId)?.online ? undefined : ("warning" as const),
            })),
          },
        ]}
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
