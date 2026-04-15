import { spawn, type ChildProcess } from "child_process";
import path from "path";

const ROOT = import.meta.dir;
const FRONTEND = path.join(ROOT, "frontend");

const procs: { name: string; proc: ChildProcess }[] = [];

function run(name: string, cmd: string, args: string[], cwd = ROOT, restart = false) {
  function launch() {
    // `detached: true` gives each child its own process group. On shutdown
    // we signal the whole group so any bun sub-processes or hot-reload
    // workers die with the parent — no orphans left holding port 3001.
    const proc = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });

    proc.stdout?.on("data", (d: Buffer) => {
      for (const line of d.toString().trimEnd().split("\n")) {
        console.log(`[${name}] ${line}`);
      }
    });

    proc.stderr?.on("data", (d: Buffer) => {
      for (const line of d.toString().trimEnd().split("\n")) {
        if (line.includes("Unclosed client session")) return;
        console.error(`[${name}] ${line}`);
      }
    });

    proc.on("exit", (code) => {
      console.log(`[${name}] exited (${code})`);
      if (restart && code !== null) {
        console.log(`[${name}] restarting in 2s...`);
        setTimeout(() => {
          const idx = procs.findIndex(p => p.name === name);
          if (idx !== -1) procs.splice(idx, 1);
          run(name, cmd, args, cwd, restart);
        }, 2000);
      }
    });

    procs.push({ name, proc });
    return proc;
  }

  return launch();
}

console.log("Starting Tradio...\n");

// Bot: Bun's --hot reloads the module graph in-place on save.
// API: Bun's --watch restarts the whole process (reliable port rebind for
//      Express; --hot leaks listeners and causes EADDRINUSE on reload).
// Dashboard: Vite HMR handles frontend hot reload on its own.
run("bot", "bun", ["--hot", "run", "index.ts"]);
run("api", "bun", ["--watch", "run", "backend.ts"], ROOT, true);
run("dashboard", "bun", ["run", "dev"], FRONTEND);

console.log("  Bot:       running (hot reload)");
console.log("  API:       http://localhost:3001 (watch restart)");
console.log("  Dashboard: http://localhost:5173 (vite HMR)\n");

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down...");
  for (const { name, proc } of procs) {
    try {
      // Negative pid = process group. Kills the bun child AND any
      // sub-processes it forked (hot-reload workers, etc).
      if (proc.pid) process.kill(-proc.pid, "SIGTERM");
    } catch {
      // process already dead
    }
    console.log(`  [${name}] stopped`);
  }
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
