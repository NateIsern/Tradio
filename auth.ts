import { execSync } from "child_process";

let cachedToken: string | null = null;
let tokenExpiry = 0;

export function getAuthToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiry - 60) {
    return cachedToken;
  }

  const output = execSync("python3 generate-token.py 2>/dev/null", {
    cwd: import.meta.dir,
    env: process.env,
  }).toString().trim();

  if (output.startsWith("ERROR:")) {
    throw new Error(`Auth token generation failed: ${output}`);
  }

  cachedToken = output;
  const deadline = parseInt(output.split(":")[0] ?? "0", 10);
  tokenExpiry = deadline;
  return cachedToken;
}

// Async HTTP GET against the Lighter API. Uses Bun's native fetch (HTTP/2 capable,
// non-blocking) so Promise.all actually parallelizes — this is the difference
// between a ~40s cycle (execSync curl per market) and a ~5s cycle.
export async function fetchH2(url: string, token: string): Promise<string> {
  const response = await fetch(url, {
    headers: {
      Authorization: token,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Lighter API ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.text();
}
