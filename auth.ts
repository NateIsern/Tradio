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

export function fetchH2(url: string, token: string): string {
  return execSync(
    `curl -s --http2 -H "Authorization: ${token}" -H "Content-Type: application/json" -H "Accept: application/json" "${url}"`,
  ).toString();
}
