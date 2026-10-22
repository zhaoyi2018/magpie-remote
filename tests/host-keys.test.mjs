import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fingerprint, hostVerifier } from "../src/host-keys.mjs";
import { hostPublicKey, temporary } from "./helpers.mjs";

test("known_hosts supports plain, hashed and nonstandard-port host entries", async (t) => {
  const file = join(await temporary(t), "known_hosts");
  const salt = randomBytes(20);
  const host = "[server.example]:2222";
  const hashed = `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update(host).digest("base64")}`;
  const key = `ssh-ed25519 ${hostPublicKey.toString("base64")}`;
  const profile = { host: "server.example", port: 2222, knownHostsFile: file };
  for (const entry of [host, hashed]) {
    await writeFile(file, `${entry} ${key}\n`);
    assert.equal((await hostVerifier(profile))(hostPublicKey), true);
    assert.equal((await hostVerifier({ ...profile, port: 22 }))(hostPublicKey), false);
  }
});

test("pins, host patterns, negation and revocation enforce the expected host key", async (t) => {
  const file = join(await temporary(t), "known_hosts");
  const key = `ssh-ed25519 ${hostPublicKey.toString("base64")}`;
  const profile = { host: "server.example", port: 22, knownHostsFile: file };
  await writeFile(file, `*.example,!other.example ${key}\n`);
  assert.equal((await hostVerifier(profile))(hostPublicKey), true);
  assert.equal((await hostVerifier({ ...profile, host: "other.example" }))(hostPublicKey), false);
  await writeFile(file, `@revoked server.example ${key}\n`);
  assert.equal((await hostVerifier({ ...profile, hostFingerprint: fingerprint(hostPublicKey) }))(hostPublicKey), false);
  await writeFile(file, "");
  assert.equal((await hostVerifier({ ...profile, hostFingerprint: fingerprint(hostPublicKey) }))(hostPublicKey), true);
  assert.equal((await hostVerifier({ ...profile, hostFingerprint: fingerprint(Buffer.from("different")) }))(hostPublicKey), false);
});
