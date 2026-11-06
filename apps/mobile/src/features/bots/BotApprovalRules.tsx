import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { bots } from "@canopy/contracts";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import Animated from "react-native-reanimated";
import { useMotion } from "../../ui/motion";
import { styles, useColors } from "../../ui/theme";

export function BotApprovalRules({ botId, selectedRule = "" }: { botId: string; selectedRule?: string }) {
  const { client } = useSession();
  const c = useColors();
  const [rules, setRules] = useState<bots.BotApprovalRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const { reveal, rise, layout } = useMotion();
  useEffect(() => {
    if (!client) return;
    let active = true;
    void client.api
      .listBotApprovalRules({ botId })
      .then((r) => {
        if (active) setRules(r.rules);
      })
      .catch(() => {
        if (active) setError("Could not load allowed actions. Reopen bot settings to retry.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [client, botId]);

  async function remove(id: string) {
    setBusy(id);
    setError("");

    try {
      await client!.api.deleteBotApprovalRule({ botId, ruleId: id });
      setRules((old) => old.filter((r) => r.id !== id));
    } catch {
      setError("Could not remove this rule. Try again.");
    } finally {
      setBusy("");
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Text style={[styles.heading, { color: c.text }]}>Allowed actions</Text>
      {loading ? (
        <Text style={[styles.meta, { color: c.muted }]}>Loading allowed actions…</Text>
      ) : rules.length ? (
        // Loaded rules resolve in; a removed rule fades out and the rest glide up (web `t-reveal`, `reorder`).
        rules.map((rule) => (
          <Animated.View
            key={rule.id}
            entering={reveal.entering}
            exiting={rise.exiting}
            layout={layout}
            style={{
              gap: 6,
              padding: 12,
              borderWidth: 1,
              borderRadius: 8,
              borderColor: rule.id === selectedRule ? c.accent : c.line,
            }}
          >
            <Text style={[styles.body, { color: c.text }]}>{rule.label}</Text>
            <Text style={[styles.meta, { color: c.muted }]}>
              Added from an approval card{rule.createdAt ? ` · ${timestampDate(rule.createdAt).toLocaleString()}` : ""}
            </Text>
            <Button
              title="Remove rule"
              disabled={!!busy}
              busy={busy === rule.id}
              onPress={() => void remove(rule.id)}
            />
          </Animated.View>
        ))
      ) : (
        <Text style={[styles.meta, { color: c.muted }]}>
          No allowed actions yet. Choose “Always allow” on an approval card to add a rule.
        </Text>
      )}
      {!loading && selectedRule && !rules.some((r) => r.id === selectedRule) && (
        <Notice>This rule is no longer active.</Notice>
      )}
      {error ? <Notice error>{error}</Notice> : null}
    </View>
  );
}
