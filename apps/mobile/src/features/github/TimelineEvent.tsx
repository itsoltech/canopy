import { Pressable, Text, View } from "react-native";
import * as Linking from "expo-linking";
import type { github } from "@canopy/contracts";
import { timelineLook } from "@canopy/domain/github-pr";
import { safeHref } from "@canopy/domain/markdown";
import { Markdown } from "../../ui/markdown/Markdown";
import { useColors, useTypography } from "../../ui/theme";
import { ActivityHeader } from "./ActivityHeader";
import { CommentActions } from "./CommentActions";
import { CitationActions } from "./CitationActions";
import { prCommentCitation } from "@canopy/domain";

export function TimelineEvent({
  items,
  snapshot,
}: {
  items: github.PullRequestTimelineItem[];
  snapshot: github.PullRequestSnapshot;
}) {
  const c = useColors();
  const type = useTypography();
  const first = items[0];
  const entry = first?.content.value;

  if (!entry) return null;
  const look = timelineLook(entry.kind, entry.state, first?.content.case);

  return (
    <View style={{ gap: 8 }}>
      <ActivityHeader author={entry.author} look={look} time={entry.createdAt} url={entry.url} />
      {first?.content.case === "commit" ? (
        <>
          <Text style={[type.meta, { color: c.muted }]}>
            pushed {items.length} {items.length === 1 ? "commit" : "commits"}
          </Text>
          {items.map((item) => {
            const commit = item.content.value;

            if (!commit) return null;
            const href = safeHref(commit.url);

            return (
              <Pressable
                key={commit.id}
                accessibilityRole="link"
                accessibilityLabel={`Commit ${commit.sha.slice(0, 7)}: ${commit.body}`}
                onPress={() => {
                  if (href) void Linking.openURL(href);
                }}
                style={{ flexDirection: "row", gap: 8, minHeight: 32, alignItems: "center" }}
              >
                <Text style={[type.mono, { color: c.muted }]}>{commit.sha.slice(0, 7)}</Text>
                <Text numberOfLines={1} style={[type.meta, { flex: 1, color: c.text }]}>
                  {commit.body}
                </Text>
              </Pressable>
            );
          })}
        </>
      ) : first?.content.case === "event" ? (
        <Text style={[type.meta, { color: c.muted }]}>
          {look.label}
          {entry.body ? ` · ${entry.body}` : ""}
        </Text>
      ) : (
        <View style={{ padding: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.inset, borderRadius: 8 }}>
          <Markdown text={entry.body} />
          {first?.content.case === "comment" ? (
            <CommentActions
              snapshot={snapshot}
              comment={entry}
              kind="issue"
              quote={prCommentCitation(snapshot, entry)}
            />
          ) : (
            <CitationActions quote={prCommentCitation(snapshot, entry, "review")} url={entry.url} />
          )}
        </View>
      )}
    </View>
  );
}
