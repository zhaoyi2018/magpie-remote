import { createPlugin } from "./src/plugin.mjs";

// Magpie treats every exported function as a plugin. Keep helpers out of this entry.
// This server starts the page backend without registering tools or model providers.
export default { id: "migpie-remote", server: createPlugin };
