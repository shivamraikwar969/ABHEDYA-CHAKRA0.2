// One command for everything:  npm start   -> API/auth service (8787) + Vite dev server (5173). Cross-platform, no extra packages.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, tag) => {
  const p = spawn(cmd, args, { cwd: root, stdio: "inherit", shell: process.platform === "win32" });
  p.on("exit", (c) => { console.log(`[${tag}] exited (${c})`); process.exit(c ?? 0); });
  return p;
};
const api = run(process.execPath, ["server/llm-server.mjs"], "api");
const web = run("npx", ["vite"], "web");
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { api.kill(); web.kill(); process.exit(0); });
