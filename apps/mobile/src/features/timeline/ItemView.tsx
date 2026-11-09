import type { ReactNode } from "react";
import { View } from "react-native";
import { ItemStatus } from "@canopy/contracts";
import type { ItemNode } from "./item-nodes";
import { useColors } from "../../ui/theme";
import { AgentMessageView } from "./AgentMessageView";
import { ItemChildren } from "./ItemFrame";
import { AgentBusCallView } from "./items/AgentBusCallView";
import { BackgroundTaskView } from "./items/BackgroundTaskView";
import { ChecklistView } from "./items/ChecklistView";
import { CommandView } from "./items/CommandView";
import { FileChangeView } from "./items/FileChangeView";
import { InteractionPromptView } from "./items/InteractionPromptView";
import { ReasoningView } from "./items/ReasoningView";
import { CompactionView, ImageView, ProviderItemView } from "./items/RecordViews";
import { SubagentView } from "./items/SubagentView";
import { ToolCallView } from "./items/ToolCallView";
import { WebSearchView } from "./items/WebSearchView";
import { UserMessageView } from "./UserMessageView";
import { QuoteItem } from "../quotes/QuoteAction";

export { itemNodes, type ItemNode } from "./item-nodes";

const INLINE = new Set(["userMessage", "agentMessage", "reasoning", "contextCompaction"]);

/**
 * One transcript item; every type has a view (web: ItemView). `turnEnded`: its turn is over, so an item still
 * marked in progress stops streaming.
 */
export function ItemView({ node, turnEnded = false }: { node: ItemNode; turnEnded?: boolean }) {
  const c = useColors();
  const { item } = node;
  const content = item.content;
  const streaming = item.status === ItemStatus.IN_PROGRESS && !turnEnded;

  const nested: ReactNode = node.children.length ? (
    <>
      {node.children.map((child) => (
        <ItemView key={child.item.itemId} node={child} turnEnded={turnEnded} />
      ))}
    </>
  ) : undefined;

  const inline = INLINE.has(content.case ?? "");
  // A subagent shows its work itself, between its prompt and result.
  const framed = inline || content.case === "subagent" ? undefined : nested;
  let view: ReactNode = null;

  switch (content.case) {
    case "userMessage":
      view = (
        <UserMessageView
          text={content.value.text}
          mentions={content.value.mentions}
          fromAgent={Boolean(content.value.authorAgentId)}
        />
      );
      break;
    case "agentMessage":
      view = <AgentMessageView message={content.value} streaming={streaming} />;
      break;
    case "reasoning":
      view = <ReasoningView reasoning={content.value} streaming={streaming} />;
      break;
    case "commandExecution":
      view = <CommandView command={content.value} status={item.status} />;
      break;
    case "fileChange":
      view = <FileChangeView change={content.value} status={item.status} />;
      break;
    case "toolCall":
      view = <ToolCallView call={content.value} status={item.status} />;
      break;
    case "webSearch":
      view = <WebSearchView search={content.value} status={item.status} />;
      break;
    case "plan":
      view = <ChecklistView title="Plan" text={content.value.text} steps={content.value.steps} status={item.status} />;
      break;
    case "todoList":
      view = <ChecklistView title="To do" steps={content.value.items} status={item.status} />;
      break;
    case "subagent":
      view = <SubagentView agent={content.value} status={item.status} nested={nested} />;
      break;
    case "backgroundTask":
      view = <BackgroundTaskView task={content.value} itemId={item.itemId} status={item.status} />;
      break;
    case "agentBusCall":
      view = <AgentBusCallView call={content.value} status={item.status} />;
      break;
    case "image":
      view = <ImageView image={content.value} status={item.status} />;
      break;
    case "contextCompaction":
      view = <CompactionView compaction={content.value} />;
      break;
    case "interactionPrompt":
      view = <InteractionPromptView prompt={content.value} status={item.status} />;
      break;
    case "providerItem":
      view = <ProviderItemView item={content.value} status={item.status} />;
      break;
  }

  return (
    <QuoteItem.Provider value={item.itemId}>
      <View>
        <ItemChildren.Provider value={framed}>{view}</ItemChildren.Provider>
        {nested && inline ? (
          <View style={{ marginTop: 4, gap: 4, borderLeftWidth: 2, borderColor: c.rule, paddingLeft: 12 }}>
            {nested}
          </View>
        ) : null}
      </View>
    </QuoteItem.Provider>
  );
}
