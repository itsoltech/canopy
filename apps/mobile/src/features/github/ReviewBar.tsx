import { useState } from "react";
import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { Button, Sheet } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { ReviewForm } from "./ReviewForm";
import type { ReviewDraft } from "./useReviewDraft";
import { Skeleton } from "../../ui/Skeleton";

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
        {!draft.pages.length && !draft.error ? (
          <Skeleton style={{ flex: 1, height: 20 }} />
        ) : (
          <Text style={[type.meta, { color: c.text, flex: 1 }]}>
            {draft.error
              ? "Could not load review."
              : draft.pendingId
                ? `${draft.count} pending ${draft.count === 1 ? "comment" : "comments"}`
                : "No pending review"}
          </Text>
        )}
        <Button
          title={draft.error ? "Retry" : "Review changes"}
          size="sm"
          variant="primary"
          disabled={draft.busy}
          onPress={async () => {
            if (await draft.refresh()) setOpen(true);
          }}
        />
      </View>
      <Sheet title="Review changes" visible={open} onClose={() => setOpen(false)}>
        <ReviewForm snapshot={snapshot} draft={draft} onDone={() => setOpen(false)} />
      </Sheet>
    </>
  );
}
