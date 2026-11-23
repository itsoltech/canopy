import { useEffect, useRef, useState } from "react";
import { useRoute } from "expo-router";
import type { ui } from "@canopy/contracts";
import { agentCliName } from "@canopy/domain/import-look";
import { useOverview } from "../../state/overview";
import { useSession } from "../../state/session";
import { Button, Notice, Sheet } from "../../ui/components";
import { SettingChoice, SettingsGroup } from "../settings/SettingsGroup";
import { SettingsValue } from "../settings/SettingsValue";
import { ImportReview } from "./ImportReview";

import { createSettingsViewState } from "../settings/SettingsScroll";

const useImportWorker = createSettingsViewState("");

/** The computer's worker reads CLI files; the paired phone only chooses what to import. */
export function ImportStart({ onStarted, initialWorkerId = "" }: { onStarted: () => void; initialWorkerId?: string }) {
  const { client, online } = useSession();
  const { workers } = useOverview();
  const eligible = workers.filter((w) => !w.nodeId && w.cliImport && !w.revokedAt);
  const route = useRoute();
  const [picked, setPicked] = useImportWorker(initialWorkerId ? route.key : undefined, initialWorkerId);
  const workerId = picked || eligible.find((w) => w.online)?.id || eligible[0]?.id || "";
  const worker = eligible.find((w) => w.id === workerId);
  const [scan, setScan] = useState<ui.ScanImportResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController>(undefined);
  const scanning = useRef(false);

  useEffect(() => () => controller.current?.abort(), []);

  async function inspect() {
    if (!client || !online || !worker?.online || scanning.current) return;
    scanning.current = true;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError("");

    try {
      const result = await client.api.scanImport({ workerId }, { timeoutMs: 135_000, signal: request.signal });

      if (!request.signal.aborted) setScan(result);
    } catch {
      if (!request.signal.aborted) setError("Could not scan this computer. Check its worker and scan again.");
    } finally {
      scanning.current = false;

      if (!request.signal.aborted) setBusy(false);
    }
  }

  return (
    <>
      <SettingsGroup
        title="Import"
        description="Bring threads from Claude Code, Codex and Grok into Canopy. Canopy only reads the CLI files."
      >
        <SettingChoice
          title="Worker"
          value={workerId}
          disabled={busy}
          onChange={setPicked}
          options={eligible.map((w) => ({
            value: w.id,
            label: w.name,
            disabled: !w.online,
            description: w.online ? undefined : "Start this worker to scan its files.",
          }))}
        />
        {!eligible.length && <Notice>Connect a worker with CLI import support to scan this computer.</Notice>}
        <Button
          variant="primary"
          icon="magnifying-glass"
          title="Scan"
          busy={busy}
          disabled={!online || !worker?.online}
          onPress={() => void inspect()}
        />
      </SettingsGroup>
      {error ? <Notice error>{error}</Notice> : null}
      <Sheet title="Choose what to import" visible={!!scan} onClose={() => setScan(undefined)}>
        {scan && (
          <>
            {scan.overview.map((source) => (
              <SettingsValue
                key={source.agentCli}
                title={agentCliName(source.agentCli)}
                value={`${source.threads.toLocaleString("en")} ${source.threads === 1 ? "thread" : "threads"} · ${source.library.toLocaleString("en")} library ${source.library === 1 ? "item" : "items"}${source.problem ? ` · ${source.problem}` : ""}`}
              />
            ))}
            {scan.truncated && (
              <Notice>The scan reached its limit. Import this selection, then scan again for more.</Notice>
            )}
            <ImportReview
              key={scan.scanId}
              scan={scan}
              onStarted={() => {
                setScan(undefined);
                onStarted();
              }}
            />
          </>
        )}
      </Sheet>
    </>
  );
}
