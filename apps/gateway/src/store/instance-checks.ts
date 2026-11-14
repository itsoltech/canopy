import { create, fromJson, type JsonValue } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ConfigAppliedSchema, Provider, ProviderProfileKind, ui, type ConfigApplied } from "@canopy/contracts";
import { Effect } from "effect";
import { type SqlError } from "effect/sql";
import {
  enabledOn,
  harnessOf,
  isRef,
  providerOf,
  type AssignmentRow,
  type Harness,
  type InstanceModelsRule,
  type InstanceRow,
  type SecretRef,
  type StoredEnvVar,
} from "./instance-config.ts";
import { Invalid, NotFound } from "./store.ts";
import type { ProxyApi } from "./proxies.ts";
import type { ProxyManagementApi } from "./proxy-management.ts";
import { isCredentialEnv } from "./credential-env.ts";

/** The change started from an older definition, or an instance in use cannot be deleted. */
export class InstanceConflict extends Error {
  override readonly name = "InstanceConflict";
}

export type Fx<A> = Effect.Effect<A, SqlError.SqlError | NotFound | Invalid | InstanceConflict>;

/** Secrets this store (and the per-worker profiles before it) creates; unreferenced ones are deleted after changes. */
export const SECRET_PREFIX = "instance-";
export const MAX_INSTANCES = 64;
export const MAX_MODELS = 2000;
export const MAX_PATH = 1024;
export const MAX_ARGS = 64;
export const ACCENT = /^#[0-9a-f]{6}$/;

export interface WorkerRow {
  id: string;
  name: string;
  version: bigint | number | null;
  applied_version: bigint | number | null;
  applied_at: Date | null;
  apply_report: JsonValue | null;
}

export interface ConfigRow {
  owner_user_id?: string | null;
  worker_id: string;
  /** jsonb: WorkerConfig in protobuf JSON form (see worker-config-json.ts). */
  config: { version?: string; profiles?: JsonValue[]; [key: string]: JsonValue | undefined };
  version: bigint | number;
}

export interface SaveInstanceInput {
  readonly userId: string;
  readonly request: ui.SaveProviderInstanceRequest;
}

export const harnessOrFail = (provider: Provider) => {
  const harness = harnessOf(provider);

  return harness ? Effect.succeed(harness) : Effect.fail(new Invalid("choose Claude or Codex"));
};

export const envSettings = (env: readonly StoredEnvVar[]) =>
  env.map((v) =>
    create(ui.ProfileEnvVarSettingsSchema, {
      name: v.name,
      secret: v.secret === true || isCredentialEnv(v.name),
      value: v.secret || isRef(v.value) || isCredentialEnv(v.name) ? "" : v.value,
    }),
  );

export const report = (row: WorkerRow): ConfigApplied | undefined =>
  row.apply_report ? fromJson(ConfigAppliedSchema, row.apply_report, { ignoreUnknownFields: true }) : undefined;

export function checkPath(label: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();

  if (trimmed.length > MAX_PATH || trimmed.includes("\0")) return `${label} is invalid`;

  return undefined;
}

export function checkArgs(args: readonly string[]): string | undefined {
  if (args.length > MAX_ARGS) return `at most ${MAX_ARGS} launch arguments`;

  if (args.some((a) => a.length > MAX_PATH || a.includes("\0"))) return "a launch argument is invalid";

  return undefined;
}

export function checkBaseUrl(value: string): string | undefined {
  const url = URL.canParse(value.trim()) ? new URL(value.trim()) : undefined;

  if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return "the endpoint must be an http(s) URL";

  if (url.username || url.password) return "put the key in the API key field, not in the URL";

  return undefined;
}

