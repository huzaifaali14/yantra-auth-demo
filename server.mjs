// Demo app for a Yantra Auth workspace: a web app that signs people in (authorization code + PKCE),
// and a small protected API that checks the access tokens it gets. One process plays both roles.
import http from "node:http";
import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";

const config = {
  workspace: (process.env.AUTH_URL ?? "").replace(/\/+$/, ""),
  clientId: process.env.CLIENT_ID ?? "",
  clientSecret: process.env.CLIENT_SECRET ?? "",
  api: process.env.API_IDENTIFIER ?? "",
  scopes: process.env.SCOPES ?? "openid profile email offline_access accounts:read",
  // Permissions the API checks, one button each. They come from the token's `permissions` claim,
  // which holds the permissions the granted scopes map to (APIs page → Grants column).
  permissions: (process.env.PERMISSIONS ?? "accounts:read accounts:create accounts:manage").split(/\s+/).filter(Boolean),
  port: Number(process.env.PORT ?? 4000),
};
config.moreScopes = process.env.MORE_SCOPES ?? config.permissions.join(" ");
if (!config.workspace || !config.clientId || !config.api) throw new Error("Set AUTH_URL, CLIENT_ID and API_IDENTIFIER (see README.md)");
// Without a secret the demo acts as a public client: PKCE alone, client_id in the token request body.
const isPublic = !config.clientSecret;

const base = `http://localhost:${config.port}`;
const issuer = `${config.workspace}/api/auth`;
const endpoints = {
  authorize: `${issuer}/oauth2/authorize`,
  token: `${issuer}/oauth2/token`,
  userinfo: `${issuer}/oauth2/userinfo`,
  endSession: `${issuer}/oauth2/end-session`,
};
const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`));

// In-memory sessions: fine for a demo, lost on restart.
const sessions = new Map();
const pending = new Map();

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const decode = (jwt) => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString());
const esc = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const json = (v) => `<pre>${esc(JSON.stringify(v, null, 2))}</pre>`;

function sessionOf(req) {
  const id = /(?:^|;\s*)demo_sid=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
  return id ? sessions.get(id) : undefined;
}

async function tokenRequest(params) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (!isPublic) headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  const res = await fetch(endpoints.token, {
    method: "POST",
    headers,
    body: new URLSearchParams(isPublic ? { ...params, client_id: config.clientId } : params),
  });
  return { status: res.status, body: await res.json() };
}

// The protected API: what your real backend would do with the access token.
async function protectedApi(req, needed) {
  const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
  if (!token) return { status: 401, body: { error: "missing token" } };
  let claims;
  try {
    ({ payload: claims } = await jwtVerify(token, jwks, { issuer, audience: config.api }));
  } catch (e) {
    return { status: 401, body: { error: "invalid token", reason: e.code ?? e.message } };
  }
  if (!(claims.permissions ?? []).includes(needed)) {
    return { status: 403, body: { error: "insufficient_scope", needed, youHave: claims.permissions ?? [] } };
  }
  return { status: 200, body: { allowed: needed, user: claims.sub, client: claims.azp, permissions: claims.permissions } };
}

function page(res, s, note = "") {
  const at = s?.tokens?.access_token;
  const body = !s
    ? `${note}<p>You're signed out.</p><p><a class="btn" href="/login">Sign in</a></p>`
    : `
      <p>Signed in as <b>${esc(s.user?.email ?? s.user?.sub)}</b></p>
      <p class="row">
        ${config.permissions.map((p) => `<a class="btn" href="/call?need=${encodeURIComponent(p)}">Call API needing ${esc(p)}</a>`).join("\n        ")}
        <a class="btn alt" href="/login?scope=${encodeURIComponent(`${config.scopes} ${config.moreScopes}`)}">Ask for more access</a>
        <a class="btn alt" href="/refresh">Refresh tokens</a>
        <a class="btn alt" href="/logout">Sign out</a>
      </p>
      ${note}
      <h3>User (from userinfo)</h3>${json(s.user)}
      <h3>Access token claims</h3>${at?.includes(".") ? json(decode(at)) : "<p>(opaque token)</p>"}
      <h3>Granted scopes</h3><p><code>${esc(s.tokens.scope ?? "")}</code></p>`;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Auth demo</title>
