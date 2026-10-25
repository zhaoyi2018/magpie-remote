import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export async function createHostSandbox(sourceRoot) {
  const source = resolve(sourceRoot);
  const directory = await mkdtemp(join(tmpdir(), "migpie-host-smoke-"));
  const root = join(directory, "plugin");
  const runtime = join(source, "page", ".runtime");
  const endpoint = join(root, "page", ".runtime", "endpoint.js");
  const cleanup = async () => {
    const absolute = resolve(directory);
    assert.equal(dirname(absolute), resolve(tmpdir()));
    assert.ok(basename(absolute).startsWith("migpie-host-smoke-"));
    // rm removes the node_modules link itself, never its source directory.
    await rm(absolute, { recursive: true, force: true, maxRetries: 3 });
  };
  try {
    await mkdir(root);
    for (const entry of ["index.mjs", "src", "page", "package.json"]) {
      await cp(join(source, entry), join(root, entry), {
        recursive: true, dereference: true,
        filter: (file) => resolve(file) !== runtime,
      });
    }
    // A junction works on Windows without symbolic-link privileges.
    await symlink(await realpath(join(source, "node_modules")), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    return {
      directory, root, cleanup,
      getEndpoint() {
        const match = /^window\.__migpieRemoteEndpoint = (.+);\s*$/u.exec(readFileSync(endpoint, "utf8"));
        assert.ok(match, "The isolated host has not published a valid page endpoint");
        const { url } = JSON.parse(match[1]);
        assert.equal(typeof url, "string", "The isolated page endpoint must contain a URL");
        return url;
      },
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
