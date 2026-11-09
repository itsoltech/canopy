import { useState } from "react";
import { View } from "react-native";
import type { BlobRef } from "@canopy/contracts";
import { Button } from "../../ui/Button";
import { useTimelineDirectory } from "../timeline/directory";
import { TextViewer } from "./TextViewer";

export function TextViewerButton({
  text,
  blob,
  label,
  diff = false,
}: {
  text?: string;
  blob?: BlobRef | undefined;
  label: string;
  diff?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const directory = useTimelineDirectory();

  return (
    <View style={{ alignItems: "flex-start" }}>
      <Button
        title={diff ? "Show full diff" : "Show full output"}
        size="sm"
        variant="ghost"
        onPress={() => setOpen(true)}
      />
      {open && (
        <TextViewer
          text={text}
          blob={blob}
          label={label}
          diff={diff}
          threadId={directory.sourceId || directory.currentId}
          onClose={() => setOpen(false)}
        />
      )}
    </View>
  );
}
