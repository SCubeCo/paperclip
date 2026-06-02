import { unprocessable } from "../errors.js";

function isGitHubDotCom(hostname: string) {
  const h = hostname.toLowerCase();
  return h === "github.com" || h === "www.github.com";
}

function readGitHubTokenFromEnv(): string | null {
  const candidate = process.env.PAPERCLIP_GITHUB_TOKEN
    ?? process.env.GITHUB_TOKEN
    ?? process.env.GH_TOKEN
    ?? "";
  const token = candidate.trim();
  return token.length > 0 ? token : null;
}

function isAuthEligibleGitHubHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (
    h === "github.com"
    || h === "www.github.com"
    || h === "api.github.com"
    || h === "raw.githubusercontent.com"
    || h === "codeload.github.com"
    || h === "objects.githubusercontent.com"
  ) {
    return true;
  }

  const extraHosts = (process.env.PAPERCLIP_GITHUB_AUTH_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return extraHosts.includes(h);
}

export function gitHubApiBase(hostname: string) {
  return isGitHubDotCom(hostname) ? "https://api.github.com" : `https://${hostname}/api/v3`;
}

export function resolveRawGitHubUrl(hostname: string, owner: string, repo: string, ref: string, filePath: string) {
  const p = filePath.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
  return isGitHubDotCom(hostname)
    ? `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p}`
    : `https://${hostname}/raw/${owner}/${repo}/${ref}/${p}`;
}

export async function ghFetch(url: string, init?: RequestInit): Promise<Response> {
  try {
    const parsed = new URL(url);
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization") && isAuthEligibleGitHubHost(parsed.hostname)) {
      const token = readGitHubTokenFromEnv();
      if (token) {
        headers.set("authorization", `Bearer ${token}`);
      }
    }

    return await fetch(url, {
      ...init,
      headers,
    });
  } catch {
    throw unprocessable(`Could not connect to ${new URL(url).hostname} — ensure the URL points to a GitHub or GitHub Enterprise instance`);
  }
}
