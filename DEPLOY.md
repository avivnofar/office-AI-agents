# Deploying `agent-runner.js` to Cloudflare

Quick-reference companion to [`README.md`](./README.md)'s full "Setup" section.
Read that first if you haven't provisioned D1 / Durable Objects / KV / secrets yet —
`agent-runner.js` won't function without those bindings regardless of how the
code gets onto Cloudflare.

## Why this isn't a simple "paste and deploy"

`agent-runner.js` is an ES module with relative imports across this folder:

```
agent-runner.js
├── ../config/agents-config.json
├── ../config/simulation-config.json
├── ../agents/agent-1-perfectionist.js
├── ../agents/agent-2-productive.js
├── ../agents/agent-3-standard.js
├── ../agents/agent-4-trainee.js
├── ../agents/agent-stub.js
└── ../agents/agent-base.js (imported by the above)
    └── ./gemini-client.js
```

Cloudflare's dashboard **Quick Edit** only accepts a single file, so pasting
just `agent-runner.js` into it will fail with module-resolution errors. Use
one of the two options below.

## Option A — Wrangler CLI (recommended)

1. Complete `README.md` Setup steps 1-6 (Gemini key, D1, Durable Objects, KV,
   cron triggers, `ADMIN_TOKEN`). `agents/wrangler.toml` already binds `DB`,
   `AGENT_STATE`, and `SIM_KV` and points `main` at `workers/agent-runner.js`
   (which re-exports `AgentStateDO` from `state-manager.js` for the DO
   binding).
2. Authenticate once with `npx wrangler login` (or set `CLOUDFLARE_API_TOKEN`
   for non-interactive use), then set the secrets:
   ```bash
   npx wrangler secret put GEMINI_API_KEY
   npx wrangler secret put GROQ_API_KEY
   npx wrangler secret put ADMIN_TOKEN
   npx wrangler secret put GITHUB_TOKEN   # optional
   npx wrangler secret put GOOGLE_AI_API_KEY   # optional
   ```
3. From this repo's root:
   ```bash
   npx wrangler deploy
   ```
4. The scheduler's cron-driven cycles run from `agent-runner.js`'s own
   `scheduled()` handler (see its header comment) — no separate
   `data-center-scheduler` Worker is deployed. Add cron triggers to
   `wrangler.toml` only when ready for the quarter-run (see
   `TOKEN-BUDGET.md`).

## Option B — Dashboard multi-file editor

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages
   → Create → Create Worker**, name it `data-center-agents`.
2. Open the editor. Use **+ New file** to recreate the folder structure above
   (same relative paths), pasting each file's contents from this repo.
3. Set `agent-runner.js` as the entry point (Settings → Build → Entry point).
4. Under **Settings → Bindings**, add the `DB` (D1), `AGENT_STATE` (Durable
   Object), and `SIM_KV` (KV) bindings from `README.md` step 2-4.
5. Under **Settings → Variables**, add encrypted secrets `GEMINI_API_KEY` and
   `ADMIN_TOKEN`.
6. Click **Deploy**.

## Verify it's working

```bash
curl -s https://data-center-agents.avivnofar.workers.dev/api/agents/status \
  -H "X-Admin-Token: <your ADMIN_TOKEN>"
```

Expected: a JSON array with one object per agent (id 1-11), each with `mood`,
`irritation`, `status`, etc. A `401 {"error":"unauthorized"}` means the token
header didn't match the Worker's `ADMIN_TOKEN` secret. A `500`/connection
error usually means a binding (`DB`, `AGENT_STATE`, or `SIM_KV`) is missing.

Once `/api/agents/status` returns data, the in-app 🔐 Admin tab in
`data-center` (and this repo's `dashboard/admin-panel.html`) will load
against `CONFIG.AGENTS_API_BASE` in `index.html`.
