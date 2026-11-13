import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { publishFile } from "../src/publish-file.mjs";
import { temporary } from "./helpers.mjs";

test("publishing a page endpoint recovers from Windows reader locks while retaining the complete previous file", async (t) => {
  const directory = await temporary(t);
  const file = join(directory, "endpoint.js");
  await writeFile(file, "previous endpoint");
  const failures = ["EPERM", "EBUSY", "EACCES"];
  await publishFile(file, "current endpoint", { platform: "win32", replace: async (source, destination) => {
    assert.equal(await readFile(file, "utf8"), "previous endpoint");
    const code = failures.shift();
    if (code) throw Object.assign(new Error("reader lock"), { code });
    await rename(source, destination);
  } });
  assert.equal(await readFile(file, "utf8"), "current endpoint");
  assert.deepEqual(await readdir(directory), ["endpoint.js"]);
});

test("persistent or unrelated publication failures preserve the old entry and remove temporary credentials", async (t) => {
  const directory = await temporary(t);
  const file = join(directory, "endpoint.js");
  await writeFile(file, "previous endpoint");
  for (const code of ["EPERM", "ENOSPC"]) {
    let attempts = 0;
    await assert.rejects(publishFile(file, "secret new endpoint", { platform: "win32", replace: async () => {
      attempts++;
      throw Object.assign(new Error("cannot replace"), { code });
    } }), { code });
    assert.equal(attempts, code === "EPERM" ? 7 : 1);
    assert.equal(await readFile(file, "utf8"), "previous endpoint");
    assert.deepEqual(await readdir(directory), ["endpoint.js"]);
  }
});
