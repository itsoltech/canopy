import { useCallback } from "react";
import { FlatList, Text, View } from "react-native";
import { useSession } from "../../state/session";
import { useColors, useTypography } from "../../ui/theme";
import { Overlay } from "../../ui/Overlay";
import { SheetCloseButton } from "../../ui/SheetDragArea";
import { usePages } from "./usePages";
import { PageControls } from "./PageControls";

export function PullRequestLog({ id, jobId, onClose }: { id: string; jobId: string; onClose: () => void }) {
  const { client } = useSession();
  const c = useColors();
  const type = useTypography();

  const pages = usePages(
    useCallback(
      (cursor: string, refresh: boolean) =>
        client!.api.getPullRequestJobLog({ pullRequestId: id, resourceId: jobId, cursor, refresh }),
      [client, id, jobId],
    ),
  );

  return (
    <Overlay visible onClose={onClose} label="Job log">
      <View style={{ flexDirection: "row", alignItems: "center", padding: 12 }}>
        <Text style={[type.small, { flex: 1, color: c.text }]}>Job {jobId}</Text>
        <SheetCloseButton label="Close log" />
      </View>
      <FlatList
        data={(pages.current?.text ?? "").split("\n")}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={{ padding: 12 }}
        renderItem={({ item, index }) => (
          <Text selectable style={[type.mono, { color: c.text }]}>
            {(pages.current?.firstLine ?? 1) + index} {item}
          </Text>
        )}
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
      />
    </Overlay>
  );
}
