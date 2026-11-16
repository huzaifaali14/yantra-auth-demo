// Demo MCP server protected by a Yantra Auth workspace. MCP clients (MCP Inspector, Claude Code,
// Claude, Cursor, VS Code) find the workspace from this server's metadata, register themselves,
// sign the person in, and call the tools with an access token for this server.
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpAuth, requireScopes } from "@yantra-app/cloud-auth-js/mcp";

const workspace = (process.env.AUTH_URL ?? "").replace(/\/+$/, "");
const port = Number(process.env.MCP_PORT ?? 3001);
// Must equal the MCP server API's identifier on the APIs page: the URL clients connect to.
const resource = process.env.MCP_URL ?? `http://localhost:${port}/mcp`;
if (!workspace) throw new Error("Set AUTH_URL to the workspace, e.g. https://auth-xxxxxx.yantra.app");

const auth = createMcpAuth({ workspace, resource, scopesSupported: ["notes:read", "notes:write"], resourceName: "Demo notes" });
const notes = new Map(); // per signed-in person (token sub), in memory

const app = express();
// Browser-based clients (MCP Inspector) read the metadata and the 401 challenge cross-origin.
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "authorization, content-type, mcp-protocol-version, mcp-session-id");
  res.setHeader("access-control-expose-headers", "www-authenticate, mcp-session-id");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(auth.middleware()); // metadata, 401 for missing or bad tokens, req.auth
app.use(express.json());

const path = new URL(resource).pathname;
app.post(path, async (req, res) => {
  const server = new McpServer({ name: "demo-notes", version: "1.0.0" });
  const sub = (authInfo) => authInfo.extra.claims.sub;

  server.registerTool("whoami", { description: "Who is signed in, which app is calling, and what it may do" }, async ({ authInfo }) => ({
    content: [{ type: "text", text: JSON.stringify({ user: sub(authInfo), client: authInfo.clientId, scopes: authInfo.scopes, permissions: authInfo.extra.claims.permissions }, null, 2) }],
  }));

  server.registerTool("list_notes", { description: "List your notes (needs notes:read)" }, async ({ authInfo }) => {
    requireScopes(authInfo, "notes:read");
    return { content: [{ type: "text", text: JSON.stringify(notes.get(sub(authInfo)) ?? [], null, 2) }] };
  });

  server.registerTool(
    "add_note",
    { description: "Add a note (needs notes:write)", inputSchema: { text: z.string().describe("The note") } },
    async ({ text }, { authInfo }) => {
      requireScopes(authInfo, "notes:write");
      const list = notes.get(sub(authInfo)) ?? [];
      list.push({ text, at: new Date().toISOString() });
      notes.set(sub(authInfo), list);
      return { content: [{ type: "text", text: `Saved. You have ${list.length} note(s).` }] };
    },
  );

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(port, () => console.log(`MCP server on ${resource} (auth: ${workspace})`));
