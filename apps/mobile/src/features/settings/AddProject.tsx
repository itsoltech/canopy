import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { ui } from "@canopy/contracts";
import { useOverview } from "../../state/overview";
import { IconButton, Notice, Sheet } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { useWorkerPresence } from "../computers/presence";
import { useWorkerOptions } from "../computers/worker-options";
import { useAddProject } from "./use-add-project";
import { DirectoryPicker } from "./DirectoryPicker";
import { NewProjectFields } from "./NewProjectFields";
import { ProjectChoiceRow, ProjectSourceChoices, projectSources, type ProjectSource } from "./ProjectSourceChoices";

export function AddProjectSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);

  return (
    <Sheet title="Add project" scroll={false} visible={visible} onClose={() => !busy && onClose()}>
      {visible && <AddProject onBusy={setBusy} onSaved={onClose} />}
    </Sheet>
  );
}

/** The same worker → source → destination flow as the desktop project picker. */
export function AddProject({ onSaved, onBusy }: { onSaved: () => void; onBusy: (busy: boolean) => void }) {
  const { workers } = useOverview();
  const presence = useWorkerPresence();
  const options = useWorkerOptions()(workers.filter((worker) => !worker.revokedAt));
  const available = options.filter((option) => !option.disabled);
  const [workerId, setWorker] = useState(available.length === 1 ? available[0]!.value : "");
  const [kind, setKind] = useState<ProjectSource>();
  const action = useAddProject(onSaved, onBusy);
  const worker = workers.find((w) => w.id === workerId);
  const online = presence(worker).online;
  const c = useColors();
  const type = useTypography();

  function back() {
    if (action.busy) return;
    action.reset();

    if (kind) setKind(undefined);
    else setWorker("");
  }

  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderColor: c.line,
        }}
      >
        {!!workerId && (
          <IconButton
            icon="chevron-left"
            label={kind ? "Choose source" : "Choose worker"}
            disabled={action.busy}
            onPress={back}
          />
        )}
        <View style={{ flex: 1, minWidth: 0, gap: 2, paddingHorizontal: workerId ? 0 : 8 }}>
          <Text style={[type.chrome, { color: c.text }]}>
            {kind
              ? projectSources.find((source) => source.value === kind)?.title
              : workerId
                ? "Choose source"
                : "Choose worker"}
          </Text>
          {!!worker && (
            <Text numberOfLines={1} style={[type.meta, { color: c.muted }]}>
              {worker.name}
            </Text>
          )}
        </View>
      </View>
      {!!kind && !online && (
        <View style={{ paddingHorizontal: 20, paddingVertical: 12 }}>
          <Notice>{presence(worker).reason || "This worker is offline. Start it and try again."}</Notice>
        </View>
      )}
      {!workerId || !kind ? (
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 8, gap: 4 }}>
          {!workerId ? (
            options.map((option) => (
              <ProjectChoiceRow
                key={option.value}
                title={[option.label, option.suffix].filter(Boolean).join(" · ")}
                description={option.description || (option.online ? "Online" : "Offline")}
                icon="computer-desktop"
                disabled={option.disabled}
                onPress={() => setWorker(option.value)}
              />
            ))
          ) : (
            <ProjectSourceChoices capable={worker?.projectSources ?? false} onChoose={setKind} />
          )}
          {!options.length && (
            <View style={{ padding: 12 }}>
              <Notice>No workers available. Add a worker in Settings → Workers.</Notice>
            </View>
          )}
        </ScrollView>
      ) : kind === "directory" ? (
        <DirectoryPicker
          key={workerId}
          workerId={workerId}
          actionLabel={action.error ? "Retry" : "Add project"}
          busy={action.busy}
          disabled={!online}
          notice={action.error ? <Notice error>{action.error}</Notice> : undefined}
          onChoose={(path) =>
            void action.add(
              create(ui.AddProjectRequestSchema, { workerId, source: { case: "directoryPath", value: path } }),
              false,
            )
          }
        />
      ) : (
        worker && (
          <NewProjectFields key={`${workerId}:${kind}`} worker={worker} kind={kind} action={action} online={online} />
        )
      )}
    </View>
  );
}
