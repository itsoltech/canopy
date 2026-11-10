import { FlatList, ScrollView, Text, View } from "react-native";
import { copySize, copyFileCount } from "@canopy/domain/workspace-copy";
import { Button, Field, Notice } from "../../ui/components";
import { WorkspaceCopyFiles } from "./WorkspaceCopyFiles";
import { WorkspaceCopyActions } from "./WorkspaceCopyActions";
import { useColors, useTypography } from "../../ui/theme";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { useWorkspaceCopy, type WorkspaceCopyProps } from "./use-workspace-copy";

export function WorkspaceCopy(props: WorkspaceCopyProps) {
  const { worker, workspace, onBack, onSaved } = props;
  const c = useColors();
  const type = useTypography();

  const state = useWorkspaceCopy(props);

  const {
    parent,
    setParent,
    name,
    setName,
    manifest,
    selected,
    setSelected,
    loading,
    busy,
    error,
    confirming,
    setConfirmed,
    cancelled,
    progress,
    totals,
    secrets,
    skipped,
    load,
  } = state;

  const text = (value: string) => <Text style={[type.body, { color: c.text }]}>{value}</Text>;
  let body;

  if (progress?.status === "completed") body = <CopyComplete progress={progress} skipped={skipped} />;
  else if (busy) body = <CopyProgress progress={progress} totals={totals} />;
  else if (error || cancelled)
    body = (
      <>
        <Notice error={!!error}>{error || "Copy cancelled. Partial files are removed automatically."}</Notice>
      </>
    );
  else if (confirming)
    body = (
      <>
        {text("These files may contain passwords, tokens or private keys. Copy them only to a computer you trust.")}
        <FlatList
          style={{ flex: 1 }}
          data={secrets}
          keyExtractor={(e) => e.path}
          renderItem={({ item }) => (
            <Text selectable style={[type.body, { color: c.text, paddingVertical: 4 }]}>
              {item.path}
            </Text>
          )}
        />
      </>
    );
  else if (manifest)
    body = (
      <>
        <WorkspaceCopyFiles
          manifest={manifest}
          selected={selected}
          onChange={(value) => {
            setSelected(value);
            setConfirmed(false);
          }}
        />
        <Notice>Up to 20 GB in total, 8 GB per file. Ignored file choices are remembered for this project.</Notice>
      </>
    );
  else
    body = (
      <CopyDestination
        workerId={worker.id}
        parent={parent}
        name={name}
        loading={loading}
        setParent={setParent}
        setName={setName}
        load={load}
      />
    );

  return (
    <View style={{ flex: 1, minHeight: 0, gap: 12, padding: 20 }}>
      <Text numberOfLines={2} style={[type.body, { color: c.muted }]}>
        Copy from {workspace.label || workspace.rootPath} to {worker.name}
      </Text>
      <View style={{ flex: 1, minHeight: 0, gap: 12 }}>{body}</View>
      <WorkspaceCopyActions state={state} workerName={worker.name} onSaved={onSaved} />
      {!busy && progress?.status !== "completed" && <Button title="Choose another source" onPress={onBack} />}
    </View>
  );
}

function CopyComplete({
  progress,
  skipped,
}: {
  progress: import("@canopy/contracts").ui.WorkspaceCopyProgress;
  skipped: number;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <>
      <Text accessibilityLiveRegion="polite" style={[type.body, { color: c.text }]}>
        {`Copied ${copyFileCount(progress.files)} (${copySize(progress.bytes)}). Skipped ${copyFileCount(skipped)}.`}
      </Text>
      <Notice>The workspace is ready for new threads.</Notice>
    </>
  );
}

function CopyProgress({
  progress,
  totals,
}: {
  progress: import("@canopy/contracts").ui.WorkspaceCopyProgress | undefined;
  totals: { bytes: bigint; files: number };
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <>
      <Text accessibilityLiveRegion="polite" style={[type.body, { color: c.text }]}>
        {progress?.status === "finishing" ? "Adding the workspace…" : "Copying files…"}
      </Text>
      <Text
        style={[type.body, { color: c.text }]}
      >{`${copySize(progress?.bytes ?? 0n)} / ${copySize(totals.bytes)} · ${progress?.files ?? 0} / ${totals.files} files`}</Text>
      <Notice>{progress?.currentFile || "Preparing the destination…"}</Notice>
    </>
  );
}

function CopyDestination({
  workerId,
  parent,
  name,
  loading,
  setParent,
  setName,
  load,
}: {
  workerId: string;
  parent: string;
  name: string;
  loading: boolean;
  setParent: (path: string) => void;
  setName: (name: string) => void;
  load: () => Promise<void>;
}) {
  return (
    <ScrollView contentContainerStyle={{ gap: 16 }} keyboardShouldPersistTaps="handled">
      <Field label="Directory name" value={name} onChangeText={setName} editable={!loading} />
      <DirectoryBrowser workerId={workerId} value={parent} onChange={setParent} />
      <Button
        variant="primary"
        title="Choose files"
        disabled={!parent || !name.trim()}
        busy={loading}
        onPress={() => void load()}
      />
    </ScrollView>
  );
}
