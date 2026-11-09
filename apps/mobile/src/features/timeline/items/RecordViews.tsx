import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { ItemStatus, type ContextCompaction, type Image, type ProviderItem } from "@canopy/contracts";
import { humanizeEnum } from "@canopy/domain/humanize";
import { Markdown } from "../../../ui/markdown";
import { styles, useColors } from "../../../ui/theme";
import { ItemFrame } from "../ItemFrame";
import { CodeBlock } from "../CodeBlock";
import { prettyJson } from "@canopy/domain/format";
import { EmptyNote, ErrorText, RowTitle } from "./parts";
import { Chevron } from "../../../ui/MotionViews";
import { ImagePreview } from "../../attachments/ImagePreview";
import { useTimelineDirectory } from "../directory";

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
            source={{ kind: "thread", threadId: directory.currentId, ...image.blob }}
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

/** The provider summarised older context to make room (web: CompactionView): a rule with a label that opens the summary. */
export function CompactionView({ compaction }: { compaction: ContextCompaction }) {
  const c = useColors();
  const [open, setOpen] = useState(false);
  const line = <View style={{ flex: 1, height: 1, backgroundColor: c.rule }} />;

  return (
    <View style={{ gap: 8 }}>
      <View style={[styles.row, { gap: 12, minHeight: 40 }]}>
        {line}
        {compaction.summary ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: open }}
            onPress={() => setOpen(!open)}
            hitSlop={8}
          >
            <View style={[styles.row, { gap: 4, paddingHorizontal: 4 }]}>
              <Chevron open={open} size={14} color={c.faint} />
              <Text style={[styles.meta, { color: c.muted }]}>Context compacted</Text>
            </View>
          </Pressable>
        ) : (
          <Text style={[styles.meta, { color: c.muted }]}>Context compacted</Text>
        )}
        {line}
      </View>
      {open && <Markdown text={compaction.summary} color={c.muted} />}
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
