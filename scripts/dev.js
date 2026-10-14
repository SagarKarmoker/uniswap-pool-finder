import { spawn } from "node:child_process";

const procs = [
  ["api", "node", ["server.js"]],
  ["vite", process.platform === "win32" ? "node" : "node", ["./node_modules/vite/bin/vite.js"]],
];

const children = procs.map(([name, cmd, args]) => {
  const child = spawn(cmd, args, { stdio: "inherit", shell: false });
  child.on("exit", (code) => {
    console.log(`[${name}] exited with code ${code}`);
    shutdown();
  });
  return child;
});

function shutdown() {
  for (const c of children) {
    if (!c.killed) c.kill();
  }
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);