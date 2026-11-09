import { useRef, useState } from "react";
import { Text, View } from "react-native";
import { departureLabel, useGatewayDeparture } from "../../state/gateway-departure";
import { useOverview } from "../../state/overview";
import { Alert } from "../../ui/Alert";
import { Button } from "../../ui/Button";
import { Overlay } from "../../ui/Overlay";
import { SheetDragArea } from "../../ui/SheetDragArea";
import { styles, useColors } from "../../ui/theme";
import { useUpdates } from "../updates/state";
import { UpdateDetails } from "../updates/UpdateDetails";

export function GatewayUpdateNotice() {
  const { value, visible } = useGatewayDeparture();
  const { stream } = useOverview();
  const [open, setOpen] = useState(false);
  const updates = useRef(false);
  const c = useColors();
  const { setOpen: showUpdates } = useUpdates();

  if (!value) return null;
  const failed = value.state === "failed" || value.state === "rolled_back";
  const title = departureLabel(value, stream.connection !== "live");

  return (
    <>
      {visible && stream.connection !== "offline" && (
        <Alert
          banner
          tone={failed ? "warning" : "info"}
          actions={<Button title="Details" size="sm" variant="ghost" onPress={() => setOpen(true)} />}
        >
          {title}
        </Alert>
      )}
      <Overlay
        visible={open}
        onClose={() => setOpen(false)}
        label="Canopy update"
        onDismiss={() => {
          if (updates.current) {
            updates.current = false;
            showUpdates(true);
          }
        }}
      >
        <View style={{ padding: 16, gap: 12 }}>
          <SheetDragArea>
            <Text style={[styles.overlay, { color: c.strong }]}>{title}</Text>
          </SheetDragArea>
          <Text selectable style={[styles.overlayMeta, { color: c.muted }]}>
            {value.targetVersion && value.targetVersion !== value.version
              ? `${value.version} → ${value.targetVersion}`
              : value.version}
          </Text>
          <Text style={[styles.overlayMeta, { color: c.muted }]}>
            {failed
              ? "The update did not finish. Open Updates to retry."
              : "Canopy reconnects automatically on the same route."}
          </Text>
          {!!value.reason && <UpdateDetails text={value.reason} />}
          <Button
            title="Open updates"
            onPress={() => {
              updates.current = true;
              setOpen(false);
            }}
          />
        </View>
      </Overlay>
    </>
  );
}
