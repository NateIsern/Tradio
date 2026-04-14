import { spawn } from "child_process";
import path from "path";

const ROOT = import.meta.dir;
const FRONTEND = path.join(ROOT, "frontend");

const procs: { name: string; proc: ReturnType<typeof spawn> }[] = [];

function run(name: string, cmd: string, args: string[], cwd = ROOT) {
  const proc = spawn(cmd, args, {
    cwd,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
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
  });

  procs.push({ name, proc });
  return proc;
}

console.log("Starting Tradio...\n");

run("bot", "bun", ["run", "index.ts"]);
run("api", "bun", ["run", "backend.ts"]);
run("dashboard", "bun", ["run", "dev"], FRONTEND);

console.log("  Bot:       running (every 5 min)");
console.log("  API:       http://localhost:3000");
console.log("  Dashboard: http://localhost:5173\n");

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  for (const { name, proc } of procs) {
    proc.kill();
    console.log(`  [${name}] stopped`);
  }
  process.exit(0);
});
