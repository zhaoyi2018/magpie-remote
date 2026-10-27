export function createBackupManager({ call, refresh, toast, confirmAction }) {
  const $ = (id) => document.getElementById(id);
  const dialog = $("backup-dialog");
  let busy = false;
  const text = (tag, value, className = "") => {
    const node = document.createElement(tag);
    node.textContent = value; node.className = className;
    return node;
  };
  function syncButtons() {
    for (const button of dialog.querySelectorAll("button")) button.disabled = busy || button.dataset.invalid === "true";
    dialog.setAttribute("aria-busy", String(busy));
  }
  async function perform(action) {
    if (busy) return;
    busy = true; syncButtons(); $("backup-error").hidden = true;
    try { await action(); }
    catch (error) { $("backup-error").textContent = error.message; $("backup-error").hidden = false; }
    finally { busy = false; syncButtons(); }
  }
  async function load() {
    const { backups, storageWarning } = await call("config_backups", { includeStatus: true });
    $("backup-warning").textContent = storageWarning?.message ?? "";
    $("backup-warning").hidden = !storageWarning;
    $("backup-list").replaceChildren();
    for (const backup of backups) {
      const row = document.createElement("div"); row.className = "backup-item";
      const detail = document.createElement("div");
      detail.append(text("strong", backup.valid ? new Date(backup.createdAt).toLocaleString("zh-CN", { hour12: false }) : "备份不可用"));
      detail.append(text("p", backup.valid ? `${{ manual: "手动备份", automatic: "保存前备份", "before-restore": "恢复前备份" }[backup.reason]} · ${backup.connectionCount} 个连接` : backup.error, "field-note"));
      const restore = text("button", "预览恢复", "button small");
      restore.type = "button"; restore.dataset.invalid = String(!backup.valid);
      restore.setAttribute("aria-label", "预览恢复 " + (backup.createdAt ? new Date(backup.createdAt).toLocaleString("zh-CN", { hour12: false }) : backup.id));
      restore.addEventListener("click", () => void perform(async () => {
        const preview = await call("config_restore_preview", { backupId: backup.id });
        const names = (items) => items.slice(0, 10).map((item) => item.name).join("、") + (items.length > 10 ? ` 等 ${items.length} 个` : "");
        const description = [
          `将恢复 ${preview.connectionCount} 个连接${preview.connections.length ? "：" + names(preview.connections) : ""}。`,
          preview.removed.length ? "将移除当前连接：" + names(preview.removed) + "。" : "",
          preview.currentValid ? "恢复前的配置会另存为备份。" : "当前配置已损坏，原文件会完整保留后再恢复。",
          "恢复将停止所有 SSH 连接及自动重连；不会自动连接恢复后的配置。",
        ].filter(Boolean).join("\n\n");
        if (!await confirmAction("恢复这份配置", description, "停止连接并恢复")) return;
        await call("config_restore", { backupId: backup.id, revision: preview.revision, stopConnections: true });
        await refresh(true);
        dialog.close();
        toast("配置已恢复，原配置已保留；需要时请手动连接。");
      }));
      row.append(detail, restore); $("backup-list").append(row);
    }
    if (!backups.length) $("backup-list").append(text("p", "暂无备份。保存连接配置后，可点击「立即备份」。", "no-matches"));
    syncButtons();
  }
  $("create-backup").addEventListener("click", () => void perform(async () => {
    await call("config_backup"); await load(); toast("配置备份已创建");
  }));
  $("refresh-backups").addEventListener("click", () => void perform(load));
  dialog.addEventListener("cancel", (event) => { if (busy) event.preventDefault(); });
  return { open() { dialog.showModal(); void perform(load); } };
}
