import { useCallback, useState, type ReactNode } from "react";
import { FlatList, Pressable, Text, View } from "react-native";
import * as Linking from "expo-linking";
import { github } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { timelineLook } from "@canopy/domain/github-pr";
import { toneColor } from "./presentation";
import { safeHref } from "@canopy/domain/markdown";
import { useSession } from "../../state/session";
import { Markdown } from "../../ui/markdown/Markdown";
import { PickerSheet } from "../../ui/Picker";
import { TextInput } from "../../ui/TextInput";
import { Button } from "../../ui/components";
import { Icon } from "../../ui/Icon";
import { useColors, useTypography } from "../../ui/theme";
import { useContentPadding } from "../../ui/ScreenFrame";
import { usePages } from "./usePages";
import { PageControls } from "./PageControls";
import { PullRequestReviews } from "./PullRequestReviews";
import { StatusIcon } from "./StatusIcon";

export function PullRequestTimeline({ id, header }: { id: string; header: ReactNode }) {
  const { client } = useSession();
  const padding = useContentPadding();
  const [kind, setKind] = useState("");
  const [author, setAuthor] = useState("");
  const [oldestFirst, setOldest] = useState(false);
  const [picker, setPicker] = useState(false);
  const [reviews, setReviews] = useState(false);

  const load = useCallback(
    (cursor: string, refresh: boolean) =>
      client!.api.listPullRequestTimeline({ pullRequestId: id, cursor, refresh, kind, author, oldestFirst }),
    [client, id, kind, author, oldestFirst],
  );

  const pages = usePages(load, id);

  return (
    <>
      <FlatList
        data={pages.current?.items ?? []}
        keyExtractor={(item, index) => item.content.value?.id ?? String(index)}
        contentContainerStyle={{ ...padding, gap: 16 }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            {header}
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              <Button title={kind || "All events"} variant="ghost" onPress={() => setPicker(true)} />
              <Button
                title={oldestFirst ? "Oldest first" : "Newest first"}
                variant="ghost"
                onPress={() => setOldest(!oldestFirst)}
              />
            </View>
            <TextInput
              accessibilityLabel="Filter by author"
              placeholder="Author login"
              value={author}
              onChangeText={setAuthor}
            />
            <Button
              title={reviews ? "Hide review threads" : "Review threads"}
              variant="ghost"
              onPress={() => setReviews(!reviews)}
            />
            {reviews && <PullRequestReviews id={id} />}
          </View>
        }
        ListFooterComponent={
          <PageControls
            page={pages.current?.page}
            busy={pages.busy}
            error={pages.error}
            previous={pages.previous}
            next={() => void pages.read(true)}
            retry={() => void pages.read(false, true)}
          />
        }
        renderItem={({ item }) => <TimelineRow item={item} />}
      />
      <PickerSheet
        title="Timeline type"
        visible={picker}
        value={kind}
        onClose={() => setPicker(false)}
        onSelect={(v) => {
          setKind(v);
          setPicker(false);
        }}
        sections={[
          {
            options: [
              { value: "", label: "All events" },
              { value: "comment", label: "Comments" },
              { value: "review", label: "Reviews" },
              { value: "commit", label: "Commits" },
              { value: "event", label: "Events" },
            ],
          },
        ]}
      />
    </>
  );
}

function TimelineRow({ item }: { item: github.PullRequestTimelineItem }) {
  const c = useColors();
  const type = useTypography();
  const entry = item.content.value;

  if (!entry) return null;
  const look = timelineLook(entry.kind, entry.state, item.content.case);

  return (
    <View style={{ gap: 8, borderBottomWidth: 1, borderColor: c.line, paddingBottom: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StatusIcon name={look.icon} label={look.label} color={toneColor(c, look.tone)} />
        <Text style={[type.small, { flex: 1, color: c.text }]}>{entry.author}</Text>
        <Pressable
          accessibilityRole="link"
          accessibilityLabel="Open event on GitHub"
          style={{ minHeight: 48, justifyContent: "center" }}
          onPress={() => {
            const href = safeHref(entry.url);

            if (href) void Linking.openURL(href);
          }}
        >
          <Icon name="arrow-top-right-on-square" />
        </Pressable>
      </View>
      {entry.createdAt && (
        <Text style={[type.meta, { color: c.muted }]}>{timestampDate(entry.createdAt).toLocaleString()}</Text>
      )}
      {!!entry.body && <Markdown text={entry.body} />}
      {!!entry.sha && (
        <Text selectable style={[type.mono, { color: c.muted }]}>
          {entry.sha.slice(0, 12)}
        </Text>
      )}
    </View>
  );
}
