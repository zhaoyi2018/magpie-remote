import { createPlugin } from "./src/plugin.mjs";

// Magpie treats every exported function as a plugin. Keep helpers out of this entry.
export default { id: "migpie-remote", server: createPlugin };
