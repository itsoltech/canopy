import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { connectionReport, routeOutcome } from "../../api/route-diagnostics";
import { useRouteStatus } from "../../state/route-status";
import { Button } from "../../ui/Button";
import { ConnectionSpinner } from "./ConnectionActivity";
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={[type.small, { color: c.text }]}>Routes</Text>
        <ConnectionSpinner active={routes.pending} />
      </View>
      <ScrollView
        style={{ flexShrink: 1, height: Math.min(260, routes.routes.length * (type.small.lineHeight * 2 + 14)) }}
      >
        {routes.routes.map((route) => (
          <View key={route.address} style={{ gap: 2, height: type.small.lineHeight * 2 + 14 }}>
            <Text selectable numberOfLines={1} ellipsizeMode="middle" style={[type.small, { color: c.text }]}>
              {route.kind} · {new URL(route.address).host}
              {route.address === routes.active ? " · In use" : ""}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text
                selectable
                numberOfLines={1}
                style={[type.small, { color: c.muted, fontVariant: ["tabular-nums"], flexShrink: 1 }]}
              >
                {routeOutcome(route)}
                {route.phase === "request" ? " · Request" : ""}
              </Text>
              <View accessibilityLabel={route.checking ? "Checking route" : undefined}>
                <ConnectionSpinner active={!!route.checking} />
              </View>
            </View>
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
        <Text numberOfLines={1} accessibilityLiveRegion="polite" style={[type.small, { color: c.muted, flex: 1 }]}>
          {copied}
        </Text>
      </View>
    </View>
  );
}
