import { useState } from "react";
import { Text, View } from "react-native";
import type { Provider } from "@canopy/contracts";
import { supportsHarness } from "@canopy/domain/proxy-accounts";
import { Button, Sheet } from "../../ui/components";
import { SensitiveUrl } from "../../ui/Sensitive";
import { styles, useColors } from "../../ui/theme";
import { SettingChoice, SettingsGroup } from "../settings/SettingsGroup";
import { ProxyForm } from "../settings/ProxyForm";
import { useSettingsResource } from "../settings/resource";

/**
 * A saved proxy for an instance (web: ProxyPicker): only proxies the harness can use, the chosen one's masked
 * address, and Add proxy. `inherited` (a worker override) adds "Use the instance's proxy".
 */
export function ProxyPicker({
  harness,
  value,
  onChange,
  inherited = false,
}: {
  harness: Provider;
  value: string;
  onChange: (value: string) => void;
  inherited?: boolean;
}) {
  const c = useColors();
  const read = useSettingsResource("ListProxies", (api) => api.listProxies({}));
  const [adding, setAdding] = useState(false);
  const proxies = read.data?.proxies ?? [];
  const compatible = proxies.filter((p) => supportsHarness(p, harness));
  const chosen = proxies.find((p) => p.id === value);

  const options = [
    ...(inherited ? [{ value: "", label: "Use the instance's proxy" }] : []),
    ...compatible.map((p) => ({ value: p.id, label: p.name })),
  ];

  return (
    <View style={{ gap: 8 }}>
      <SettingsGroup>
        <SettingChoice
          title="Proxy"
          description="Choose a saved connection supported by this harness."
          value={options.some((o) => o.value === value) ? value : ""}
          onChange={onChange}
          disabled={read.initialLoading}
          options={
            options.length
              ? options
              : [{ value: "", label: read.initialLoading ? "Loading proxies…" : "Choose a proxy…" }]
          }
        />
      </SettingsGroup>
      {chosen?.baseUrl ? <SensitiveUrl value={chosen.baseUrl} style={[styles.workMeta, { color: c.muted }]} /> : null}
      {read.data && !options.length ? (
        <Text style={[styles.chrome, { color: c.muted }]}>No compatible proxies yet. Add one to continue.</Text>
      ) : null}
      {read.error ? (
        <View style={[styles.row, { flexWrap: "wrap" }]}>
          <Text style={[styles.chrome, { color: c.danger }]}>{read.error}</Text>
          <Button size="sm" title="Try again" onPress={() => void read.reload()} />
        </View>
      ) : null}
      <View style={styles.row}>
        <Button size="sm" title="Add proxy" onPress={() => setAdding(true)} />
      </View>
      <Sheet title="Add proxy" visible={adding} onClose={() => setAdding(false)}>
        {adding && (
          <ProxyForm
            onCancel={() => setAdding(false)}
            onSaved={(proxy) => {
              setAdding(false);
              void read.reload();

              if (proxy && supportsHarness(proxy, harness)) onChange(proxy.id);
            }}
          />
        )}
      </Sheet>
    </View>
  );
}
