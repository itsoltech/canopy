import { useEffect, useState } from "react";
import { ui } from "@canopy/contracts";
import { Button, Field, Notice, Sheet } from "../../ui/components";
import { SettingToggle } from "./SettingsGroup";
import { SettingsValue } from "./SettingsValue";
import { ResourceState, useSettingsResource } from "./resource";

export function ComputerPairing({ onClose }: { onClose: () => void }) {
  const resource = useSettingsResource("GetComputers", (api) => api.getComputers({}));
  const [invitation, setInvitation] = useState<ui.ComputerPairing>();
  const [shareConfig, setShare] = useState(true);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const { data } = resource;
  const { run } = resource;
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);

    return () => clearInterval(timer);
  }, []);
  const remaining = Math.max(0, Math.ceil((Number(invitation?.expiresAtMs ?? 0) - now) / 1000));

  function close() {
    if (invitation) void run((api) => api.manageComputer({ action: "revoke_pairing" }));
    setInvitation(undefined);
    setCode("");
    onClose();
  }

  return (
    <Sheet title="Link a computer" visible onClose={close}>
      <ResourceState resource={resource}>
        <Notice>Both computers belong to you and will have full access to each other.</Notice>
        <SettingToggle title="Share configuration" value={shareConfig} disabled={resource.busy} onChange={setShare} />
        <Button
          variant="primary"
          title={data?.listenerEnabled ? "Generate pairing code" : "Enable network access and generate code"}
          busy={resource.busy}
          onPress={() =>
            void run(async (api) => {
              if (!data?.listenerEnabled) await api.updateNetworkAccess({ action: "set_enabled", enabled: true });

              return api.createComputerPairing({ shareConfig });
            }).then((result) => {
              if (result) setInvitation(result);
            })
          }
        />
        {invitation && (
          <>
            <SettingsValue
              title="Pairing code"
              value={remaining ? invitation.code : "Expired"}
              description={`Expires in ${remaining} seconds. Keep this code private.`}
            />
            <SettingsValue title="Computer addresses" value={invitation.addresses.join("\n")} />
            <Button
              title="Revoke code"
              busy={resource.busy}
              onPress={() =>
                void run((api) => api.manageComputer({ action: "revoke_pairing" })).then((result) => {
                  if (result) setInvitation(undefined);
                })
              }
            />
          </>
        )}
        <Field
          label="Computer address"
          value={address}
          onChangeText={setAddress}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="https://computer:port"
        />
        <Field label="Pairing code" value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} />
        <Notice>
          The code verifies the other computer’s certificate before pairing. After linking, compare both fingerprints in
          Settings.
        </Notice>
        <Button
          title="Link computers"
          disabled={!address.trim() || !code.trim()}
          busy={resource.busy}
          onPress={() =>
            void run((api) => api.linkComputer({ address, code, shareConfig })).then((result) => {
              if (result) close();
            })
          }
        />
      </ResourceState>
    </Sheet>
  );
}
