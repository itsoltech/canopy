import { View } from "react-native";
import { Button } from "../../ui/Button";
import type { ThreadFileState } from "./file-state";

export function FileActions({
  viewer,
  onDiscard,
  onDelete,
  saveDisabled = false,
}: {
  viewer: ThreadFileState;
  onDiscard: () => void;
  onDelete: () => void;
  saveDisabled?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
      {viewer.editing ? (
        <>
          <Button
            title="Save file"
            size="sm"
            variant="primary"
            busy={viewer.busy}
            disabled={!viewer.dirty || saveDisabled}
            onPress={() => void viewer.save()}
          />
          <Button
            title={viewer.dirty ? "Discard changes" : "Stop editing"}
            size="sm"
            disabled={viewer.busy}
            onPress={onDiscard}
            style={{ minWidth: 144 }}
          />
        </>
      ) : (
        <>
          {viewer.file && !viewer.file.binary && (
            <Button title="Edit" size="sm" disabled={!viewer.editable || viewer.loading} onPress={viewer.edit} />
          )}
          <Button title="Reload" size="sm" disabled={viewer.busy || viewer.loading} onPress={() => viewer.reload()} />
          <Button
            title="Delete file"
            size="sm"
            variant="ghost"
            disabled={!viewer.file?.sha256 || viewer.busy || viewer.loading}
            onPress={onDelete}
          />
        </>
      )}
    </View>
  );
}