export const toUi = (
  row: InstanceRow,
  rows: readonly AssignmentRow[],
  workerRows: readonly WorkerRow[],
  used: readonly { worker_id: string; harness: Harness; id: string; count: bigint | number }[],
) => {
  const provider = providerOf(row.harness);
  const ofInstance = used.filter((u) => u.harness === row.harness && u.id === row.id);

  return create(ui.ProviderInstanceSchema, {
    harness: provider,
    id: row.id,
    label: row.label,
    kind: row.kind === "endpoint" ? ProviderProfileKind.CLIPROXYAPI : ProviderProfileKind.NATIVE,
    baseUrl: row.base_url,
    proxyId: row.proxy_id ?? "",
    apiKeySet: isRef(row.api_key),
    env: envSettings(row.env ?? []),
    runtime: {
      binaryPath: row.runtime?.binaryPath ?? "",
      homePath: row.runtime?.homePath ?? "",
      shadowHomePath: row.runtime?.shadowHomePath ?? "",
      launchArgs: row.runtime?.launchArgs ?? [],
      ownLogin: row.runtime?.ownLogin === true,
    },
    accentColor: row.accent_color,
    models: {
      favorites: row.favorites,
      hidden: row.hidden_models,
      shown: row.shown_models,
      custom: row.custom_models,
    },
    allWorkers: row.all_workers,
    builtIn: row.built_in,
    revision: BigInt(row.revision),
    threadCount: ofInstance.reduce((sum, u) => sum + Number(u.count), 0),
    updatedAt: timestampFromDate(new Date(row.updated_at)),
    workers: workerRows.map((w) => {
      const assignment = rows.find(
        (a) => a.harness === row.harness && a.instance_id === row.id && a.worker_id === w.id,
      );

      const reported = report(w)?.profiles.find((p) => p.id === row.id && p.providers.includes(provider));
      const o = assignment?.overrides ?? {};

      return create(ui.InstanceOnWorkerSchema, {
        workerId: w.id,
        enabled: enabledOn(row, assignment),
        explicit: assignment?.enabled !== null && assignment?.enabled !== undefined,
        overrides: {
          ...(o.binaryPath !== undefined && { binaryPath: o.binaryPath }),
          ...(o.homePath !== undefined && { homePath: o.homePath }),
          ...(o.shadowHomePath !== undefined && { shadowHomePath: o.shadowHomePath }),
          launchArgsSet: o.launchArgs !== undefined,
          launchArgs: o.launchArgs ?? [],
          env: envSettings(o.env ?? []),
          ...(o.baseUrl !== undefined && { baseUrl: o.baseUrl }),
          apiKeySet: isRef(o.apiKey),
          proxyId: assignment?.proxy_id ?? "",
        },
        reported: reported !== undefined,
        available: reported?.available ?? false,
        detail: reported
          ? reported.detail
          : w.version === null
            ? "the worker is not configured yet"
            : "not reported by the worker yet",
        version: reported?.version ?? "",
        auth: reported?.auth ?? "",
        authenticated: reported?.authenticated ?? false,
        ...(reported && { kind: reported.kind }),
        threadCount: Number(ofInstance.find((u) => u.worker_id === w.id)?.count ?? 0),
        ...(w.applied_at && { checkedAt: timestampFromDate(new Date(w.applied_at)) }),
        synced: w.version !== null && w.applied_version !== null && BigInt(w.applied_version) === BigInt(w.version),
      });
    }),
  });
};

export interface InstanceApi extends ProxyApi, ProxyManagementApi {
  moveInstanceToProxy(
    userId: string,
    request: ui.MoveInstanceToProxyRequest,
  ): Fx<{ harness: Harness; id: string; changed: string[] }>;
  /** Every instance with its state on every worker (settings screen; no secret values). */
  list(userId?: string): Fx<ui.ProviderInstance[]>;
  get(harness: Harness, id: string, userId?: string): Fx<ui.ProviderInstance>;
  /** Creates or changes an instance. Returns the workers whose configuration changed. */
  save(input: SaveInstanceInput): Fx<{ harness: Harness; id: string; changed: string[] }>;
  remove(input: { userId: string; request: ui.DeleteProviderInstanceRequest }): Fx<string[]>;
  setWorkers(input: { userId: string; request: ui.SetInstanceWorkersRequest }): Fx<string[]>;
  setWorker(input: { userId: string; request: ui.SetInstanceWorkerRequest }): Fx<string[]>;
  setModels(request: ui.SetInstanceModelsRequest): Fx<void>;
  /**
   * Writes each worker's effective instances into its configuration when they differ (a new version, history
   * kept) and drops this store's secrets nothing references. All workers when `workerIds` is absent.
   * Returns the workers whose configuration changed.
   */
  sync(userId: string, workerIds?: readonly string[]): Fx<string[]>;
  /** Per worker, the instances with their state there (Worker.provider_instances, pickers). */
  workerInstances(): Fx<ReadonlyMap<string, ui.WorkerInstance[]>>;
  /** Every instance's model choices (pickers' catalog, model checks). */
  modelRules(): Fx<InstanceModelsRule[]>;
  /**
   * The CLI registers a worker with an endpoint (CLIProxyAPI): an "cliproxyapi" instance per harness, enabled on
   * the worker; when it already exists with another address or key, they become the worker's overrides.
   */
  registerEndpoint(input: { userId: string; workerId: string; baseUrl: string; apiKey: SecretRef }): Fx<void>;
}
