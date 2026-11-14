import { useState } from "react";
import { Text, View } from "react-native";
import type { ui } from "@canopy/contracts";
import { proxyKinds } from "@canopy/domain/proxy-accounts";
import { Badge } from "../../ui/Badge";
import { Alert, Button } from "../../ui/components";
import { SensitiveUrl } from "../../ui/Sensitive";
import { font, styles, useColors } from "../../ui/theme";
import { SettingsActions } from "./SettingsGroup";
import { SettingsDisclosure } from "./SettingsDisclosure";
import { confirmAction, useSettingsResource } from "./resource";
import { ProxyAccounts } from "./ProxyAccounts";
import { ProxyMappings } from "./ProxyMappings";

/**
 * One saved proxy (web: ProxyEntry): name, masked address, secret badge, kind and users, its accounts, how agents
 * use it, and Test connection / Edit / Delete with the test result under the card.
 */
export function ProxyEntry({ proxy, onEdit }: { proxy: ui.Proxy; onEdit: () => void }) {
  const c = useColors();
  const resource = useSettingsResource("ListProxies", (api) => api.listProxies({}));
  const [result, setResult] = useState<ui.TestProxyResponse>();
  const [testing, setTesting] = useState(false);
  const kind = proxyKinds.find((k) => k.value === proxy.kind)?.label ?? proxy.kind;

  async function test() {
    setTesting(true);
    const response = await resource.run((api) => api.testProxy({ id: proxy.id }));
    setTesting(false);

    if (response) setResult(response);
  }

  return (
    <View style={{ gap: 12, minWidth: 0 }}>
      <View style={[styles.row, { alignItems: "flex-start" }]}>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text accessibilityRole="header" style={[styles.label, { fontFamily: font.semibold, color: c.text }]}>
            {proxy.name}
          </Text>
          <SensitiveUrl value={proxy.baseUrl} style={[styles.chrome, { color: c.muted }]} />
        </View>
        <Badge tone={proxy.secretSet ? "emerald" : "amber"}>{proxy.secretSet ? "Secret set" : "Secret missing"}</Badge>
      </View>
      <Text style={[styles.chrome, { color: c.muted }]}>
        {kind} · {proxy.usedBy.length ? `Used by ${proxy.usedBy.join(", ")}` : "No profiles yet"}
      </Text>
      {proxy.kind === "cliproxyapi" && proxy.id ? (
        <ProxyAccounts proxy={proxy} onRead={() => void resource.reload()} />
      ) : null}
      <SettingsDisclosure title="How agents use this proxy">
        <ProxyMappings kind={proxy.kind} baseUrl={proxy.baseUrl} />
      </SettingsDisclosure>
      {result ? (
        <Alert tone={result.ok ? "info" : "error"}>
          {result.detail}
          {result.ok ? ` · ${result.modelCount} models` : ""}
        </Alert>
      ) : null}
      <SettingsActions>
        <Button size="sm" title="Test connection" busy={testing} onPress={() => void test()} />
        <Button size="sm" title="Edit" label={`Edit ${proxy.name}`} onPress={onEdit} />
        <Button
          size="sm"
          variant="ghost"
          title="Delete"
          label={`Delete ${proxy.name}`}
          hint={proxy.usedBy.length ? `Used by: ${proxy.usedBy.join(", ")}` : undefined}
          disabled={resource.busy || proxy.usedBy.length > 0}
          onPress={() =>
            confirmAction(
              `Delete ${proxy.name}`,
              "This removes the saved connection and its secret.",
              () => void resource.run((api) => api.deleteProxy({ id: proxy.id, expectedRevision: proxy.revision })),
            )
          }
        />
      </SettingsActions>
    </View>
  );
}
