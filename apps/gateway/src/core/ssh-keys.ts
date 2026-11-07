import { utils } from "ssh2";

/**
 * A new ed25519 key pair in OpenSSH format. ssh2 drops a leading zero byte of the public key (one key in 256) and
 * writes a key that neither ssh2 nor OpenSSH can read, so such a pair is generated again.
 */
export function ed25519KeyPair(comment: string) {
  for (;;) {
    const pair = utils.generateKeyPairSync("ed25519", { comment });

    if (!(utils.parseKey(pair.private) instanceof Error)) return pair;
  }
}
