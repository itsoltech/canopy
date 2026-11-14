import { sign, verify, X509Certificate } from "node:crypto";
import { Code, ConnectError } from "@connectrpc/connect";
import { certificateIdentity } from "../computers/identity.ts";

export type Binding = { sessionId: string; sourceId: string; sessionPin: string; targetPin: string };

/** What the home's computer key signs: this session, this invitation, its new session certificate and the
 * server it pinned. A signature can't be replayed to another server or bind another certificate. */
const statement = (b: Binding) =>
  Buffer.from(`canopy-server-migration-v1\n${b.sessionId}\n${b.sourceId}\n${b.sessionPin}\n${b.targetPin}`);

export function signBinding(privateKey: string, binding: Binding) {
  return new Uint8Array(sign("sha256", statement(binding), privateKey));
}

/** The node ID is proven only when the computer certificate's key signed the binding. */
export function verifyBinding(computerCertificate: string, signature: Uint8Array, binding: Binding) {
  const identity = certificateIdentity(computerCertificate);
  const key = new X509Certificate(identity.certificate).publicKey;

  let valid = false;

  try {
    valid = signature.length > 0 && verify("sha256", statement(binding), key, signature);
  } catch {
    // A malformed signature is the same refusal as a wrong one.
  }

  if (!valid)
    throw new ConnectError("This computer couldn't prove its identity. Pair it again.", Code.PermissionDenied);

  return identity;
}
