import { AcpError } from "@canopy/acp";
import { accountResult } from "../account-parser.ts";
import { antigravityAuth } from "./auth.ts";
import type { AntigravityInstance } from "./launch.ts";
import { withAntigravitySession } from "./probe.ts";

// ACP's Authentication required error, returned by agy when session/new has no usable login.
const AUTH_REQUIRED = -32000;

export async function readAntigravityAccount(instance: AntigravityInstance, timeoutMs: number, signal: AbortSignal) {
  const auth = antigravityAuth(instance.profile.env, instance.baseEnv ?? process.env, instance.linkDeviceLogin);

  if (auth.kind === "unavailable") return accountResult("unknown", "", auth.problem);

  if (auth.kind === "key") {
    const account = accountResult("unknown", "");
    account.authMethod = "API key configured";

    return account;
  }

  const deadline = AbortSignal.timeout(timeoutMs);

  try {
    await withAntigravitySession(instance, () => {}, AbortSignal.any([deadline, signal]));
  } catch (error) {
    if (deadline.aborted) return accountResult("error", "", "The account check timed out.");

    if (error instanceof AcpError && error.code === AUTH_REQUIRED) return accountResult("signed_out", "");

    throw error;
  }

  const account = accountResult("signed_in", "");
  account.authMethod = "Account";

  return account;
}
