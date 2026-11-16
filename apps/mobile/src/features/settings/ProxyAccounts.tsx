import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { formatRelative } from "@canopy/domain/format";
import { proxyAccountsHint } from "@canopy/domain/proxy-accounts";
import { supportedProxyAccounts, unsupportedProxyAccountText } from "@canopy/domain/proxy-capacity";
import { useSession } from "../../state/session";
import { Button, Notice } from "../../ui/components";
import { font, styles, useColors } from "../../ui/theme";
import { useTimeLabel } from "../../ui/time";
import { ProxyAccountRow } from "../proxies/ProxyAccountRow";

/**
 * The upstream accounts of a CLIProxyAPI proxy (web: ProxyAccounts), read by the gateway with the stored management
 * key. Opening the card asks once (a read under a minute old answers without calling the proxy); Refresh reads now.
 * Later changes arrive with the overview stream.
 */
export function ProxyAccounts({ proxy, onRead }: { proxy: ui.Proxy; onRead: () => void }) {
  const c = useColors();
  const { client } = useSession();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const minute = useTimeLabel((now) => String(Math.floor(now / 60_000)), true);
  const now = Number(minute) * 60_000;
  const accounts = proxy.accounts;
  const supported = supportedProxyAccounts(accounts?.accounts ?? []);
  const unsupported = (accounts?.accounts.length ?? 0) - supported.length;
  const hint = proxyAccountsHint(accounts, proxy.managementKeySet);
  const meta = [styles.workMeta, { color: c.muted }];

  useEffect(() => {
    if (proxy.managementKeySet && proxy.id) void client?.api.refreshProxyAccounts({ id: proxy.id }).catch(() => {});
  }, [client, proxy.id, proxy.managementKeySet]);

  async function refresh() {
    if (!client) return;
    setBusy(true);
    setFailure("");

    try {
      await client.api.refreshProxyAccounts({ id: proxy.id, force: true });
      onRead();
    } catch {
      setFailure("Could not read the proxy's accounts. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 8, minWidth: 0 }}>
      <View style={[styles.row, { justifyContent: "space-between" }]}>
        <Text accessibilityRole="header" style={[styles.chrome, { fontFamily: font.medium, color: c.text }]}>
          Accounts
          {accounts?.state === "ok" ? (
            <Text style={{ fontFamily: font.regular, color: c.muted }}>{` · ${supported.length}`}</Text>
          ) : null}
        </Text>
        {proxy.managementKeySet ? (
          <Button
            size="sm"
            icon="arrow-path"
            title="Refresh"
            label="Refresh accounts"
            busy={busy}
            onPress={() => void refresh()}
          />
        ) : null}
      </View>
      {hint ? <Text style={[styles.chrome, { color: c.muted }]}>{hint}</Text> : null}
      {failure ? <Notice error>{failure}</Notice> : null}
      {accounts?.state === "ok" && supported.length > 0 && (
        <View
          accessibilityLabel={`Accounts of ${proxy.name}`}
          style={{ borderWidth: 1, borderColor: c.ring, borderRadius: 10, paddingHorizontal: 12 }}
        >
          {supported.map((account, index) => (
            <View
              key={account.id}
              style={{ borderTopWidth: index ? StyleSheet.hairlineWidth : 0, borderColor: c.ring }}
            >
              <ProxyAccountRow account={account} now={now} proxyId={proxy.id} onRead={onRead} />
            </View>
          ))}
        </View>
      )}
      {accounts?.state === "ok" && supported.some((account) => account.windows.length) ? (
        <Text style={meta}>
          Pace compares the latest reported usage with even use until reset. Slow usage when ahead of pace. Differences
          use percentage points (pp).
        </Text>
      ) : null}
      {accounts?.state === "ok" && supported.length > 0 && accounts.total > accounts.accounts.length && (
        <Text style={meta}>
          Showing {accounts.accounts.length} of {accounts.total}.
        </Text>
      )}
      {accounts?.state === "ok" && !supported.length && !unsupported && (
        <Text style={[styles.chrome, { color: c.muted }]}>The proxy has no accounts yet.</Text>
      )}
      {accounts?.state === "ok" && unsupported > 0 && (
        <Text style={meta}>{unsupportedProxyAccountText(unsupported)}</Text>
      )}
      {accounts?.checkedAt ? <Text style={meta}>Checked {formatRelative(accounts.checkedAt)}</Text> : null}
    </View>
  );
}
