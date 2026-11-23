import { useState } from "react";
import { ui } from "@canopy/contracts";
import { Button, Field, IconButton, Notice, Sheet } from "../../ui/components";
import { useForegroundInterval } from "../../ui/interval";
import { useLiveTime } from "../../ui/time";
import { copyText } from "../viewers/useCopyText";
import { SettingToggle, SettingsRow } from "./SettingsGroup";
import { ResourceState, useSettingsResource } from "./resource";

export function ComputerPairing({ onClose }: { onClose: () => void }) {
  const resource = useSettingsResource("GetComputers", (api) => api.getComputers({}));
  const [invitation, setInvitation] = useState<ui.ComputerPairing>();
  const [entering, setEntering] = useState(false);
  const [shareConfig, setShare] = useState(true);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const { data, run, busy } = resource;

  const linked =
    invitation && data?.peers.some((peer) => !peer.viaNodeId && peer.linkedAtMs >= invitation.expiresAtMs - 600_000n);

  const now = useLiveTime(!!invitation && !linked);
  const remaining = Math.max(0, Math.ceil((Number(invitation?.expiresAtMs ?? 0) - now) / 1000));
  useForegroundInterval(() => void resource.reload(), 2000, !!invitation && remaining > 0 && !linked && !busy);

  function close() {
    if (busy) return;

    if (invitation && !linked && remaining) void run((api) => api.manageComputer({ action: "revoke_pairing" }));
    onClose();
  }

  async function invite() {
    const result = await run(async (api) => {
      if (!data?.listenerEnabled) await api.updateNetworkAccess({ action: "set_enabled", enabled: true });

      return api.createComputerPairing({ shareConfig });
    });

    if (result) setInvitation(result);
  }

  return (
    <Sheet title="Link a computer" visible onClose={() => void close()}>
      <ResourceState resource={resource}>
        {linked ? (
          <>
            <Notice>Computer linked. Compare each computer’s fingerprint with its entry on the other computer.</Notice>
            <Button title="Done" variant="primary" onPress={onClose} />
          </>
        ) : invitation ? (
          <>
            <ComputerInvitation invitation={invitation} remaining={remaining} />
            <Button title="Generate new code" busy={busy} onPress={() => void invite()} />
            {remaining > 0 && (
              <Button
                title="Revoke code"
                variant="ghost"
                busy={busy}
                onPress={() =>
                  void run((api) => api.manageComputer({ action: "revoke_pairing" })).then((saved) => {
                    if (saved) setInvitation(undefined);
                  })
                }
              />
            )}
          </>
        ) : (
          <>
            <Notice>Both computers belong to you and will have full access to each other.</Notice>
            <SettingToggle
              title="Share configuration"
              description="Settings, providers and proxies follow changes on computers in the same group."
              value={shareConfig}
              disabled={busy}
              onChange={setShare}
            />
            {entering ? (
              <>
                <Field
                  label="Computer address"
                  value={address}
                  onChangeText={setAddress}
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder="https://computer:port"
                />
                <Field
                  label="Pairing code"
                  value={code}
                  onChangeText={setCode}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <Notice>
                  The code verifies the other computer’s certificate before pairing. After linking, compare both
                  fingerprints in Settings.
                </Notice>
                <Button
                  title="Link computers"
                  variant="primary"
                  disabled={!address.trim() || !code.trim()}
                  busy={busy}
                  onPress={() =>
                    void run((api) =>
                      api.linkComputer({ address: address.trim(), code: code.trim(), shareConfig }),
                    ).then((saved) => {
                      if (saved) onClose();
                    })
                  }
                />
              </>
            ) : (
              <>
                <Notice>On your other computer, open Settings → Linked computers.</Notice>
                <Button
                  title={data?.listenerEnabled ? "Generate pairing code" : "Turn on network access and generate a code"}
                  variant="primary"
                  disabled={!data}
                  busy={busy}
                  onPress={() => void invite()}
                />
                <Button title="Enter code" disabled={busy} onPress={() => setEntering(true)} />
              </>
            )}
          </>
        )}
      </ResourceState>
    </Sheet>
  );
}

function ComputerInvitation({ invitation, remaining }: { invitation: ui.ComputerPairing; remaining: number }) {
  return (
    <>
      <SettingsRow
        title="Pairing code"
        description={remaining ? invitation.code : "Code expired. Generate a new code."}
        inlineControl
        control={
          remaining > 0 && (
            <IconButton
              icon="clipboard-document"
              size="sm"
              label="Copy pairing code"
              onPress={() => void copyText(invitation.code)}
            />
          )
        }
      />
      {remaining > 0 && (
        <Notice>
          One use · expires in {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
        </Notice>
      )}
      {invitation.addresses.map((origin) => (
        <SettingsRow
          key={origin}
          title="Computer address"
          description={origin}
          inlineControl
          control={
            <IconButton
              size="sm"
              icon="clipboard-document"
              label={`Copy ${origin}`}
              onPress={() => void copyText(origin)}
            />
          }
        />
      ))}
    </>
  );
}
