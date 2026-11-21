import { readFileSync, readdirSync, rmSync, lstatSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const root = process.argv[2];
if (!/^\/tmp\/flowai-wui\.[A-Za-z0-9]{8}$/.test(root ?? "")) {
  throw new Error("Invalid Web UI browser resource namespace");
}

function owners() {
  const processes = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(entry)) continue;
    try {
      const dir = `/proc/${entry}`;
      if (lstatSync(dir).uid !== process.getuid()) continue;
      const comm = readFileSync(`${dir}/comm`, "utf8").trim();
      if (!/^(node|chrome|chromium)/.test(comm)) continue;
      const env = readFileSync(`${dir}/environ`, "utf8").split("\0");
      const args = readFileSync(`${dir}/cmdline`, "utf8").split("\0");
      if (
        env.includes(`FLOWAI_BROWSER_OWNER=${root}`) ||
        args.some((arg) => arg.startsWith(`--user-data-dir=${root}/`))
      ) {
        processes.push(Number(entry));
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  }
  return processes;
}

let stragglers = owners();
const leaked = stragglers.length > 0;
for (const signal of ["SIGTERM", "SIGKILL"]) {
  if (!stragglers.length) break;
  for (const pid of stragglers) {
    if (!owners().includes(pid)) continue;
    try {
      process.kill(pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (let attempt = 0; attempt < 30 && stragglers.length; attempt++) {
    await delay(100);
    stragglers = owners();
  }
}
if (stragglers.length) throw new Error("Web UI browser processes remain");
rmSync(root, { recursive: true, force: true });
try {
  lstatSync(root);
  throw new Error("Web UI browser directory remains");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
console.log("Web UI browser process and temporary directory absence verified");
if (leaked) throw new Error("Web UI processes required forced cleanup");
