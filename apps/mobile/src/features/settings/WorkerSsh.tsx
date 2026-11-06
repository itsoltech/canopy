import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { useSession } from "../../state/session";
import { Button, Field, Notice } from "../../ui/components";
import { SettingsValue } from "./SettingsValue";
import { confirmAction } from "./resource";

export function WorkerSsh({ name = "", tags = [] }: { name?: string; tags?: string[] }) {
  const { client } = useSession();
  const [target, setTarget] = useState("");
  const [checked, setChecked] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [trusted, setTrusted] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  async function run(action: string) {
    if (!client || busy) return;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");
    setOutput("");

    try {
      for await (const event of client.api.workerSsh(
        { action, target, fingerprint, name, tags },
        { signal: request.signal },
      )) {
        if (event.publicKey) setPublicKey(event.publicKey);

        if (event.fingerprint) {
          setFingerprint(event.fingerprint);
          setTrusted(event.trusted);
          setChecked(target);
        }

        if (event.output) setOutput((text) => (text + event.output).slice(-128_000));
      }
    } catch {
      setError(
        request.signal.aborted
          ? "SSH installation cancelled."
          : "SSH operation failed. Check the address, authorized key and connection, then retry.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ gap: 12 }}>
      <Notice>
        Add this public key to ~/.ssh/authorized_keys for the target user. Canopy keeps your private key encrypted in
        the gateway.
      </Notice>
      {error ? <Notice error>{error}</Notice> : null}
      {publicKey ? <SettingsValue title="Canopy SSH public key" value={publicKey} /> : null}
      <Button
        title={publicKey ? "Refresh public key" : "Show public key"}
        busy={busy}
        onPress={() => void run("key")}
      />
      {publicKey ? (
        <Button
          title="Rotate SSH key"
          disabled={busy}
          onPress={() =>
            confirmAction(
              "Rotate SSH key",
              "Replace the old public key on your hosts with the new one. Running workers stay connected.",
              () => void run("rotate"),
            )
          }
        />
      ) : null}
      {name && (
        <>
          <Field
            label="SSH address"
            value={target}
            onChangeText={setTarget}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!busy}
            placeholder="you@host:22"
          />
          <Notice>
            The gateway connects over SSH. This computer needs access to GitHub Releases and the gateway address for
            workers.
          </Notice>
          <Button title="Check host key" disabled={!target.trim()} busy={busy} onPress={() => void run("probe")} />
          {fingerprint && checked === target && (
            <>
              <SettingsValue
                title="SSH key fingerprint"
                value={fingerprint}
                description={
                  trusted
                    ? "This SSH key matches your saved fingerprint."
                    : "Verify this fingerprint with the computer's administrator before trusting it."
                }
              />
              <Button
                variant="primary"
                title={trusted ? "Install worker" : "Trust and install"}
                disabled={busy}
                onPress={() => void run("install")}
              />
            </>
          )}
          {busy && <Button title="Cancel installation" onPress={() => controller.current?.abort()} />}
        </>
      )}
      {output ? <SettingsValue title="Installation output" value={output} /> : null}
    </View>
  );
}
