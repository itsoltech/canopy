import { useCallback, useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import type { github } from "@canopy/contracts";
import { useSession } from "../../state/session";
import { usePages } from "./usePages";
import { PageControls } from "./PageControls";
import { Button } from "../../ui/components";
import { Markdown } from "../../ui/markdown/Markdown";
import { StatusIcon as Icon } from "./StatusIcon";
import { useColors, useTypography } from "../../ui/theme";

export function PullRequestReviews({ id }: { id: string }) {
  const { client } = useSession();

  const pages = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.listPullRequestReviewThreads({ pullRequestId: id, cursor, refresh }),
      [client, id],
    ),
    id,
  );

  return (
    <View style={{ gap: 12 }}>
      {pages.current?.threads.map((thread) => (
        <ReviewThread key={thread.id} id={id} thread={thread} />
      ))}
      <PageControls
        page={pages.current?.page}
        busy={pages.busy}
        error={pages.error}
        previous={pages.previous}
        next={() => void pages.read(true)}
        retry={() => void pages.read(false, true)}
      />
    </View>
  );
}

function ReviewThread({ id, thread }: { id: string; thread: github.PullRequestReviewThread }) {
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState(thread);
  const [error, setError] = useState("");
  const [history, setHistory] = useState<github.PullRequestReviewThread[]>([]);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setData(thread);
    setHistory([]);
    setError("");
    setBusy(false);
  }, [thread]);

  async function replies() {
    if (busy) return;
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
        setError("");
      }
    } catch {
      if (version === generation.current) setError("Could not load replies. Refresh, then retry.");
    } finally {
      if (version === generation.current) setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Button title={`${data.path}:${data.line || "…"}`} variant="ghost" onPress={() => setOpen(!open)} />
        <Icon
          name={data.resolved ? "check-circle" : "chat-bubble-left"}
          label={data.resolved ? "Resolved" : "Unresolved"}
        />
        {data.outdated && <Icon name="clock" label="Outdated" />}
      </View>
      {open && (
        <>
          {data.comments.map((comment) => (
            <View key={comment.id} style={{ gap: 8 }}>
              <Text style={[type.small, { color: c.text }]}>{comment.author}</Text>
              <Markdown text={comment.body} />
            </View>
          ))}
          {!!error && <Text style={[type.small, { color: c.danger }]}>{error}</Text>}
          <View style={{ flexDirection: "row", gap: 8 }}>
            {!!history.length && (
              <Button
                title="Previous replies"
                variant="ghost"
                disabled={busy}
                onPress={() => {
                  setData(history[history.length - 1]!);
                  setHistory(history.slice(0, -1));
                }}
              />
            )}
            {!!data.repliesCursor && (
              <Button title="Next replies" variant="ghost" disabled={busy} onPress={() => void replies()} />
            )}
          </View>
        </>
      )}
    </View>
  );
}
