import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { palette } from "@canopy/ui";
import type { IconName } from "@canopy/ui/icons";
import Animated from "react-native-reanimated";
import { Icon } from "./Icon";
import { useMotion } from "./motion";
import { CompactControls } from "./density";
import { font, useColors, useTypography, type Colors } from "./theme";

export type AlertTone = "info" | "warning" | "danger" | "error";

const hues = { info: "sky", warning: "amber", danger: "rose", error: "rose" } as const;

const icons: Record<AlertTone, IconName> = {
  info: "information-circle",
  warning: "exclamation-triangle",
  danger: "exclamation-triangle",
  error: "exclamation-circle",
};

function alertLook(tone: AlertTone, c: Colors) {
  const p = palette[hues[tone]];

  return c.dark
    ? { background: `${p[400]}1a`, ring: `${p[400]}33`, icon: p[400], title: p[100], body: p[200] }
    : {
        background: p[50],
        ring: `${p[600]}${tone === "info" ? "26" : "33"}`,
        icon: p[600],
        title: p[950],
        body: p[900],
      };
}

/**
 * Inline message (web: Alert). `error` is announced at once, the others politely. `banner` drops the frame for a
 * full-width strip under a header. `actions` sit at the end: small buttons, never a primary one.
 */
export function Alert({
  tone = "info",
  title,
  banner = false,
  actions,
  children,
}: {
  tone?: AlertTone;
  title?: string;
  banner?: boolean;
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const c = useColors();
  const type = useTypography();
  const look = alertLook(tone, c);
  const { toast } = useMotion();

  // A message that comes or goes with a state change enters and leaves like a toast (web `t-toast`).
  return (
    <Animated.View
      entering={toast.entering}
      exiting={toast.exiting}
      accessibilityRole={tone === "error" ? "alert" : "text"}
      accessibilityLiveRegion={tone === "error" ? "assertive" : "polite"}
      style={[
        { flexDirection: "row", alignItems: "flex-start", gap: 12, backgroundColor: look.background },
        banner
          ? { paddingHorizontal: 16, paddingVertical: 10 }
          : { padding: 12, borderRadius: 8, borderWidth: 1, borderColor: look.ring },
      ]}
    >
      <View style={{ height: type.body.lineHeight, justifyContent: "center" }}>
        <Icon name={icons[tone]} color={look.icon} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        {title ? <Text style={[type.body, { fontFamily: font.medium, color: look.title }]}>{title}</Text> : null}
        {children ? <Text style={[type.body, { color: look.body }]}>{children}</Text> : null}
      </View>
      {actions ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <CompactControls.Provider value={true}>{actions}</CompactControls.Provider>
        </View>
      ) : null}
    </Animated.View>
  );
}

/**
 * A short note under or between controls (web: a muted paragraph). An `error` note is an error `Alert`, so failures
 * look the same on every screen.
 */
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  const c = useColors();
  const type = useTypography();
  const { rise } = useMotion();

  if (error) return <Alert tone="error">{children}</Alert>;

  return (
    <Animated.Text
      entering={rise.entering}
      exiting={rise.exiting}
      accessibilityLiveRegion="polite"
      style={[type.small, { color: c.muted }]}
    >
      {children}
    </Animated.Text>
  );
}

/** What lives here and how to fill it (web: EmptyState): a dashed frame, a title, one or two sentences, one action. */
export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: IconName;
  action?: ReactNode;
}) {
  const c = useColors();
  const type = useTypography();

  return (
    <View
      style={{
        alignItems: "center",
        paddingHorizontal: 24,
        paddingVertical: 40,
        borderRadius: 12,
        borderWidth: 1,
        borderStyle: "dashed",
        borderColor: c.dark ? "#ffffff26" : "#09090b26",
      }}
    >
      {icon ? (
        <View style={{ marginBottom: 12 }}>
          <Icon name={icon} color={c.faint} />
        </View>
      ) : null}
      <Text style={[type.body, { fontFamily: font.medium, color: c.text, textAlign: "center" }]}>{title}</Text>
      {description ? (
        <Text style={[type.body, { color: c.muted, textAlign: "center", marginTop: 4, maxWidth: 420 }]}>
          {description}
        </Text>
      ) : null}
      {action ? <View style={{ marginTop: 16 }}>{action}</View> : null}
    </View>
  );
}
