import { createPlugin } from "./src/plugin.mjs";

// Magpie treats every exported function as a plugin. Keep helpers out of this entry.
// This server supplies tools for the page; it declares no auth or model provider hooks.
export default { id: "migpie-remote", server: createPlugin };
