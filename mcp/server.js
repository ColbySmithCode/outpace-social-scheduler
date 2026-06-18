#!/usr/bin/env node
/**
 * MCP server for the Outpace Social Scheduler.
 *
 * Tools:
 *   - list_scheduled_posts  : list `post-` KV keys, return count + next 5 by scheduled_at
 *   - check_upload_progress : read `upload-{post_id}` KV value, return byte offset / percent
 *   - verify_oauth_tokens   : inspect `token-youtube-*` / `token-linkedin-*` keys for presence + expiry
 *
 * Transport: stdio. Exposes start(). Run with `--test` to self-check and exit 0.
 *
 * Reads the KV namespace from the KV_NAMESPACE_ID environment variable.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const SIXTY_DAYS_MS = 60 * 24 * 60 * 60 * 1000;

const TOOLS = [
  {
    name: "list_scheduled_posts",
    description:
      "List scheduled posts from KV (keys prefixed `post-`). Returns the total count and the next 5 upcoming posts with their scheduled timestamps.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "check_upload_progress",
    description:
      "Read `upload-{post_id}` from KV and return byte offset, total size, and percent complete for a resumable YouTube upload.",
    inputSchema: {
      type: "object",
      properties: {
        post_id: { type: "string", description: "The post id whose upload to inspect." },
      },
      required: ["post_id"],
      additionalProperties: false,
    },
  },
  {
    name: "verify_oauth_tokens",
    description:
      "Check KV for `token-youtube-*` and `token-linkedin-*` keys. Returns which platforms have tokens and whether they appear expired (LinkedIn tokens older than 60 days).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function namespaceId() {
  const id = process.env.KV_NAMESPACE_ID;
  if (!id) throw new Error("KV_NAMESPACE_ID environment variable is not set");
  return id;
}

async function runWrangler(args) {
  try {
    const { stdout } = await execFileP("wrangler", args, {
      cwd: PROJECT_ROOT,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim() };
  } catch (err) {
    return {
      ok: false,
      error: (err.stderr || err.stdout || err.message || String(err)).trim(),
    };
  }
}

async function kvListKeys(prefix) {
  const res = await runWrangler([
    "kv",
    "key",
    "list",
    `--namespace-id=${namespaceId()}`,
    `--prefix=${prefix}`,
  ]);
  if (!res.ok) return { ok: false, error: res.error, keys: [] };
  try {
    return { ok: true, keys: JSON.parse(res.stdout || "[]") };
  } catch {
    const keys = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith(prefix))
      .map((name) => ({ name }));
    return { ok: true, keys };
  }
}

async function kvGet(key) {
  const res = await runWrangler([
    "kv",
    "key",
    "get",
    `--namespace-id=${namespaceId()}`,
    key,
  ]);
  if (!res.ok) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return res.stdout;
  }
}

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

async function listScheduledPosts() {
  const listed = await kvListKeys("post-");
  if (!listed.ok) return { error: listed.error, count: 0, next_posts: [] };
  const keys = listed.keys;
  // Pull values to extract scheduled_at; cap the fan-out for safety.
  const sample = keys.slice(0, 100);
  const detailed = await Promise.all(
    sample.map(async (k) => {
      const value = await kvGet(k.name);
      const scheduledAt =
        value && typeof value === "object"
          ? value.scheduled_at ?? value.scheduledAt ?? null
          : null;
      return {
        key: k.name,
        post_id: k.name.replace(/^post-/, ""),
        scheduled_at: scheduledAt,
        platform: value && typeof value === "object" ? value.platform ?? null : null,
        status: value && typeof value === "object" ? value.status ?? null : null,
        _sort: toEpochMs(scheduledAt) ?? Number.MAX_SAFE_INTEGER,
      };
    })
  );
  detailed.sort((a, b) => a._sort - b._sort);
  const next = detailed.slice(0, 5).map(({ _sort, ...rest }) => rest);
  return { count: keys.length, next_posts: next };
}

async function checkUploadProgress(postId) {
  if (!postId) throw new Error("post_id is required");
  const value = await kvGet(`upload-${postId}`);
  if (value == null) {
    return { post_id: postId, found: false, message: "No upload record in KV." };
  }
  const byteOffset = Number(value.byteOffset ?? value.byte_offset ?? 0);
  const totalSize = Number(value.totalSize ?? value.total_size ?? 0);
  const percent =
    totalSize > 0 ? Math.round((byteOffset / totalSize) * 10000) / 100 : null;
  return {
    post_id: postId,
    found: true,
    byte_offset: byteOffset,
    total_size: totalSize,
    percent_complete: percent,
    status: value.status ?? null,
  };
}

async function verifyOauthTokens() {
  const platforms = {};
  for (const platform of ["youtube", "linkedin"]) {
    const listed = await kvListKeys(`token-${platform}-`);
    if (!listed.ok) {
      platforms[platform] = { has_token: false, error: listed.error, tokens: [] };
      continue;
    }
    const tokens = await Promise.all(
      listed.keys.map(async (k) => {
        const value = await kvGet(k.name);
        const obtainedAt =
          value && typeof value === "object"
            ? value.obtained_at ?? value.created_at ?? value.issued_at ?? null
            : null;
        const ageMs = toEpochMs(obtainedAt) != null ? Date.now() - toEpochMs(obtainedAt) : null;
        // LinkedIn has no refresh token; treat >60d as expired.
        const expired =
          platform === "linkedin" && ageMs != null ? ageMs > SIXTY_DAYS_MS : false;
        return {
          key: k.name,
          obtained_at: obtainedAt,
          age_days: ageMs != null ? Math.floor(ageMs / (24 * 60 * 60 * 1000)) : null,
          likely_expired: expired,
        };
      })
    );
    platforms[platform] = { has_token: tokens.length > 0, count: tokens.length, tokens };
  }
  return { platforms };
}

async function dispatch(name, args) {
  switch (name) {
    case "list_scheduled_posts":
      return listScheduledPosts();
    case "check_upload_progress":
      return checkUploadProgress(args?.post_id);
    case "verify_oauth_tokens":
      return verifyOauthTokens();
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export function buildServer() {
  const server = new Server(
    { name: "outpace-social-scheduler", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await dispatch(name, args);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Error in ${name}: ${err.message}` }],
      };
    }
  });
  return server;
}

export async function start() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

async function selfTest() {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import(
    "@modelcontextprotocol/sdk/inMemory.js"
  );
  const server = buildServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "selftest", version: "1.0.0" }, {});
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  console.error(
    `✓ outpace-social-scheduler MCP server OK — ${tools.length} tools: ${tools
      .map((t) => t.name)
      .join(", ")}`
  );
  await client.close();
  await server.close();
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  if (process.argv.includes("--test")) {
    selfTest()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error("✗ self-test failed:", err);
        process.exit(1);
      });
  } else {
    start().catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
  }
}
