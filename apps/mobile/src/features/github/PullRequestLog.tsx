import { useCallback } from "react";
import type { ReactNode } from "react";
import { FlatList, Text, View } from "react-native";
import { useSession } from "../../state/session";
import { useColors, useTypography } from "../../ui/theme";
import { Overlay } from "../../ui/Overlay";
import { SheetCloseButton } from "../../ui/SheetDragArea";
import { usePages } from "./usePages";
import { PageControls } from "./PageControls";
import type { github } from "@canopy/contracts";
import { prCitation } from "@canopy/domain";
import { CitationActions } from "./CitationActions";

export function PullRequestLog({
  id,
  snapshot,
  jobUrl,
  jobId,
  onClose,
  children,
  visible = true,
  onDismiss,
}: {
  id: string;
  snapshot: github.PullRequestSnapshot;
  jobUrl: string;
  jobId: string;
  onClose: () => void;
  children?: ReactNode;
  visible?: boolean;
  onDismiss?: () => void;
}) {
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
    <Overlay visible={visible} onClose={onClose} onDismiss={onDismiss} label="Job log">
      <View style={{ flexDirection: "row", alignItems: "center", padding: 12 }}>
        <Text style={[type.small, { flex: 1, color: c.text }]}>Job {jobId}</Text>
        {!!pages.current?.text && (
          <CitationActions
            quote={prCitation(snapshot, "log", jobId, pages.current.text, {
              firstLine: pages.current.firstLine,
              url: jobUrl,
            })}
          />
        )}
        {children}
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
