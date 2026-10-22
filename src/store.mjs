import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { identifier, validateProfile } from "./config.mjs";

export class ProfileStore {
  #pending = Promise.resolve();

  constructor(file) {
    this.file = file;
  }

  async list() {
    let data;
    try {
      data = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("无法读取连接配置文件，请检查文件权限和 JSON 格式", { cause: error });
    }
    if (data.version !== 1 || !Array.isArray(data.connections)) {
      throw new Error("连接配置文件的版本或结构无效");
    }
    const profiles = data.connections.map(validateProfile);
    if (new Set(profiles.map((profile) => profile.id)).size !== profiles.length) {
      throw new Error("连接配置文件包含重复 id");
    }
    return profiles;
  }

  async get(id) {
    identifier(id);
    const profile = (await this.list()).find((item) => item.id === id);
    if (!profile) throw new Error(`连接 ${id} 不存在`);
    return profile;
  }

  save(value) {
    const profile = validateProfile(value);
    return this.#change(async (profiles) => {
      const index = profiles.findIndex((item) => item.id === profile.id);
      if (index === -1) profiles.push(profile);
      else profiles[index] = profile;
      return profile;
    });
  }

  remove(id) {
    identifier(id);
    return this.#change(async (profiles) => {
      const index = profiles.findIndex((item) => item.id === id);
      if (index === -1) throw new Error(`连接 ${id} 不存在`);
      profiles.splice(index, 1);
      return { id, removed: true };
    });
  }

  importProfiles(values) {
    const incoming = values.map(validateProfile);
    if (new Set(incoming.map((profile) => profile.id)).size !== incoming.length) throw new Error("导入的连接 id 不能重复");
    return this.#change(async (profiles) => {
      const ids = new Set(profiles.map((profile) => profile.id));
      const imported = [], skipped = [];
      for (const profile of incoming) {
        if (ids.has(profile.id)) { skipped.push({ id: profile.id, reason: "连接已存在，未覆盖" }); continue; }
        profiles.push(profile); ids.add(profile.id); imported.push(profile);
      }
      return { imported, skipped };
    });
  }

  #change(update) {
    const operation = this.#pending.then(async () => {
      const profiles = await this.list();
      const result = await update(profiles);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, connections: profiles }, null, 2)}\n`, {
          flag: "wx", mode: 0o600,
        });
        await rename(temporary, this.file);
      } finally {
        await rm(temporary, { force: true });
      }
      return result;
    });
    this.#pending = operation.catch(() => {});
    return operation;
  }
}
