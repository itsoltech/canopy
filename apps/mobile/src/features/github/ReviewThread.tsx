import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { reviewerLook } from "@canopy/domain/github-pr";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { Markdown } from "../../ui/markdown/Markdown";
import { Icon } from "../../ui/Icon";
import { useColors, useTypography } from "../../ui/theme";
import { StatusIcon } from "./StatusIcon";
import { ActivityHeader } from "./ActivityHeader";
import { CommentComposer } from "./CommentComposer";
import { CommentActions } from "./CommentActions";
import { prCommentCitation } from "@canopy/domain";
import { ThreadResolution } from "./ThreadResolution";
import { anchorLabel } from "@canopy/domain/github-review";

export function ReviewThread({
  id,
  thread,
  snapshot,
}: {
  id: string;
  thread: github.PullRequestReviewThread;
  snapshot: github.PullRequestSnapshot;
}) {
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();
  const [page, setData] = useState(thread);
  const [history, setHistory] = useState<github.PullRequestReviewThread[]>([]);
  const [visible, setVisible] = useState(3);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState(thread);
  const generation = useRef({ value: 0 });
  const data = history.length ? { ...thread, comments: page.comments, repliesCursor: page.repliesCursor } : thread;

  const comments = [
    ...new Map(
      [...history.flatMap((page) => page.comments), ...data.comments].map((comment) => [comment.id, comment]),
    ).values(),
  ];

  if (source !== thread) {
    setSource(thread);

    if (history.length) setHistory([thread, ...history.slice(1)]);
  }

  useEffect(() => {
    const serial = generation.current;
    serial.value++;

    return () => {
      serial.value++;
    };
  }, [thread.id, snapshot.summary?.headSha]);

  async function more() {
    if (busy) return;

    if (visible < comments.length) {
      setVisible(comments.length);

      return;
    }

    setBusy(true);
    const version = generation.current.value;

    try {
      const result = await client!.api.listPullRequestReviewThreads({
        pullRequestId: id,
        resourceId: thread.id,
        cursor: data.repliesCursor,
      });

      if (version === generation.current.value && result.threads[0]) {
        setHistory([...history, data]);
        setData(result.threads[0]);
        setVisible(comments.length + result.threads[0].comments.length);
        setError("");
      }
    } catch {
      if (version === generation.current.value) setError("Could not load replies. Refresh, then retry.");
    } finally {
      if (version === generation.current.value) setBusy(false);
    }
  }

  return (
    <View
      style={{ gap: 12, padding: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.inset, borderRadius: 8 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="code-bracket" />
        <Text numberOfLines={1} ellipsizeMode="middle" style={[type.mono, { flex: 1, color: c.text }]}>
          {data.path} · {anchorLabel(data)}
        </Text>
        <StatusIcon
          name={data.resolved ? "check-circle" : "chat-bubble-left"}
          label={data.resolved ? "Resolved" : "Unresolved"}
        />
        {data.outdated && <StatusIcon name="clock" label="Outdated" />}
      </View>
      {comments.slice(0, visible).map((comment, index) => (
        <View
          key={comment.id}
          style={[
            { gap: 8 },
            index > 0 && { marginLeft: 12, paddingLeft: 12, borderLeftWidth: 1, borderColor: c.line },
          ]}
        >
          <ActivityHeader
            withAvatar={index > 0}
            avatarUrl={comment.avatarUrl}
            pullRequestId={id}
            author={comment.author}
            look={reviewerLook("commented")}
            time={comment.createdAt}
            url={comment.url}
          />
          <Markdown text={comment.body} />
          <CommentActions
            snapshot={snapshot}
            comment={comment}
            kind="review"
            quote={prCommentCitation(snapshot, comment, "review_comment", data)}
          />
        </View>
      ))}
      {!!error && <Notice error>{error}</Notice>}
      {(visible < comments.length || !!data.repliesCursor) && (
        <Button
          title={busy ? "Loading replies…" : "Show more replies"}
          variant="ghost"
          disabled={busy}
          onPress={() => void more()}
        />
      )}
      <CommentComposer key={`${snapshot.accountId}:${thread.id}`} snapshot={snapshot} resourceId={thread.id} />
      <ThreadResolution key={`${snapshot.accountId}:${thread.id}:resolve`} snapshot={snapshot} thread={data} />
    </View>
  );
}
