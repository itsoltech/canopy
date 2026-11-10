import { useEffect, useState } from "react";
import { View } from "react-native";
import type { github } from "@canopy/contracts";
import { metadataField, type MetadataKind } from "@canopy/domain/github-metadata";
import { Button, Sheet } from "../../ui/components";
import { useMetadataEditor } from "./useMetadataEditor";
import { MetadataForm } from "./MetadataForm";
import { invalidations } from "./invalidations";

export function MetadataEdit({
  snapshot,
  kind,
  onDisplay,
}: {
  snapshot: github.PullRequestSnapshot;
  kind: MetadataKind;
  onDisplay?: (value: github.PullRequestMetadata | undefined) => void;
}) {
  const form = useMetadataEditor(snapshot, kind);
  const { editor, state: f, online } = form;
  const [open, setOpen] = useState(false);
  const label = kind === "title" ? "Edit title" : kind === "description" ? "Edit description" : `Edit ${kind}`;
  useEffect(() => onDisplay?.(f.display), [f.display, onDisplay]);

  async function apply() {
    if (!editor || form.blocked) return;

    if (await editor.apply()) {
      setOpen(false);
      invalidations.publish(snapshot.summary?.ref?.id ?? "");
      invalidations.publish(`${snapshot.summary?.ref?.id}:metadata`);
    }
  }

  const content = (
    <MetadataForm
      snapshot={snapshot}
      kind={kind}
      form={form}
      onCancel={() => setOpen(false)}
      onApply={() => void apply()}
    />
  );

  return (
    <View style={{ minWidth: 0, gap: 8 }}>
      <View style={{ alignItems: "flex-end" }}>
        <Button
          title={kind === "title" ? "Edit title" : "Edit"}
          label={label}
          size="sm"
          variant="ghost"
          disabled={!online || snapshot.stale || f.busy}
          onPress={() => {
            setOpen(!open);

            if (!open) void editor?.load();
          }}
        />
      </View>
      {metadataField(kind) === "details" ? (
        open && content
      ) : (
        <Sheet
          title={label}
          visible={open}
          onClose={() => {
            if (!f.busy) setOpen(false);
          }}
        >
          {content}
        </Sheet>
      )}
    </View>
  );
}
