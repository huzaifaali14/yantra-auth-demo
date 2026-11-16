// The same MCP server as mcp-server.mjs, without @yantra-app/cloud-auth-js: the MCP SDK's own auth
// helpers plus jose to check the workspace's tokens.
import express from "express";
import { z } from "zod";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpAuthMetadataRouter, getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InsufficientScopeError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";

const workspace = (process.env.AUTH_URL ?? "").replace(/\/+$/, "");
const port = Number(process.env.MCP_PORT ?? 3001);
const resource = new URL(process.env.MCP_URL ?? `http://localhost:${port}/mcp`);
if (!workspace) throw new Error("Set AUTH_URL to the workspace, e.g. https://auth-xxxxxx.yantra.app");

// 1. Who signs people in: the workspace's authorization server metadata.
const issuer = `${workspace}/api/auth`;
const oauthMetadata = await fetch(`${workspace}/.well-known/oauth-authorization-server/api/auth`).then((r) => r.json());

// 2. How to check a token: signature against the workspace's keys, issuer, audience (this server), expiry.
const jwks = createRemoteJWKSet(new URL(`${issuer}/jwks`));
const verifier = {
  async verifyAccessToken(token) {
    let claims;
    try {
      ({ payload: claims } = await jwtVerify(token, jwks, { issuer, audience: resource.href }));
    } catch (e) {
      throw new InvalidTokenError(e.code === "ERR_JWT_EXPIRED" ? "Token expired" : "Invalid token");
    }
    return {
      token,
      clientId: claims.azp,
      scopes: typeof claims.scope === "string" ? claims.scope.split(" ") : [],
      expiresAt: claims.exp,
      resource,
      extra: { claims },
    };
  },
};

const app = express();
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
  res.setHeader("access-control-expose-headers", "www-authenticate, mcp-session-id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// 3. The metadata clients read first: /.well-known/oauth-protected-resource/mcp says "sign in at the workspace".
app.use(mcpAuthMetadataRouter({ oauthMetadata, resourceServerUrl: resource, scopesSupported: ["notes:read", "notes:write"], resourceName: "Demo notes" }));

// 4. No valid token → 401 with WWW-Authenticate: Bearer ..., resource_metadata="<the URL above>".
const bearer = requireBearerAuth({ verifier, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resource), expectedResource: resource });

const notes = new Map();
const need = (authInfo, permission) => {
  if (!(authInfo.extra.claims.permissions ?? []).includes(permission)) throw new InsufficientScopeError(`Needs ${permission}`);
};

app.post(resource.pathname, express.json(), bearer, async (req, res) => {
  const server = new McpServer({ name: "demo-notes", version: "1.0.0" });
  const sub = (authInfo) => authInfo.extra.claims.sub;
  server.registerTool("whoami", { description: "Who is signed in and what this app may do" }, async ({ authInfo }) => ({
    content: [{ type: "text", text: JSON.stringify({ user: sub(authInfo), client: authInfo.clientId, scopes: authInfo.scopes, permissions: authInfo.extra.claims.permissions }, null, 2) }],
  }));
  server.registerTool("list_notes", { description: "List your notes (needs notes:read)" }, async ({ authInfo }) => {
    need(authInfo, "notes:read");
    return { content: [{ type: "text", text: JSON.stringify(notes.get(sub(authInfo)) ?? [], null, 2) }] };
  });
  server.registerTool("add_note", { description: "Add a note (needs notes:write)", inputSchema: { text: z.string() } }, async ({ text }, { authInfo }) => {
    need(authInfo, "notes:write");
    const list = notes.get(sub(authInfo)) ?? [];
    list.push({ text, at: new Date().toISOString() });
    notes.set(sub(authInfo), list);
    return { content: [{ type: "text", text: `Saved. You have ${list.length} note(s).` }] };
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(port, () => console.log(`MCP server (no kit) on ${resource.href} (auth: ${workspace})`));
