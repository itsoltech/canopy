import { useCallback, useState, type ReactNode } from "react";
import { FlatList, Text, View } from "react-native";
import { activityFilters, pullRequestActivity } from "@canopy/domain/github-read";
import { useSession } from "../../state/session";
import { PickerSheet } from "../../ui/Picker";
import { Button } from "../../ui/components";
import { useColors, useTypography } from "../../ui/theme";
import { useContentPadding } from "../../ui/ScreenFrame";
import { usePages } from "./usePages";
import { PageStatus } from "./PageStatus";
import { ActivityRow } from "./ActivityRow";
import { IconAction } from "./IconAction";
import type { github } from "@canopy/contracts";
import { CommentComposer } from "./CommentComposer";

function useTimelineRead(id: string, kind: string, oldestFirst: boolean) {
  const { client } = useSession();

  const pages = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.listPullRequestTimeline({ pullRequestId: id, cursor, refresh, kind, oldestFirst }),
      [client, id, kind, oldestFirst],
    ),
    id,
    `${id}:reviews`,
  );

  const reviews = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.listPullRequestReviewThreads({ pullRequestId: id, cursor, refresh }),
      [client, id],
    ),
    id,
    `${id}:reviews`,
  );

  return { pages, reviews };
}

export function PullRequestTimeline({
  id,
  snapshot,
  header,
}: {
  id: string;
  snapshot: github.PullRequestSnapshot;
  header: ReactNode;
}) {
  const padding = useContentPadding(),
    c = useColors(),
    type = useTypography();

  const [kind, setKind] = useState(""),
    [oldestFirst, setOldest] = useState(false),
    [picker, setPicker] = useState(false);

  const includeThreads = !kind || kind === "review";
  const { pages, reviews } = useTimelineRead(id, kind, oldestFirst);

  const rows = pullRequestActivity(
    pages.pages.flatMap((p) => p.items),
    includeThreads ? reviews.pages.flatMap((p) => p.threads) : [],
    oldestFirst,
  );

  async function more() {
    if (pages.current?.page?.nextCursor) await pages.read(true);

    if (includeThreads && reviews.current?.page?.nextCursor) await reviews.read(true);
  }

  return (
    <>
      <FlatList
        data={rows}
        keyExtractor={(row) => row.key}
        contentContainerStyle={padding}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            {header}
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                borderBottomWidth: 1,
                borderColor: c.line,
              }}
            >
              <Button
                title={activityFilters.find((f) => f.value === kind)?.label ?? "All activity"}
                variant="ghost"
                onPress={() => setPicker(true)}
              />
              <IconAction
                icon={oldestFirst ? "arrow-up" : "arrow-down"}
                label={oldestFirst ? "Oldest first" : "Newest first"}
                selected={oldestFirst}
                onPress={() => setOldest(!oldestFirst)}
              />
            </View>
          </View>
        }
        renderItem={({ item }) => <ActivityRow id={id} snapshot={snapshot} row={item} />}
        ListEmptyComponent={
          pages.current ? <Text style={[type.meta, { color: c.muted }]}>No matching activity</Text> : undefined
        }
        ListFooterComponent={
          <View style={{ gap: 8, paddingTop: 16 }}>
            {(!!pages.current?.page?.nextCursor || (includeThreads && !!reviews.current?.page?.nextCursor)) && (
              <Button
                title="Show more activity"
                variant="ghost"
                disabled={pages.busy || reviews.busy}
                onPress={() => void more()}
              />
            )}
            <PageStatus
              page={pages.current?.page}
              busy={pages.busy}
              error={pages.error}
              retry={() => void pages.read(false, true)}
            />
            {includeThreads && (
              <PageStatus
                page={reviews.current?.page}
                busy={reviews.busy}
                error={reviews.error}
                retry={() => void reviews.read(false, true)}
              />
            )}
            <CommentComposer key={`${snapshot.accountId}:${id}`} snapshot={snapshot} />
          </View>
        }
      />
      <PickerSheet
        title="Activity filter"
        visible={picker}
        value={kind}
        onClose={() => setPicker(false)}
        onSelect={(value) => {
          setKind(value);
          setPicker(false);
        }}
        sections={[{ options: activityFilters }]}
      />
    </>
  );
}