<style>
  body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:32px auto;padding:0 16px;color:#1b1b1f;background:#fafafa}
  @media (prefers-color-scheme:dark){body{color:#e8e8ea;background:#141416}pre{background:#1e1e22!important}}
  pre{background:#f0f0f2;padding:12px;border-radius:8px;overflow:auto;font-size:13px}
  .btn{display:inline-block;padding:8px 14px;border-radius:8px;background:#4f46e5;color:#fff;text-decoration:none;margin:0 6px 6px 0}
  .btn.alt{background:#6b7280} .note{padding:10px 12px;border-radius:8px;background:#fef3c7;color:#713f12}
</style>
<h1>Auth demo</h1><p>Workspace: <code>${esc(config.workspace)}</code> · API: <code>${esc(config.api)}</code> · ${isPublic ? "public client (PKCE only)" : "confidential client (secret + PKCE)"}</p>${body}`);
}

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const s = sessionOf(req);
    try {
      if (url.pathname === "/api/protected") {
        const r = await protectedApi(req, url.searchParams.get("need") ?? "");
        res.writeHead(r.status, { "content-type": "application/json" });
        return res.end(JSON.stringify(r.body));
      }

      if (url.pathname === "/login") {
        const verifier = b64url(crypto.randomBytes(32));
        const state = b64url(crypto.randomBytes(16));
        pending.set(state, verifier);
        const q = new URLSearchParams({
          response_type: "code",
          client_id: config.clientId,
          redirect_uri: `${base}/callback`,
          scope: url.searchParams.get("scope") ?? config.scopes,
          state,
          code_challenge: b64url(crypto.createHash("sha256").update(verifier).digest()),
          code_challenge_method: "S256",
          resource: config.api,
        });
        res.writeHead(302, { location: `${endpoints.authorize}?${q}` });
        return res.end();
      }

      if (url.pathname === "/callback") {
        const error = url.searchParams.get("error");
        if (error) return page(res, s, `<p class="note">The workspace answered: <b>${esc(error)}</b> ${esc(url.searchParams.get("error_description") ?? "")}</p>`);
        const verifier = pending.get(url.searchParams.get("state"));
        pending.delete(url.searchParams.get("state"));
        if (!verifier) return page(res, s, `<p class="note">Unknown or reused state. Start again.</p>`);
        const t = await tokenRequest({
          grant_type: "authorization_code",
          code: url.searchParams.get("code"),
          redirect_uri: `${base}/callback`,
          code_verifier: verifier,
          resource: config.api,
        });
        if (t.status !== 200) return page(res, s, `<p class="note">Token exchange failed</p>${json(t.body)}`);
        const user = await fetch(endpoints.userinfo, { headers: { authorization: `Bearer ${t.body.access_token}` } })
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null);
        const id = s?.id ?? b64url(crypto.randomBytes(18));
        sessions.set(id, { id, tokens: t.body, user: user ?? (t.body.id_token ? decode(t.body.id_token) : {}) });
        res.writeHead(302, { location: "/", "set-cookie": `demo_sid=${id}; HttpOnly; Path=/; SameSite=Lax` });
        return res.end();
      }

      if (url.pathname === "/call" && s) {
        const need = url.searchParams.get("need") ?? "";
        const r = await fetch(`${base}/api/protected?need=${encodeURIComponent(need)}`, { headers: { authorization: `Bearer ${s.tokens.access_token}` } });
        return page(res, s, `<h3>API needing ${esc(need)} → ${r.status}</h3>${json(await r.json())}`);
      }

      if (url.pathname === "/refresh" && s) {
        if (!s.tokens.refresh_token) return page(res, s, `<p class="note">No refresh token: sign in with offline_access.</p>`);
        const t = await tokenRequest({ grant_type: "refresh_token", refresh_token: s.tokens.refresh_token, resource: config.api });
        if (t.status === 200) s.tokens = { ...s.tokens, ...t.body };
        return page(res, s, `<h3>Refresh → ${t.status}</h3>${t.status === 200 ? "<p>New tokens below.</p>" : json(t.body)}`);
      }

      if (url.pathname === "/logout") {
        const idToken = s?.tokens?.id_token;
        if (s) sessions.delete(s.id);
        const clear = "demo_sid=; Path=/; Max-Age=0";
        if (!idToken) {
          res.writeHead(302, { location: "/", "set-cookie": clear });
          return res.end();
        }
        const q = new URLSearchParams({ id_token_hint: idToken, post_logout_redirect_uri: `${base}/signed-out` });
        res.writeHead(302, { location: `${endpoints.endSession}?${q}`, "set-cookie": clear });
        return res.end();
      }

      if (url.pathname === "/signed-out") return page(res, undefined, `<p class="note">Signed out of the app and the workspace.</p>`);

      return page(res, s);
    } catch (e) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(e?.stack ?? e));
    }
  })
  .listen(config.port, () => console.log(`Demo app on ${base}`));
