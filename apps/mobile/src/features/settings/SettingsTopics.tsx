import { useCallback, useImperativeHandle, useState, type ReactNode, type Ref } from "react";
import { View } from "react-native";
import { Segmented } from "../../ui/Segmented";
import { useColors } from "../../ui/theme";
import { SettingsTopicMatches, useTopicMatches } from "./SettingsSearch";
import { createSettingsViewState } from "./SettingsScroll";

interface TopicOption<T extends string> {
  id: T;
  label: string;
}

interface Topic extends TopicOption<string> {
  content: ReactNode;
  hidden?: boolean;
}

const useSelectedTopic = createSettingsViewState<{ id: string; pattern?: RegExp | undefined }>({ id: "" });

export function SettingsTopicPicker<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly TopicOption<T>[];
  value: T;
  onChange: (id: T) => void;
}) {
  const colors = useColors("settings");

  if (options.length < 2) return null;

  return (
    <Segmented
      wrap
      options={options.map(({ id, label }) => ({ value: id, label }))}
      value={value}
      onChange={onChange}
      inactiveColor={colors.muted}
    />
  );
}

export function SettingsTopics({
  topics,
  defaultTopic,
  scopeKey,
  ref,
}: {
  topics: readonly Topic[];
  defaultTopic?: string;
  scopeKey?: string;
  ref?: Ref<{ selectTopic(id: string): void }>;
}) {
  const [selected, setSelected] = useSelectedTopic(scopeKey);
  const { query, pattern, counts, report } = useTopicMatches();
  const visible = topics.filter((topic) => !topic.hidden);
  const picked = visible.find((topic) => topic.id === selected.id);
  const initial = visible.find((topic) => topic.id === defaultTopic);
  let matched: Topic | undefined;
  let best = 0;

  if (pattern && !(picked && selected.pattern === pattern) && !initial) {
    for (const topic of visible) {
      if (topic.label.toLowerCase() === query) {
        matched = topic;
        break;
      }

      const score = counts.get(topic.id)?.size ?? 0;

      if (score > best) {
        best = score;
        matched = topic;
      }
    }
  }

  const active = matched ?? picked ?? initial ?? visible[0];

  const select = useCallback(
    (id: string) => {
      setSelected({ id, pattern });
    },
    [setSelected, pattern],
  );

  useImperativeHandle(ref, () => ({ selectTopic: select }), [select]);

  if (!active) return null;

  return (
    <View style={{ gap: 20 }}>
      <SettingsTopicPicker options={visible} value={active.id} onChange={select} />
      {visible.map((topic) => (
        <TopicPanel
          key={JSON.stringify([scopeKey, topic.id])}
          topic={topic}
          active={topic === active}
          searching={!!pattern}
          report={report}
        />
      ))}
    </View>
  );
}

function TopicPanel({
  topic,
  active,
  searching,
  report,
}: {
  topic: Topic;
  active: boolean;
  searching: boolean;
  report: ReturnType<typeof useTopicMatches>["report"];
}) {
  const [visited, setVisited] = useState(false);

  if (active && !visited) setVisited(true);

  if (!active && !visited && !searching) return null;

  return (
    <SettingsTopicMatches id={topic.id} label={topic.label} report={report}>
      <View style={{ display: active ? "flex" : "none", gap: 20 }}>{topic.content}</View>
    </SettingsTopicMatches>
  );
}
