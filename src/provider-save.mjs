import { OperationError } from "./errors.mjs";

// Match the Web editor's save input, not the enriched /api/providers view.
// In particular, balanceToken/testsAs/keyList are status or masked-secret
// objects in the view; models is metadata while the save input wants IDs.
const editableFields = [
  "icon", "iconFrom", "gemini", "decide", "catalog", "keysUrl", "baseAPI",
  "headers", "extraBody", "replyHeaders", "passHeaders", "modelsURL",
  "balanceURL", "balancePath", "balanceMethod", "authHeader",
  "searches", "pinUpstream", "unredacted", "countFree", "insecureTLS",
  "limitRestOff", "nativeCompaction", "passUserAgent", "fallback", "unlisted",
  "hiddenDrawers", "noModels", "bestInFamily", "contexts", "outputs", "compacts",
  "accountProxies", "maxConcurrency", "maxAccounts", "queueLimit", "queueWait",
  "maxRPM", "priceRate", "rateWindows", "modelPrefs", "routing", "affinity", "sink",
];

function selectedModels(provider) {
  if (!provider) return [];
  if (Array.isArray(provider.chosen)) {
    if (provider.chosen.some((model) => typeof model !== "string")) throw new OperationError("PROVIDER_LINK_API", "远端供应商的模型选择结构不受支持，未覆盖设置");
    return [...provider.chosen];
  }
  if (provider.models === undefined) return undefined;
  if (!Array.isArray(provider.models)) throw new OperationError("PROVIDER_LINK_API", "远端供应商的模型列表结构不受支持，未覆盖设置");
  if (provider.models.every((model) => typeof model === "string")) return [...provider.models];
  if (provider.models.some((model) => !model || typeof model !== "object" || typeof model.id !== "string")) throw new OperationError("PROVIDER_LINK_API", "远端供应商的模型列表结构不受支持，未覆盖设置");
  return provider.models.filter((model) => model.on).map((model) => model.id);
}

export function providerSaveRequest(existing, { id, mode, endpoint, key }) {
  const settings = Object.fromEntries(editableFields.filter((field) => existing?.[field] !== undefined)
    .map((field) => [field, structuredClone(existing[field])]));
  const models = selectedModels(existing);
  return { ...settings, id, ...(existing && { from: existing.id }),
    name: existing?.name ?? (mode === "direct" ? "局域网 Magpie" : "局域网 Magpie（SSH）"),
    preset: "remote-magpie", chat: endpoint + "/v1", responses: endpoint + "/v1", anthropic: endpoint,
    key, proxy: existing?.proxy ?? "direct", new: !existing, ...(models !== undefined && { models }) };
}
