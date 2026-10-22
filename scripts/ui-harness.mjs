import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

// A development-only parent frame with Magpie's documented allow-scripts
// sandbox and launch-page policy. The SSH backend still runs in the real host.
export async function startUIHarness() {
  const prefix = "/_magpie/plugin/ui-test/";
  const root = new URL("../page/", import.meta.url);
  let origin;
  const server = createServer((request, response) => {
    void serve(request, response).catch(() => { response.writeHead(404); response.end(); });
  });
  async function serve(request, response) {
    response.setHeader("Cache-Control", "no-store");
    const path = new URL(request.url, origin).pathname;
    if (path === "/favicon.ico") { response.setHeader("Content-Type", "image/svg+xml"); return response.end(await readFile(new URL("icon.svg", root))); }
    if (path === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      return response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Magpie · SSH 连接</title><style>body{margin:0;font:13px system-ui;background:#f7f9f8;color:#223a30}nav{position:fixed;inset:0 auto 0 0;width:165px;padding:25px 18px;box-sizing:border-box;border-right:1px solid #e0e8e2;background:#f1f5f2}h1{font-size:20px;margin:0 0 35px}small{font-size:10px;color:#7e8c85;letter-spacing:1px}p{padding:10px;background:#e2eee6;border-radius:7px}iframe{margin-left:165px;width:calc(100vw - 165px);height:100vh;border:0;display:block}button{border:1px solid #ccd9d0;background:white;border-radius:6px;padding:6px 10px;margin-top:25px;color:#466052;font:inherit}</style><script src="/parent.js" defer></script></head><body><nav><h1>magpie</h1><small>PLUGINS</small><p>↔　SSH 连接</p><button id="theme">切换深浅色</button></nav><iframe title="SSH 连接" src="${prefix}index.html" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe></body></html>`);
    }
    if (path === "/parent.js") {
      response.setHeader("Content-Type", "text/javascript");
      return response.end(`let dark=false; const theme=()=>({dark,lang:'zh',tokens:{}}); addEventListener('message',e=>{if(e.source!==document.querySelector('iframe').contentWindow||e.data?.magpie!==1)return;if(e.data.method==='hello')e.source.postMessage({magpie:1,id:e.data.id,result:theme()},'*');});document.getElementById('theme').onclick=()=>{dark=!dark;document.querySelector('iframe').contentWindow.postMessage({magpie:1,event:'theme',data:theme()},'*');};`);
    }
    if (!path.startsWith(prefix)) { response.writeHead(404); return response.end(); }
    response.setHeader("Content-Security-Policy", `default-src 'none'; script-src ${origin}; style-src ${origin} 'unsafe-inline'; img-src ${origin} data:; connect-src 'none'; frame-src 'none'; form-action 'none'; sandbox allow-scripts`);
    const file = path.slice(prefix.length);
    if (file === "_magpie/bridge.js") {
      response.setHeader("Content-Type", "text/javascript");
      return response.end(`window.magpie={ready:new Promise(resolve=>{addEventListener('message',e=>{if(e.source===parent&&e.data?.id==='launch-ready')resolve(e.data.result);});parent.postMessage({magpie:1,id:'launch-ready',method:'hello'},'*');})};`);
    }
    const types = { "index.html": "text/html; charset=utf-8", "launch.js": "text/javascript", "launch.css": "text/css", "theme.js": "text/javascript", "icon.svg": "image/svg+xml", ".runtime/endpoint.js": "text/javascript" };
    if (!Object.hasOwn(types, file)) { response.writeHead(404); return response.end(); }
    const data = await readFile(new URL(file, root));
    response.setHeader("Content-Type", types[file]);
    response.end(data);
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { url: `${origin}/`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
