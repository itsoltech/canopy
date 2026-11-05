import { ScrollView } from "react-native";
import { router } from "expo-router";
import type { ui } from "@canopy/contracts";
import { ComposerPill } from "./ComposerBox";

const active = (t: ui.Thread) =>
  ["running", "creating", "waiting_input"].includes(t.status) || t.pendingInteractions > 0;

/**
 * Subagents of the thread above the composer: those still working, each opening its thread; finished ones stay
 * out of the way as one count that opens the thread's details (its lineage lists them).
 */
export function SubagentStrip({ subagents, onFinished }: { subagents: ui.Thread[]; onFinished: () => void }) {
  const working = subagents.filter(active);
  const finished = subagents.length - working.length;

  if (!subagents.length) return null;

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 4 }}>
      {working.map((t) => (
        <ComposerPill
          key={t.id}
          icon={t.pendingInteractions > 0 || t.status === "waiting_input" ? "hand-raised" : "arrow-path"}
          title={t.title || "Subagent"}
          warning={t.pendingInteractions > 0 || t.status === "waiting_input"}
          onPress={() => router.push({ pathname: "/thread/[id]", params: { id: t.id } })}
        />
      ))}
      {finished > 0 && (
        <ComposerPill
          icon="user-group"
          title={`${finished} finished ${finished === 1 ? "subagent" : "subagents"}`}
          onPress={onFinished}
        />
      )}
    </ScrollView>
  );
}
