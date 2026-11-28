import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { ItemStatus, type ContextCompaction, type Image, type ProviderItem } from "@canopy/contracts";
import { humanizeEnum } from "@canopy/domain/humanize";
import { Markdown } from "../../../ui/markdown";
import { styles, useColors, useTypography } from "../../../ui/theme";
import { ItemFrame } from "../ItemFrame";
import { CodeBlock } from "../CodeBlock";
import { compactionLabel, prettyJson } from "@canopy/domain/format";
import { EmptyNote, ErrorText, RowTitle } from "./parts";
import { TimelineDisclosure } from "../TimelineDisclosure";
import { useAnchoredToggle } from "../../../ui/feed-anchor";
import { Chevron } from "../../../ui/MotionViews";
import { ImagePreview } from "../../attachments/ImagePreview";
import { useTimelineDirectory } from "../directory";
import { useItemContent } from "../item-content";
import { LazyItemContent } from "../LazyItemContent";

/** The same stored preview the model saw, with a full-screen viewer. */
export function ImageView({ image, status }: { image: Image; status: ItemStatus }) {
  const c = useColors();
  const directory = useTimelineDirectory();

  const label =
    image.source === "generated" ? "Generated image" : image.source === "view_image" ? "Viewed image" : "Image";

  const failed = status === ItemStatus.FAILED || Boolean(image.detail);

  return (
    <ItemFrame
      icon="photo"
      status={status}
      tone={failed ? "rose" : "neutral"}
      label={label}
      title={<RowTitle lead={label} subject={image.path || image.prompt || "generated"} mono={Boolean(image.path)} />}
    >
      {image.prompt ? <Text style={[styles.work, { color: c.soft }]}>{image.prompt}</Text> : null}
      {image.blob ? (
        <>
          <ImagePreview
            source={{ kind: "thread", threadId: directory.sourceId || directory.currentId, ...image.blob }}
            name={image.path.split(/[/\\]/).pop() || "image.png"}
            width={image.width}
            height={image.height}
          />
          {image.originalWidth && (image.originalWidth !== image.width || image.originalHeight !== image.height) ? (
            <Text style={[styles.workMeta, { color: c.muted }]}>
              {image.originalWidth}×{image.originalHeight} px, shown to the model at {image.width}×{image.height}.
            </Text>
          ) : null}
        </>
      ) : image.detail ? (
        <ErrorText text={image.detail} />
      ) : status !== ItemStatus.IN_PROGRESS ? (
        <EmptyNote>No preview of this image.</EmptyNote>
      ) : null}
    </ItemFrame>
  );
}

/** A conversation milestone with a label between two rules. */
export function TimelineDivider({ label }: { label: string }) {
  const c = useColors();
  const line = <View style={{ flex: 1, minWidth: 8, height: 1, backgroundColor: c.rule }} />;

  return (
    <View style={[styles.row, { gap: 12, minHeight: 40 }]}>
      {line}
      <Text style={[styles.meta, { color: c.muted, flexShrink: 1, textAlign: "center" }]}>{label}</Text>
      {line}
    </View>
  );
}

export function CompactionView({ compaction }: { compaction: ContextCompaction }) {
  const label = compactionLabel(compaction);

  return compaction.summary ? (
    <CompactionSummary label={label} summary={compaction.summary} />
  ) : (
    <TimelineDivider label={label} />
  );
}

const compactionStyles = StyleSheet.create({
  container: { width: "100%", maxWidth: 672, alignSelf: "center", paddingVertical: 4 },
  header: { alignSelf: "center", maxWidth: "100%" },
  button: { minHeight: 44, paddingVertical: 4, paddingHorizontal: 10, borderRadius: 8 },
  summary: {
    alignSelf: "center",
    maxWidth: "100%",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 12,
    gap: 4,
  },
});

function CompactionSummary({ label, summary }: { label: string; summary: string }) {
  const c = useColors();
  const type = useTypography();
  const lazy = useItemContent();
  const [open, setOpen] = useState(false);
  const { header, toggle } = useAnchoredToggle();

  return (
    <View style={compactionStyles.container}>
      <Animated.View ref={header} collapsable={false} style={compactionStyles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityState={{ expanded: open }}
          onPress={() => toggle(() => setOpen((previous) => !previous))}
          style={({ pressed }) => [
            styles.row,
            compactionStyles.button,
            { backgroundColor: pressed ? c.pressed : c.inset },
          ]}
        >
          <Text style={[type.small, { color: c.soft, flexShrink: 1 }]}>{label}</Text>
          <Chevron open={open} size={14} color={c.muted} />
        </Pressable>
      </Animated.View>
      <TimelineDisclosure open={open} style={{ paddingTop: 4 }}>
        <View style={[compactionStyles.summary, { backgroundColor: c.well }]}>
          <Markdown text={summary} color={c.soft} />
          {open && lazy && <LazyItemContent key={lazy.reference.sha256} {...lazy} auto subject="summary" />}
        </View>
      </TimelineDisclosure>
    </View>
  );
}

/** Provider event without a view of its own: its type in words and its JSON (web: ProviderItemView). */
export function ProviderItemView({ item, status }: { item: ProviderItem; status: ItemStatus }) {
  return (
    <ItemFrame
      icon="ellipsis-horizontal"
      status={status}
      label={`Provider event ${item.type}`}
      title={<RowTitle lead="Provider event" subject={humanizeEnum(item.type) || "Unknown"} />}
    >
      <CodeBlock text={prettyJson(item.json)} label="Event" />
    </ItemFrame>
  );
}
