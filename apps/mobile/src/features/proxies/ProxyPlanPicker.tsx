import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { proxyAutomaticPlanLabel, proxyPlanOptions } from "@canopy/domain/proxy-capacity";
import { useSession } from "../../state/session";
import { PickerSheet, SelectField } from "../../ui/Picker";
import { styles, useColors } from "../../ui/theme";

export function ProxyPlanPicker({
  proxyId,
  account,
  onRead,
}: {
  proxyId: string;
  account: ui.ProxyAccount;
  onRead: () => void;
}) {
  const { client } = useSession();
  const c = useColors();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(false);

  const options = [
    { value: 0, label: proxyAutomaticPlanLabel(account) },
    ...proxyPlanOptions(account.provider).map(({ plan, label }) => ({ value: plan, label })),
  ];

  const value = account.manualPlan ?? 0;

  async function choose(plan: ui.ProxyAccountPlan) {
    if (!client) return;
    setBusy(true);
    setFailure(false);

    try {
      await client.api.setProxyAccountPlan({ proxyId, accountKey: account.planKey, plan });
      onRead();
    } catch {
      setFailure(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 4, minWidth: 0 }}>
      <View style={[styles.row, { flexWrap: "wrap" }]}>
        <View style={{ flex: 1, minWidth: 0, maxWidth: 240 }}>
          <SelectField
            hideLabel
            label="Account plan"
            value={options.find((option) => option.value === value)?.label ?? "Automatic"}
            disabled={busy || !account.planKey}
            onPress={() => setOpen(true)}
          />
        </View>
        <Text
          accessibilityLiveRegion="polite"
          style={[styles.overlayMeta, { color: c.muted, minHeight: 20, width: 96 }]}
        >
          {busy ? "Saving plan…" : account.manualPlan !== undefined ? "Set manually" : ""}
        </Text>
      </View>
      {failure ? (
        <Text accessibilityRole="alert" style={[styles.overlayMeta, { color: c.danger }]}>
          Could not save the plan. Choose it again to retry.
        </Text>
      ) : null}
      <PickerSheet
        title="Account plan"
        visible={open}
        onClose={() => setOpen(false)}
        value={value}
        sections={[{ options }]}
        onSelect={(plan) => void choose(plan)}
      />
    </View>
  );
}
