# Yantra Auth demo app

A small web app that signs people in through a Yantra Auth workspace, plus a small API that checks
their access tokens. Use it to try sign-in, consent, scopes, refresh, revoke and sign-out by hand.

## Set up the workspace (console)

1. **APIs → Add API**
   - Name: e.g. `Accounts`
   - Identifier: any URI, e.g. `https://accounts.example.com/api` (it doesn't have to resolve)
   - Permissions: resource `accounts`, actions `read`, `create`, `manage`
   - Save. Scopes `accounts:read`, `accounts:create` and `accounts:manage` are created.
2. **Applications → Create application**
   - Name `Demo App`, client type **Confidential (Web App)**
   - Redirect URI: `http://localhost:4000/callback`
   - Create, then copy the **Client ID** and **Client secret** (the secret is shown once).
3. Open the app → **Sign-in and tokens**
   - Grant types: authorization code and refresh token are on by default.
   - Post-logout URLs: `http://localhost:4000/signed-out` → **Save URLs**.

## Run

```sh
npm install
AUTH_URL=https://auth-xxxxxx.yantra.app CLIENT_ID=... CLIENT_SECRET=... API_IDENTIFIER=... npm start
```

Open http://localhost:4000.

| Variable | What it is | Default |
| --- | --- | --- |
| `API_IDENTIFIER` | The API's identifier (APIs page). Required | none |
| `SCOPES` | Scopes asked for at sign-in | `openid profile email offline_access accounts:read` |
| `PERMISSIONS` | Permissions the API checks, one button each | `accounts:read accounts:create accounts:manage` |
| `MORE_SCOPES` | Extra scopes for "Ask for more access" | same as `PERMISSIONS` |
| `PORT` | Port; the redirect URI must match | `4000` |

**Public app (PKCE only):** create the app with client type **Public** instead and leave out
`CLIENT_SECRET`. The demo then sends `client_id` in the token request with no secret. The page header
says which mode it's in.

## Routes

- `/login` (`?scope=` to ask for more), `/callback`, `/refresh`, `/logout` → workspace end-session → `/signed-out`
- `/api/protected?need=<permission>`: 200 if the token's `permissions` claim has it, 403 if not, 401 for a bad token
# yantra-auth-demo

## MCP server

`mcp-server.mjs` is a small MCP server ("demo notes") protected by the workspace, built with
`@yantra-app/cloud-auth-js/mcp`. Tools: `whoami`, `list_notes` (needs `notes:read`), `add_note` (needs `notes:write`).

1. **APIs → Add API**: tick **This is an MCP server**, identifier `http://localhost:3001/mcp`,
   resource `notes` with `read` and `write`. Save.
2. **Workspace settings → AI tools (MCP)**: tick **Let AI tools connect themselves**, click
   **Add common AI tools**, Save.
3. Run it: `AUTH_URL=https://auth-xxxxxx.yantra.app npm run mcp`
   (optional: `MCP_PORT`, `MCP_URL` when it's reachable at another URL, e.g. a tunnel).
4. Connect a client:
   - MCP Inspector: `npx @modelcontextprotocol/inspector`, Streamable HTTP, URL `http://localhost:3001/mcp`, Connect.
   - Claude Code: `claude mcp add --transport http demo-notes http://localhost:3001/mcp`, then `/mcp` → Authenticate.
   - Claude (web/desktop), ChatGPT, Cursor's cloud: they need a public https URL. Run
     `cloudflared tunnel --url http://localhost:3001`, change the API's identifier to
     `https://<tunnel>/mcp`, and start the server with `MCP_URL=https://<tunnel>/mcp`.
