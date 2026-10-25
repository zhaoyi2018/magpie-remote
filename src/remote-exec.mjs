import { StringDecoder } from "node:string_decoder";
import { OperationError } from "./errors.mjs";

// Internal transport only; public tools accept named Magpie actions, never shell text.
export function executeRemote(client, command, { input = "", signal, timeoutMs = 30000, maxBytes = 262144 } = {}) {
  return new Promise((resolve, reject) => {
    let stream, finished = false, size = 0, stdout = "", stderr = "";
    const out = new StringDecoder("utf8"), err = new StringDecoder("utf8");
    const finish = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      client.removeListener("close", disconnected);
      if (error) { stream?.destroy(); reject(error); }
      else resolve(result);
    };
    const cancel = () => finish(new OperationError("REMOTE_CANCELLED", "远端请求已中止；变更结果需重新检测"));
    const disconnected = () => finish(new OperationError("REMOTE_DISCONNECTED", "SSH 已断开，远端操作结果待核实"));
    const timer = setTimeout(() => finish(new OperationError("REMOTE_TIMEOUT", "远端操作超时，请重新检测实际状态")), timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    client.once("close", disconnected);
    if (signal?.aborted) { cancel(); return; }
    const collect = (chunk, decoder, destination) => {
      size += chunk.length;
      if (size > maxBytes) return finish(new OperationError("REMOTE_OUTPUT_LIMIT", "远端响应超过大小限制，结果需重新检测"));
      if (destination === "out") stdout += decoder.write(chunk);
      else stderr += decoder.write(chunk);
    };
    client.exec(command, { pty: false }, (error, channel) => {
      if (finished) { channel?.on("error", () => {}); channel?.destroy(); return; }
      if (error) return finish(new OperationError("REMOTE_EXEC_FAILED", "服务器拒绝执行远端管理命令", { cause: error }));
      stream = channel;
      stream.on("error", () => finish(new OperationError("REMOTE_DISCONNECTED", "远端通道中断，操作结果待核实")));
      stream.on("data", (chunk) => collect(chunk, out, "out"));
      stream.stderr.on("error", () => finish(new OperationError("REMOTE_DISCONNECTED", "远端错误通道中断，操作结果待核实")));
      stream.stderr.on("data", (chunk) => collect(chunk, err, "err"));
      stream.once("close", (code, exitSignal) => {
        if (!Number.isInteger(code) || exitSignal) return finish(new OperationError("REMOTE_RESULT_UNKNOWN", "远端未返回明确退出状态，请重新检测"));
        finish(undefined, { code, stdout: stdout + out.end(), stderr: stderr + err.end() });
      });
      stream.end(input);
    });
  });
}
