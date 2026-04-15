import { spawn, type ChildProcess } from "child_process";
import path from "path";

const ROOT = import.meta.dir;
const FRONTEND = path.join(ROOT, "frontend");
const VENV_PYTHON = path.join(ROOT, ".venv", "bin", "python3");

const procs: { name: string; proc: ChildProcess }[] = [];

function run(name: string, cmd: string, args: string[], cwd = ROOT, restart = false) {
  function launch() {
    const proc = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
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

run("bot", "bun", ["run", "index.ts"]);
run("api", "bun", ["run", "backend.ts"], ROOT, true);
run("dashboard", "bun", ["run", "dev"], FRONTEND);
run("telegram", VENV_PYTHON, ["telegram_bot.py"], ROOT, true);

console.log("  Bot:       running (every 2 min)");
console.log("  API:       http://localhost:3000");
console.log("  Dashboard: http://localhost:5173");
console.log("  Telegram:  @natetradiobot (polling, restart on crash)\n");

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  for (const { name, proc } of procs) {
    proc.kill();
    console.log(`  [${name}] stopped`);
  }
  process.exit(0);
});
