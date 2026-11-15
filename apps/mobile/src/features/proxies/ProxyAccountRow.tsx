import { Text, View } from "react-native";
import { create } from "@bufbuild/protobuf";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Provider, ProviderUsageSnapshotSchema, type ui } from "@canopy/contracts";
import { proxyAccountLook, proxyAccountMark, proxyPlanName, proxyProviderName } from "@canopy/domain/proxy-accounts";
import { proxyPlanWeight } from "@canopy/domain/proxy-capacity";
import { Badge } from "../../ui/Badge";
import { ProviderIcon } from "../../ui/ProviderIcon";
import { Sensitive } from "../../ui/Sensitive";
import { styles, useColors } from "../../ui/theme";
import { UsageMeters } from "../providers/UsageMeters";
import { ProxyPlanPicker } from "./ProxyPlanPicker";

export const markProvider = { CLAUDE: Provider.CLAUDE, CODEX: Provider.CODEX, GROK: Provider.GROK } as const;

const severity = (window: ui.ProxyAccount["windows"][number]) => (window.reached ? 100 : (window.usedPercent ?? -1));

/**
 * One upstream account of a proxy (web: ProxyAccountRow): provider mark, plan and its weight, the masked account,
 * status badge, cooldown end, the masked last message and the limits the proxy last saw. Compact (the usage
 * sheet) sorts the most used limit first and shows the badge only for a status other than Active.
 */
export function ProxyAccountRow({
  account,
  now,
  compact = false,
  proxyId,
  onRead,
}: {
  account: ui.ProxyAccount;
  now: number;
  compact?: boolean;
  proxyId?: string;
  onRead?: () => void;
}) {
  const c = useColors();
  const look = proxyAccountLook(account.status);
  const mark = proxyAccountMark(account.provider);
  const plan = proxyPlanName(account.plan);
  const weight = proxyPlanWeight(account);
  const windows = compact ? [...account.windows].sort((a, b) => severity(b) - severity(a)) : account.windows;
  const usage = create(ProviderUsageSnapshotSchema, { windows });

  const until = account.retryAt
    ? `Until ${timestampDate(account.retryAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
    : "";

  return (
    <View style={{ gap: 6, paddingVertical: 8, minWidth: 0 }}>
      <View style={[styles.row, { minWidth: 0 }]}>
        {mark ? (
          <ProviderIcon provider={markProvider[mark]} />
        ) : (
          <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted, maxWidth: 96 }]}>
            {proxyProviderName(account.provider)}
          </Text>
        )}
        {!proxyId || !onRead ? (
          <Text numberOfLines={1} style={[styles.overlayMeta, { color: c.muted, maxWidth: 96, flexShrink: 0 }]}>
            {plan ?? "Unknown plan"}
            {weight.unknown ? "" : ` · ×${weight.units}`}
          </Text>
        ) : null}
        <View style={{ flex: 1, minWidth: 0 }}>
          {account.label ? (
            <Sensitive
              value={account.label}
              label="Account identity"
              numberOfLines={1}
              style={[styles.overlayHeading, { color: c.text }]}
            />
          ) : (
            <Text style={[styles.overlayHeading, { color: c.text }]}>Unnamed account</Text>
          )}
        </View>
        {!compact || account.status !== "active" ? <Badge tone={look.tone}>{look.label}</Badge> : null}
      </View>
      {proxyId && onRead ? <ProxyPlanPicker {...{ proxyId, account, onRead }} /> : null}
      {plan && weight.unknown ? (
        <Text style={[styles.overlayMeta, { color: c.muted }]}>Unknown plan · capacity counted as ×1</Text>
      ) : null}
      {until || account.detail ? (
        <Text numberOfLines={2} style={[styles.overlayMeta, { color: c.muted }]}>
          {until}
          {until && account.detail ? " " : ""}
          {account.detail ? <Sensitive value={account.detail} label="Account details" /> : null}
        </Text>
      ) : null}
      <UsageMeters usage={usage} now={now} />
    </View>
  );
}
