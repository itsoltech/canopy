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

export function ReviewThread({ id, thread }: { id: string; thread: github.PullRequestReviewThread }) {
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();
  const [data, setData] = useState(thread);
  const [history, setHistory] = useState<github.PullRequestReviewThread[]>([]);
  const [visible, setVisible] = useState(3);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const comments = [...history.flatMap((page) => page.comments), ...data.comments];
  useEffect(() => {
    generation.current++;
    setData(thread);
    setHistory([]);
    setVisible(3);
    setError("");
    setBusy(false);

    return () => {
      generation.current++;
    };
  }, [thread]);

  async function more() {
    if (busy) return;

    if (visible < comments.length) {
      setVisible(comments.length);

      return;
    }

    setBusy(true);
    const version = generation.current;

    try {
      const result = await client!.api.listPullRequestReviewThreads({
        pullRequestId: id,
        resourceId: thread.id,
        cursor: data.repliesCursor,
      });

      if (version === generation.current && result.threads[0]) {
        setHistory([...history, data]);
        setData(result.threads[0]);
        setVisible(comments.length + result.threads[0].comments.length);
        setError("");
      }
    } catch {
      if (version === generation.current) setError("Could not load replies. Refresh, then retry.");
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }

  return (
    <View
      style={{ gap: 12, padding: 12, borderWidth: 1, borderColor: c.line, backgroundColor: c.inset, borderRadius: 8 }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Icon name="code-bracket" />
        <Text numberOfLines={1} ellipsizeMode="middle" style={[type.mono, { flex: 1, color: c.text }]}>
          {data.path}:{data.line || "…"}
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
            author={comment.author}
            look={reviewerLook("commented")}
            time={comment.createdAt}
            url={comment.url}
          />
          <Markdown text={comment.body} />
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
    </View>
  );
}
