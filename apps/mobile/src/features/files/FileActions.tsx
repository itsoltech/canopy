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
      {viewer.editable && (
        <>
          <Button
            title="Save file"
            size="sm"
            variant="primary"
            busy={viewer.busy}
            disabled={!viewer.dirty || saveDisabled || viewer.readOnly}
            onPress={() => void viewer.save()}
          />
          <Button
            title="Discard changes"
            size="sm"
            disabled={viewer.busy || !viewer.dirty}
            onPress={onDiscard}
            style={{ minWidth: 144 }}
          />
        </>
      )}
      <>
        <Button
          title="Reload"
          size="sm"
          disabled={viewer.busy || viewer.loading || viewer.dirty}
          onPress={() => viewer.reload()}
        />
        <Button
          title="Delete file"
          size="sm"
          variant="ghost"
          disabled={!viewer.file?.sha256 || viewer.busy || viewer.loading || viewer.dirty}
          onPress={onDelete}
        />
      </>
    </View>
  );
}
