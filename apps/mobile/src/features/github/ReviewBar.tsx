import { useState } from "react";
import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { ReviewForm } from "./ReviewForm";
import type { ReviewDraft } from "./useReviewDraft";

export function ReviewBar({ snapshot, draft }: { snapshot: github.PullRequestSnapshot; draft: ReviewDraft }) {
  const c = useColors(),
    type = useTypography();

  const [open, setOpen] = useState(false);

  return (
    <>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          minHeight: 56,
          padding: 12,
          borderBottomWidth: 1,
          borderColor: c.line,
          backgroundColor: c.background,
        }}
      >
        <Text style={[type.meta, { color: c.text, flex: 1 }]}>
          {draft.busy
            ? "Loading review…"
            : draft.pendingId
              ? `${draft.count} pending ${draft.count === 1 ? "comment" : "comments"}`
              : "No pending review"}
        </Text>
        <Button
          title="Review changes"
          size="sm"
          variant="primary"
          disabled={draft.busy}
          onPress={async () => {
            await draft.refresh();
            setOpen(true);
          }}
        />
      </View>
      <Sheet title="Review changes" visible={open} onClose={() => setOpen(false)}>
        <ReviewForm snapshot={snapshot} draft={draft} onDone={() => setOpen(false)} />
      </Sheet>
    </>
  );
}
