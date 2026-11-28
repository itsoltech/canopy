import { Text, View } from "react-native";
import type { bots } from "@canopy/contracts";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { PanelRow } from "../threads/ThreadPanel";

/** Parked cards of background runs that wait for the owner, each with a way to it in the chat. */
export function BotWaitingCards({
  approvals,
  onReveal,
}: {
  approvals: readonly bots.BotApproval[];
  onReveal: (approvalId: string) => void;
}) {
  const c = useColors();
  const waiting = approvals.filter((a) => a.parked && a.status === "pending");

  if (!waiting.length) return null;

  return (
    <>
      <Text style={[styles.heading, { color: c.text }]}>Waiting for you</Text>
      <Text style={[styles.meta, { color: c.muted }]}>Your answer or decision starts a new background run.</Text>
      {waiting.map((card) => (
        <View key={card.id} style={{ gap: 8 }}>
          <PanelRow
            title={`${card.kind === "question" ? "Question" : "Approval"} from ${
              card.routineTitle
                ? `${card.routineKind === "trigger" ? "event trigger" : "routine"} “${card.routineTitle}”`
                : "a reminder"
            }`}
            value={
              card.kind === "question"
                ? card.prompt
                : (card.prompt.split("\n", 1)[0] ?? "").replace(/^Needs approval · /, "") || "Approve an action"
            }
            icon={card.kind === "question" ? "hand-raised" : "shield-exclamation"}
          />
          <View style={styles.row}>
            <Button title="Show in chat" onPress={() => onReveal(card.id)} />
          </View>
        </View>
      ))}
    </>
  );
}
