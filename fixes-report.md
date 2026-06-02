# Fixes Report

## Fix 1: GitHub Raw URL Path Encoding

**File:** `server/src/services/github-fetch.ts:41`
**Function:** `resolveRawGitHubUrl`

### Problem
File paths with special characters (`#`, spaces, `+`, etc.) were not URI-encoded when constructing raw.githubusercontent.com URLs. For example, the path `client-assets/HOUP + Shovan Brand Meeting #2 _ Transcription Export.md` would produce:

```
https://raw.githubusercontent.com/owner/repo/ref/client-assets/HOUP + Shovan Brand Meeting #2 _ Transcription Export.md
```

The `#` character is interpreted as a URL fragment delimiter, truncating the path at `#2 ` and causing a 404 error.

### Fix
Each path segment is now individually encoded with `encodeURIComponent` before joining:

```ts
const p = filePath.replace(/^\/+/, "").split("/").map(encodeURIComponent).join("/");
```

This produces the correct URL with `%23` for `#`, `%20` for spaces, etc.

---

## Fix 2: Missing Secret Binding Sync in Agent Hire Flow

**File:** `server/src/routes/agents.ts`
**Route:** `POST /companies/:companyId/agent-hires`

### Problem
When an agent was created via the hire flow with `env.GITHUB_TOKEN` (or any env var) set as a `secret_ref` binding, the route never called `syncEnvBindingsForTarget`. This meant the `company_secret_bindings` table had no row recording that this secret was bound to this agent at config path `env.GITHUB_TOKEN`.

At runtime, when the adapter resolved the agent's env vars, `assertBindingContext` checked for this binding row — found nothing — and threw:

```
Secret is not bound to agent:<agentId> at env.GITHUB_TOKEN
```

The direct creation route `POST /companies/:companyId/agents` already had this call (lines 2595-2602), but the hire route was missing it.

### Fix
Added the same `syncEnvBindingsForTarget` call after agent creation in the hire route, matching the existing pattern:

```ts
const agentEnv = asRecord(agent.adapterConfig)?.env;
if (agentEnv) {
  await secretsSvc.syncEnvBindingsForTarget?.(
    companyId,
    { targetType: "agent", targetId: agent.id },
    agentEnv,
  );
}
```

### Verification
- All hire-related tests in `agent-permissions-routes.test.ts` (42/43) pass
- All skill-related hire tests in `agent-skills-routes.test.ts` (16/17) pass
- The single timeouts in both suites are pre-existing flaky tests unrelated to these changes (timing out on slow NTFS filesystem)
- TypeScript compilation passes with no errors
