import { randomBytes } from "node:crypto";
import { rename, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

export async function publishFile(file, contents, { replace = rename, platform = process.platform } = {}) {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, contents, { flag: "wx", mode: 0o600 });
    for (let attempt = 0; ; attempt++) {
      try { await replace(temporary, file); break; }
      catch (error) {
        // WebView and antivirus readers can briefly prevent replacement on
        // Windows. Keep the old complete file until the atomic rename succeeds.
        if (platform !== "win32" || !["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 6) throw error;
        await delay(25 * 2 ** attempt);
      }
    }
  } finally { await rm(temporary, { force: true }).catch(() => {}); }
}
