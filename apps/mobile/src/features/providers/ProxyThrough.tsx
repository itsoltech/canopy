import { useEffect } from "react";
import { Text } from "react-native";
import type { ui } from "@canopy/contracts";
import { proxyAccountsHint, proxyAccountsSummary } from "@canopy/domain/proxy-accounts";
import { useSession } from "../../state/session";
import { styles, useColors } from "../../ui/theme";
import { openSettingsSection } from "../settings/navigation";
import { useSettingsResource } from "../settings/resource";

/**
 * Which proxy an instance runs through and a summary of that proxy's accounts for this harness (web: ProxyThrough).
 * A proxy's plan limits belong to its upstream accounts, so this replaces the plan meters; details are on the proxy.
 */
export function ProxyThrough({ instance }: { instance: ui.ProviderInstance }) {
  const c = useColors();
  const { client } = useSession();
  const proxies = useSettingsResource("ListProxies", (api) => api.listProxies({}));
  const proxy = proxies.data?.proxies.find((p) => p.id === instance.proxyId);
  const managed = proxy?.kind === "cliproxyapi";
  const readable = proxy?.managementKeySet && managed ? proxy.id : "";

  // Asks once; a read under a minute old answers without calling the proxy. The overview stream brings changes.
  useEffect(() => {
    if (readable) void client?.api.refreshProxyAccounts({ id: readable }).catch(() => {});
  }, [client, readable]);

  if (!proxy) return null;

  const summary = managed
    ? (proxyAccountsSummary(proxy.accounts, instance.harness) ??
      proxyAccountsHint(proxy.accounts, proxy.managementKeySet))
    : undefined;

  return (
    <Text style={[styles.chrome, { color: c.soft }]}>
      Through{" "}
      <Text
        accessibilityRole="link"
        accessibilityHint="Opens proxy settings"
        onPress={() => openSettingsSection("proxies")}
        style={{ color: c.accent }}
      >
        {proxy.name}
      </Text>
      {summary ? ` · ${summary}` : ""}
    </Text>
  );
}
