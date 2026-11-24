import { View } from "react-native";
import { usageProxyLimits } from "@canopy/domain/usage-summary";
import { ProxyAccountRow } from "../proxies/ProxyAccountRow";
import { SettingsGroup, SettingsGroupHeader } from "../settings/SettingsGroup";
import { useSettingsResource } from "../settings/resource";

export function ProviderProxyLimits({ now }: { now: number }) {
  const proxies = useSettingsResource("ListProxies", (api) => api.listProxies({}));
  const groups = usageProxyLimits(proxies.data?.proxies ?? [], now);

  if (!groups.length) return null;

  return (
    <SettingsGroup title="Proxy limits">
      {groups.map(({ proxy, accounts }) => (
        <View key={proxy.id}>
          <SettingsGroupHeader title={proxy.name} />
          {accounts.map((account) => (
            <ProxyAccountRow key={account.id} account={account} now={now} compact />
          ))}
        </View>
      ))}
    </SettingsGroup>
  );
}
