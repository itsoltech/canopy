import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { ItemStatus, Subagent, TaskProgress } from "@canopy/contracts";
import { formatCount, formatDuration } from "@canopy/domain/format";
import { humanizeToolName } from "@canopy/domain/humanize";
import { Badge } from "../../../ui/Badge";
import { Markdown } from "../../../ui/markdown";
import { font, styles, useColors } from "../../../ui/theme";
import { ItemFrame } from "../ItemFrame";
import { Aside, RowTitle, useRoomyRows } from "./parts";

/**
 * "12 tools · 8.1K tokens · 1m 4s" for subagents and background tasks (web: TaskProgressText), in the row from 640 dp
 * on, like the web.
 */
export function progressText(progress: TaskProgress | undefined): string {
  if (!progress) return "";

  return [
    progress.toolUses > 0 && `${progress.toolUses} ${progress.toolUses === 1 ? "tool" : "tools"}`,
    progress.totalTokens > 0n && `${formatCount(progress.totalTokens)} tokens`,
    progress.durationMs > 0n && formatDuration(progress.durationMs),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The provider's own subagent (inside this thread, not a side thread): prompt, nested work, result (web: SubagentView). */
export function SubagentView({ agent, status, nested }: { agent: Subagent; status: ItemStatus; nested?: ReactNode }) {
  const c = useColors();
  const name = humanizeToolName(agent.agentType) || "Subagent";
  const progress = progressText(agent.progress);
  const roomy = useRoomyRows();

  return (
    <ItemFrame
      icon="user-group"
      status={status}
      label={[name, agent.description].filter(Boolean).join(" ")}
      title={<RowTitle lead={name} subject={agent.description} />}
      aside={
        <>
          {agent.background && <Badge>Background</Badge>}
          {progress && roomy ? <Aside>{progress}</Aside> : null}
        </>
      }
    >
      {agent.prompt ? (
        <View style={{ borderRadius: 8, backgroundColor: c.well, padding: 12, gap: 4 }}>
          <Text style={[styles.workMeta, { fontFamily: font.medium, color: c.muted }]}>
            Prompt{agent.model ? ` · ${agent.model}` : ""}
          </Text>
          <Markdown text={agent.prompt} />
        </View>
      ) : null}
      {nested ? (
        <View style={{ gap: 4, borderLeftWidth: 2, borderColor: c.rule, paddingLeft: 12 }}>{nested}</View>
      ) : null}
      {agent.result ? (
        <View style={{ gap: 4 }}>
          <Text style={[styles.workMeta, { fontFamily: font.medium, color: c.muted }]}>Result</Text>
          <Markdown text={agent.result} />
        </View>
      ) : null}
    </ItemFrame>
  );
}
