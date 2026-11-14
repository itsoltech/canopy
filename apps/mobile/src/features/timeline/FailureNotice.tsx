import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { safeFailureDetail } from "@canopy/domain/failures";
import { failurePresentation } from "@canopy/domain/failure-presentation";
import { usageFailureHeading } from "@canopy/domain/provider-usage";
import { font, styles, useColors, useTypography } from "../../ui/theme";
import { useTone } from "../../ui/tone";
import { Chevron } from "../../ui/MotionViews";
import { CopyAction } from "../viewers/copy-action";

/**
 * A failed turn or bot reply (web: FailureNotice): a heading, what it means in words, a hint for a login and the
 * technical details behind "Show details". Retrying and changing the model happen on the web.
 */
export function FailureNotice({
  message,
  code = "",
  source = "",
  classification = "",
  authHint = "",
  heading = "Could not finish this turn",
  historical = false,
  proxy = false,
}: {
  message: string;
  code?: string;
  source?: string;
  classification?: string;
  authHint?: string;
  heading?: string;
  historical?: boolean;
  /** Through a proxy, a limit belongs to an upstream account, not the user's plan. */
  proxy?: boolean;
}) {
  const c = useColors();
  const type = useTypography();
  const rose = useTone("rose").text;
  const [open, setOpen] = useState(false);
  const failure = failurePresentation(message, classification || code, proxy);

  const details = safeFailureDetail(
    [source && `Source: ${source}`, code && `Code: ${code}`, message].filter(Boolean).join("\n"),
  );

  return (
    <View accessibilityRole="alert" style={{ gap: 8 }}>
      <Text style={[styles.body, { fontFamily: font.medium, color: rose }]}>
        {failure.kind === "usage_limit" ? (!proxy && usageFailureHeading(code)) || "Usage limit reached" : heading}
      </Text>
      {!historical && <Text style={[styles.body, { color: c.muted }]}>{failure.explanation}</Text>}
      {!historical && failure.kind === "auth_required" && authHint ? (
        <Text style={[styles.body, { color: c.muted }]}>{authHint}</Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        hitSlop={8}
        style={[styles.row, { gap: 6, minHeight: 32 }]}
      >
        <Chevron open={open} size={14} color={c.faint} />
        <Text style={[styles.body, { color: c.muted }]}>Show details</Text>
      </Pressable>
      {open && (
        <View style={{ gap: 4 }}>
          <Text selectable style={[type.mono, { color: c.muted }]}>
            {details}
          </Text>
          <View style={{ alignItems: "flex-start" }}>
            <CopyAction text={details} label="Copy error details" />
          </View>
        </View>
      )}
    </View>
  );
}
