// Mints an Ed25519 credential signing key pair.
//
//   npm run keygen
//
// Put the PRIVATE key in .env.local as CREDENTIAL_SIGNING_KEY (never commit
// it). The PUBLIC key is safe to publish — it is what lets anyone verify a
// Clawllege diploma without trusting this server.
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const priv = privateKey.export({ type: "pkcs8", format: "der" }).toString("base64");
const pub = publicKey.export({ type: "spki", format: "der" }).toString("base64");

console.log("# add to .env.local (NEVER COMMIT):");
console.log(`CREDENTIAL_SIGNING_KEY=${priv}`);
console.log();
console.log("# publish this one (repo + GET /api/v1/credentials/key):");
console.log(`CREDENTIAL_PUBLIC_KEY=${pub}`);
