import { useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import type { ui } from "@open-agents/contracts";
import { useSession } from "../../state/session";
import { Button, Field, IconButton, Notice, Sheet } from "../../ui/components";
import { ProjectMark } from "../../ui/ProjectMark";
import { styles, useColors } from "../../ui/theme";

export function ThreadHeader({
  thread,
  project,
  turns,
  onDetails,
}: {
  thread?: ui.Thread;
  project?: ui.Project;
  turns: ui.Turn[];
  onDetails: () => void;
}) {
  const c = useColors();
  const { client } = useSession();
  const [sheet, setSheet] = useState<"actions" | "search" | null>(null);
  const [title, setTitle] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function action(kind: "title" | "archive" | "unread") {
    if (!client || !thread) return;
    setBusy(true);
    setError("");
    try {
      if (kind === "title")
        await client.api.updateThread({
          threadId: thread.id,
          title: title.trim(),
        });
      if (kind === "archive") {
        await client.api.setThreadArchived({
          threadId: thread.id,
          archived: !thread.archivedAt,
        });
        router.replace("/");
      }
      if (kind === "unread")
        await client.api.setThreadRead({ threadId: thread.id, unread: true });
      setSheet(null);
    } catch {
      setError("Could not update the thread. Try again.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <View
        style={[
          styles.row,
          {
            height: 48,
            paddingHorizontal: 4,
            gap: 0,
            borderBottomWidth: 1,
            borderBottomColor: c.line,
          },
        ]}
      >
        <IconButton
          icon="bars-3"
          label="Threads"
          onPress={() =>
            router.canGoBack() ? router.back() : router.replace("/")
          }
        />
        {project && <ProjectMark name={project.name} kind={project.kind} />}
        <Text
          numberOfLines={1}
          style={[
            styles.body,
            { color: c.muted, maxWidth: 70, paddingLeft: 8 },
          ]}
        >
          {project?.name || "Thread"}
        </Text>
        <Text style={[styles.body, { color: c.faint, paddingHorizontal: 8 }]}>
          /
        </Text>
        <Text
          numberOfLines={1}
          style={[styles.body, { color: c.text, flex: 1 }]}
        >
          {thread?.title || "Thread"}
        </Text>
        <IconButton
          icon="magnifying-glass"
          label="Search thread"
          onPress={() => setSheet("search")}
        />
        <IconButton
          icon="ellipsis-horizontal"
          label="Thread actions"
          onPress={() => {
            setTitle(thread?.title ?? "");
            setSheet("actions");
          }}
        />
        <IconButton
          icon="view-columns"
          label="Thread details"
          onPress={onDetails}
        />
      </View>
      <Sheet
        visible={sheet !== null}
        title={sheet === "search" ? "Search thread" : "Thread actions"}
        onClose={() => setSheet(null)}
      >
        {sheet === "search" ? (
          <>
            <Field
              label="Search messages"
              value={query}
              onChangeText={setQuery}
              placeholder="Search"
            />
            {query.trim() &&
              turns
                .filter((t) =>
                  `${t.messageText} ${t.inputText}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((t) => (
                  <Text key={t.id} style={[styles.body, { color: c.body }]}>
                    {t.messageText || t.inputText}
                  </Text>
                ))}
          </>
        ) : (
          <>
            <Field label="Title" value={title} onChangeText={setTitle} />
            <Button
              title="Rename"
              disabled={!title.trim()}
              busy={busy}
              onPress={() => void action("title")}
            />
            <Button
              title="Mark unread"
              secondary
              busy={busy}
              onPress={() => void action("unread")}
            />
            <Button
              title={thread?.archivedAt ? "Unarchive" : "Archive"}
              secondary
              busy={busy}
              onPress={() => void action("archive")}
            />
          </>
        )}
        {error ? <Notice error>{error}</Notice> : null}
      </Sheet>
    </>
  );
}
