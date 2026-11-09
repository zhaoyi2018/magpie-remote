const escapeData = (value) => String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (value) => escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

// Keep the first useful failure in the public job annotations, alongside the
// complete artifact log. This also helps readers who cannot open GitHub logs.
export function failureAnnotation(check, log = "") {
  const lines = log.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").split(/\r?\n/);
  const summary = lines.findIndex((line) => /^\s*[✖×]\s+failing tests:/i.test(line));
  const first = summary >= 0 ? summary : lines.findIndex((line) => /^\s*(?:not ok\b|[✖×]|\(fail\)|error:|(?:Assertion|Syntax|Type|Reference)?Error\b)/i.test(line));
  const details = (first >= 0 ? lines.slice(Math.max(0, first - 2), first + 48) : lines.slice(-50)).join("\n").trim();
  const message = [check.reason || "Command failed", check.code === undefined ? "" : "Exit code: " + check.code, details].filter(Boolean).join("\n").slice(0, 8000);
  return "::error title=" + escapeProperty("Verification: " + check.id) + "::" + escapeData(message);
}
