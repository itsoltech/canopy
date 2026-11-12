import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { anchorLabel } from "@canopy/domain/github-review";
import { Button, Notice } from "../../ui/components";
import { Markdown } from "../../ui/markdown/Markdown";
import { useColors, useTypography } from "../../ui/theme";
import { CommentActions } from "./CommentActions";
import type { ReviewDraft } from "./useReviewDraft";
import { prCommentCitation } from "@canopy/domain";

export function PendingComments({ snapshot, draft }: { snapshot: github.PullRequestSnapshot; draft: ReviewDraft }) {
  const c = useColors(),
    type = useTypography();

  return (
    <View style={{ gap: 12 }}>
      <Text style={[type.body, { color: c.text }]}>
        {draft.count} pending {draft.count === 1 ? "comment" : "comments"}
      </Text>
      {draft.pages
        .flatMap((p) => p.comments)
        .map((item) => (
          <View
            key={item.comment?.id}
            style={{ gap: 8, padding: 12, borderWidth: 1, borderColor: c.line, borderRadius: 6 }}
          >
            <Text style={[type.mono, { color: c.text }]}>
              {item.path} · {anchorLabel(item)}
            </Text>
            {item.outdated && (
              <Text style={[type.meta, { color: c.warning }]}>Outdated · {item.comment?.sha.slice(0, 7)}</Text>
            )}
            <Markdown text={item.comment?.body ?? ""} />
            {item.comment && (
              <CommentActions
                snapshot={snapshot}
                comment={item.comment}
                kind="review"
                quote={prCommentCitation(snapshot, item.comment, "review_comment", item)}
              />
            )}
          </View>
        ))}
      {!!draft.error && <Notice error>{draft.error}</Notice>}
      {!!draft.pages.at(-1)?.page?.nextCursor && (
        <Button
          title="Load more pending comments"
          variant="ghost"
          disabled={draft.busy}
          onPress={() => void draft.read(true)}
        />
      )}
      {!!draft.pendingId && !draft.complete && <Notice>Load and check all pending comments before submitting.</Notice>}
    </View>
  );
}
