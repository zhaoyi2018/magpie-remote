import { lstat, readFile } from "node:fs/promises";
import { publishFile } from "./publish-file.mjs";

function validateView(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["connectionId", "tab", "operationId"].includes(key))
    || typeof value.connectionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.connectionId)
    || !["forwards", "remote", "connection", "logs"].includes(value.tab)
    || (value.operationId !== undefined && (typeof value.operationId !== "string"
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.operationId)))) {
    throw new Error("无效的管理页视图");
  }
  return { connectionId: value.connectionId, tab: value.tab, ...(value.operationId && { operationId: value.operationId }) };
}

export function managementView(file) {
  const initial = (async () => {
    try {
      const metadata = await lstat(file);
      if (!metadata.isFile() || metadata.size > 1024) return null;
      return validateView(JSON.parse(await readFile(file, "utf8")));
    } catch { return null; }
  })();
  let latest = initial, writes = Promise.resolve();
  return {
    read: () => latest,
    async save(value) {
      const view = validateView(value);
      const contents = JSON.stringify(view);
      const write = writes.catch(() => {}).then(async () => {
        if (JSON.stringify(await latest) === contents) return;
        await publishFile(file, contents + "\n");
        latest = Promise.resolve(view);
      });
      writes = write;
      await write;
    },
    close: () => writes.catch(() => {}),
  };
}
