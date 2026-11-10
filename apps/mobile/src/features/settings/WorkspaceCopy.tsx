import { FlatList, ScrollView, Text, View } from "react-native";
import { copySize, copyFileCount } from "@canopy/domain/workspace-copy";
import { Button, Field, Notice } from "../../ui/components";
import { Checkbox } from "../../ui/Checkbox";
import { FileTreePicker } from "../../ui/FileTreePicker";
import { useColors, useTypography } from "../../ui/theme";
import { DirectoryBrowser } from "./DirectoryBrowser";
import { useWorkspaceCopy, type WorkspaceCopyProps } from "./use-workspace-copy";

export function WorkspaceCopy(props: WorkspaceCopyProps) {
  const { worker, workspace, onBack, onSaved } = props;
  const c = useColors();
  const type = useTypography();

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
    setConfirming,
    confirmed,
    setConfirmed,
    cancelled,
    progress,
    roots,
    totals,
    metadataMissing,
    secrets,
    skipped,
    load,
    copy,
    cancel,
  } = useWorkspaceCopy(props);

  const text = (value: string) => <Text style={[type.body, { color: c.text }]}>{value}</Text>;
  let body;

  if (progress?.status === "completed") body = <CopyComplete progress={progress} skipped={skipped} onSaved={onSaved} />;
  else if (busy) body = <CopyProgress progress={progress} totals={totals} cancel={cancel} />;
  else if (error || cancelled)
    body = (
      <>
        <Notice error={!!error}>{error || "Copy cancelled. Partial files are removed automatically."}</Notice>
        <Button title="Refresh file list" onPress={() => void load()} />
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
        <Checkbox label={`I want to copy these files to ${worker.name}`} checked={confirmed} onChange={setConfirmed} />
        <Button variant="primary" title="Copy these files" disabled={!confirmed} onPress={() => void copy()} />
        <Button
          title="Back to files"
          onPress={() => {
            setConfirming(false);
            setConfirmed(false);
          }}
        />
      </>
    );
  else if (manifest)
    body = (
      <>
        <Notice>Git metadata preserves the branch and local changes. Ignored build files start excluded.</Notice>
        <FileTreePicker
          roots={roots}
          selected={selected}
          onChange={(value) => {
            setSelected(value);
            setConfirmed(false);
          }}
        />
        {text(
          `${copyFileCount(totals.files)} · ${copySize(totals.bytes)} selected · ${skipped.toLocaleString()} skipped`,
        )}
        <Notice>Up to 20 GB in total, 8 GB per file. Your selection is remembered for this project.</Notice>
        {metadataMissing && (
          <Notice>
            Include all Git metadata to copy this checkout. Wait for Git operations to finish, then refresh.
          </Notice>
        )}
        <Button
          variant="primary"
          title={secrets.length ? "Review secrets" : "Copy workspace"}
          disabled={!totals.files || metadataMissing}
          onPress={() => void copy()}
        />
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
      {body}
      {!busy && progress?.status !== "completed" && <Button title="Choose another source" onPress={onBack} />}
    </View>
  );
}

function CopyComplete({
  progress,
  skipped,
  onSaved,
}: {
  progress: import("@canopy/contracts").ui.WorkspaceCopyProgress;
  skipped: number;
  onSaved: () => void;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <>
      <Text accessibilityLiveRegion="polite" style={[type.body, { color: c.text }]}>
        {`Copied ${copyFileCount(progress.files)} (${copySize(progress.bytes)}). Skipped ${copyFileCount(skipped)}.`}
      </Text>
      <Notice>The workspace is ready for new threads.</Notice>
      <Button variant="primary" title="Done" onPress={onSaved} />
    </>
  );
}

function CopyProgress({
  progress,
  totals,
  cancel,
}: {
  progress: import("@canopy/contracts").ui.WorkspaceCopyProgress | undefined;
  totals: { bytes: bigint; files: number };
  cancel: () => void;
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
      <Button title="Cancel copy" onPress={cancel} />
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
