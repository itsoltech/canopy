import { useEffect } from "react";
import { Text, View } from "react-native";
import { timestampDate } from "@bufbuild/protobuf/wkt";
import type { ui } from "@canopy/contracts";
import { formatRelative } from "@canopy/domain/format";
import { usageWindowName } from "@canopy/domain/provider-usage";
import {
  proxyAccountLook,
  proxyAccountsHint,
  proxyAccountsSummary,
  proxyProviderName,
} from "@canopy/domain/proxy-accounts";
import { useSession } from "../../state/session";
import { Button } from "../../ui/components";
import { styles, useColors } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { SettingsActions, SettingsRow } from "./SettingsGroup";

const percent = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

/** The limits the proxy last saw, in words: "5-hour 42% · Weekly 7%". */
const limits = (account: ui.ProxyAccount) =>
  account.windows
    .map((w) => `${usageWindowName(w.key)} ${w.usedPercent === undefined ? "" : `${percent.format(w.usedPercent)}%`}`)
    .join(" · ");

function AccountRow({ account }: { account: ui.ProxyAccount }) {
  const c = useColors();
  const look = proxyAccountLook(account.status);
  const tone = useTone(look.tone).text;

  const until = account.retryAt
    ? `Until ${timestampDate(account.retryAt).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
    : "";

  const details = [limits(account), until, account.detail].filter(Boolean).join(" · ");

  return (
    <View style={{ gap: 2 }}>
      <Text style={[styles.chrome, { color: c.text }]} numberOfLines={1}>
        {proxyProviderName(account.provider)} · {account.label || "Unnamed account"} ·{" "}
        <Text style={{ color: tone }}>{look.label}</Text>
      </Text>
      {details ? (
        <Text style={[styles.chrome, { color: c.muted }]} numberOfLines={2}>
          {details}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * A CLIProxyAPI proxy's upstream accounts, read-only (web: ProxyAccounts). Opening the screen asks the gateway once;
 * a read under a minute old answers without calling the proxy. Changes arrive with the overview stream.
 */
export function ProxyAccounts({ proxy, onRefresh, busy }: { proxy: ui.Proxy; onRefresh: () => void; busy: boolean }) {
  const c = useColors();
  const { client } = useSession();
  const accounts = proxy.accounts;
  const hint = proxyAccountsHint(accounts, proxy.managementKeySet);

  useEffect(() => {
    if (proxy.managementKeySet && proxy.id) void client?.api.refreshProxyAccounts({ id: proxy.id }).catch(() => {});
  }, [client, proxy.id, proxy.managementKeySet]);

  return (
    <SettingsRow
      title={accounts?.state === "ok" ? `Accounts · ${accounts.total}` : "Accounts"}
      description={
        hint ?? (accounts?.checkedAt ? `Checked ${formatRelative(accounts.checkedAt)}` : "Reading accounts…")
      }
    >
      <View style={{ gap: 8 }}>
        {accounts?.state === "ok" &&
          accounts.accounts.map((account) => <AccountRow key={account.id} account={account} />)}
        {accounts?.state === "ok" && !accounts.accounts.length && (
          <Text style={[styles.chrome, { color: c.muted }]}>The proxy has no accounts yet.</Text>
        )}
      </View>
      {proxy.managementKeySet && (
        <SettingsActions>
          <Button title="Refresh accounts" busy={busy} onPress={onRefresh} />
        </SettingsActions>
      )}
    </SettingsRow>
  );
}

/** "Through <proxy> · 2 Codex accounts · 1 cooling down" for a proxy-backed instance. */
export function proxyThrough(instance: ui.ProviderInstance, proxies: readonly ui.Proxy[] | undefined) {
  const proxy = proxies?.find((p) => p.id === instance.proxyId);

  if (!proxy) return "";

  const summary =
    proxy.kind === "cliproxyapi"
      ? (proxyAccountsSummary(proxy.accounts, instance.harness) ??
        proxyAccountsHint(proxy.accounts, proxy.managementKeySet))
      : undefined;

  return [`Through ${proxy.name}`, summary].filter(Boolean).join(" · ");
}
