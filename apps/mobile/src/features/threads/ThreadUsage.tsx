import { Text, View } from "react-native";
import type { Usage, ui } from "@canopy/contracts";
import { orderThreadTurns } from "@canopy/domain/history-pages";
import { styles, useColors } from "../../ui/theme";

/** Loaded own turns match the web totals; inherited history is never charged to this thread. */
export function ThreadUsage({ snapshot, live }: { snapshot: ui.ThreadSnapshot; live?: Usage }) {
  const c = useColors();
  const turns = orderThreadTurns(snapshot.turns.filter((turn) => !turn.inherited && !turn.withdrawn));

  const totals = turns.reduce(
    (sum, turn) => ({
      input: sum.input + (turn.usage?.inputTokens ?? 0n),
      output: sum.output + (turn.usage?.outputTokens ?? 0n),
      cached: sum.cached + (turn.usage?.cachedInputTokens ?? 0n),
      cost: sum.cost + (turn.usage?.costUsd ?? 0),
    }),
    { input: 0n, output: 0n, cached: 0n, cost: 0 },
  );

  const usage = live ?? turns.findLast((turn) => turn.usage)?.usage;
  const count = (n: bigint) => n.toLocaleString();

  return (
    <View style={{ gap: 6 }}>
      <Text style={[styles.label, { color: c.text }]}>Usage{snapshot.historyHasMore ? " · loaded turns" : ""}</Text>
      <Text selectable style={[styles.meta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
        {count(totals.input)} input · {count(totals.output)} output · {count(totals.cached)} cached
      </Text>
      <Text selectable style={[styles.meta, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
        {new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 3 }).format(
          totals.cost,
        )}
        {usage && usage.contextWindowTokens > 0n
          ? ` · Context window: ${count(usage.contextWindowTokens)} tokens`
          : " · Context window unavailable"}
      </Text>
    </View>
  );
}
