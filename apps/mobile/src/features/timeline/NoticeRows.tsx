import { useState } from "react";
import { Text, View } from "react-native";
import { ItemStatus, NoticeLevel, type Notice } from "@canopy/contracts";
import { backgroundHeadline, backgroundOutcome, backgroundTitle } from "@canopy/domain/background-tasks";
import { noticePresentation } from "@canopy/domain/notice-presentation";
import type { NoticeState } from "@canopy/domain/turn-notices";
import { Icon } from "../../ui/Icon";
import { font, styles, useColors } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { useTimelineDirectory } from "./directory";
import { CodeBlock, MoreButton } from "./CodeBlock";

/** Platform or provider notice (rate limit, retry, restart, provider error) (web: NoticeRow). */
export function NoticeRow({ notice, state = {} }: { notice: Notice; state?: NoticeState }) {
  const c = useColors();
  const rose = useTone("rose").panel;
  const amber = useTone("amber").panel;
  const presentation = noticePresentation(notice, state);
  const level = presentation.level ?? notice.level;
  const error = level === NoticeLevel.ERROR;
  const warning = level === NoticeLevel.WARNING;
  const look = error ? rose : warning ? amber : { background: c.well, text: c.soft };
  const [open, setOpen] = useState(false);

  return (
    <View
      accessibilityRole={error ? "alert" : undefined}
      style={[
        styles.row,
        {
          alignItems: "flex-start",
          borderRadius: 8,
          paddingHorizontal: state.recovered ? 0 : 12,
          paddingVertical: state.recovered ? 4 : 8,
          backgroundColor: state.recovered ? undefined : look.background,
        },
      ]}
    >
      <View style={{ height: 24, justifyContent: "center", opacity: 0.7 }}>
        <Icon
          name={error ? "exclamation-circle" : warning ? "exclamation-triangle" : "information-circle"}
          color={look.text}
        />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
        <Text selectable style={[state.recovered ? styles.work : styles.body, { color: look.text }]}>
          {presentation.message}
          {presentation.count > 1 ? ` ×${presentation.count}` : ""}
        </Text>
        {presentation.details ? (
          <>
            <MoreButton expanded={open} onPress={() => setOpen(!open)}>
              Show details
            </MoreButton>
            {open && <CodeBlock text={presentation.details} label="Error details" />}
          </>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The platform told the agent how background tasks of this thread ended (a turn of its own, or a note steered into
 * the running turn): one compact system line per task (web: BackgroundNoteRow).
 */
export function BackgroundNoteRow({ itemIds }: { itemIds: readonly string[] }) {
  const c = useColors();
  const directory = useTimelineDirectory();

  return (
    <View style={{ gap: 4 }}>
      {itemIds.map((id) => {
        const item = directory.item(id);
        const task = item?.content.case === "backgroundTask" ? item.content.value : undefined;
        const title = task ? backgroundTitle(task, id) : id;

        const outcome =
          task && item
            ? backgroundHeadline(backgroundOutcome(ItemStatus[item.status]), task.stopReason, task.exitCode)
            : "Background task ended";

        return (
          <View key={id} style={{ flexDirection: "row", gap: 8 }}>
            <View style={{ height: 20, justifyContent: "center" }}>
              <Icon name="bolt" size={14} color={c.muted} />
            </View>
            <Text style={[styles.meta, { flex: 1, color: c.muted }]}>
              {outcome} · <Text style={{ fontFamily: font.medium, color: c.soft }}>{title}</Text>
            </Text>
          </View>
        );
      })}
    </View>
  );
}
