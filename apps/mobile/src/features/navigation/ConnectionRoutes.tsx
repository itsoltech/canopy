import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { connectionReport, routeOutcome } from "../../api/route-diagnostics";
import { useRouteStatus } from "../../state/route-status";
import { Button } from "../../ui/Button";
import { useColors, useTypography } from "../../ui/theme";

/** Compact route results stay behind Details; the copy includes full hosts and check timestamps. */
export function ConnectionRoutes() {
  const routes = useRouteStatus();
  const c = useColors();
  const type = useTypography();
  const [copied, setCopied] = useState("");

  if (!routes.routes.length) return null;

  return (
    <View style={{ gap: 8, minHeight: 0, flexShrink: 1 }}>
      <Text style={[type.small, { color: c.text }]}>
        {routes.active ? "Routes" : routes.pending ? "Checking routes…" : "No route in use"}
      </Text>
      <ScrollView style={{ flexShrink: 1, maxHeight: 260 }} contentContainerStyle={{ gap: 12 }}>
        {routes.routes.map((route) => (
          <View key={route.address} style={{ gap: 2 }}>
            <Text selectable numberOfLines={1} ellipsizeMode="middle" style={[type.small, { color: c.text }]}>
              {route.kind} · {new URL(route.address).host}
              {route.address === routes.active ? " · In use" : ""}
            </Text>
            <Text selectable style={[type.small, { color: c.muted, fontVariant: ["tabular-nums"] }]}>
              {routeOutcome(route)}
              {route.phase === "request" ? " · Request" : ""}
            </Text>
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Button
          title="Copy details"
          size="sm"
          variant="ghost"
          onPress={() => {
            void Clipboard.setStringAsync(connectionReport(routes))
              .then(() => setCopied("Copied"))
              .catch(() => setCopied("Could not copy. Select the text to copy it."));
          }}
        />
        <Text accessibilityLiveRegion="polite" style={[type.small, { color: c.muted, flex: 1 }]}>
          {copied}
        </Text>
      </View>
    </View>
  );
}
