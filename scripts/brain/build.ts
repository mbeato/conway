import { createMcpClient } from "../../shared/mcp";
import {
  getTopBacklogItem,
  updateBacklogStatus,
  registerApi,
} from "../../shared/db";
import { join, resolve } from "path";

const MAX_RETRIES = 3;
const API_NAME_PATTERN = /^[a-z][a-z0-9-]{1,48}[a-z0-9]$/;
const RESERVED_NAMES = new Set([
  "shared", "scripts", "public", "data", "node_modules",
  "mcp-server", "dashboard", "router", "registry",
]);
const PROJECT_DIR = join(import.meta.dir, "..", "..");
const APIS_DIR = join(PROJECT_DIR, "apis");
const REGISTRY_PATH = join(APIS_DIR, "registry.ts");
const TEST_PORT = 3099; // Temp port for health check testing
const BUN = Bun.argv[0]; // Absolute path to the running bun binary

// Read web-checker source as reference for the model
async function getReference(): Promise<string> {
  const webCheckerSrc = await Bun.file(join(APIS_DIR, "web-checker/index.ts")).text();
  const checkerSrc = await Bun.file(join(APIS_DIR, "web-checker/checker.ts")).text();
  return `
=== REFERENCE: apis/web-checker/index.ts ===
${webCheckerSrc}

=== REFERENCE: apis/web-checker/checker.ts ===
${checkerSrc}

=== SHARED MODULE SIGNATURES ===
shared/x402.ts exports: paymentMiddleware, paidRoute(price, description), resourceServer, WALLET_ADDRESS, NETWORK
shared/logger.ts exports: apiLogger(apiName, priceUsd) — Hono middleware
shared/rate-limit.ts exports: rateLimit(zone, maxRequests, windowMs) — Hono middleware
shared/db.ts exports: default db, logRequest(), logRevenue(), registerApi(), getRevenueByApi(), etc.
`;
}

interface GeneratedFile {
  path: string;
  content: string;
}

async function generateApi(
  name: string,
  description: string,
  client: Awaited<ReturnType<typeof createMcpClient>>,
  errorFeedback?: string
): Promise<GeneratedFile[]> {
  const reference = await getReference();

  const prompt = `You are Conway, an autonomous API builder. Generate a complete x402-payable Hono API.

API to build:
- Name: ${name}
- Description: ${description}
- Subdomain: ${name}.apimesh.xyz
- Price: $0.001-$0.01 per call (choose appropriate price)

${errorFeedback ? `PREVIOUS ATTEMPT FAILED with this error:\n${errorFeedback}\n\nFix the issue in your new attempt.\n` : ""}

Requirements:
1. Use Hono framework (import { Hono } from "hono")
2. Use x402 payment middleware from ../../shared/x402
3. Use apiLogger from ../../shared/logger
4. Use rateLimit from ../../shared/rate-limit
5. Export a named \`app\` (the Hono instance)
6. Export default with { port: Number(process.env.PORT) || 3001, hostname: "127.0.0.1", fetch: app.fetch }
7. Include /health endpoint (before rate limiter)
8. Include / info endpoint
9. No external API keys — use only built-in Bun APIs, fetch, or public APIs
10. Handle errors gracefully
11. CORS open to all origins
12. All code in TypeScript

Reference implementation:
${reference}

Respond with a JSON array of files. Each file has "path" (relative to apis/${name}/) and "content" (full TypeScript source).
The main file MUST be "index.ts". You may include helper files.

JSON array only, no markdown fences:`;

  const response = await client.chat([{ role: "user", content: prompt }], "gpt-4.1");

  try {
    const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const files = JSON.parse(cleaned) as GeneratedFile[];
    console.log(`[build] Generated ${files.length} files: ${files.map(f => f.path).join(", ")}`);
    return files;
  } catch {
    console.error("[build] Failed to parse response:", response.slice(0, 500));
    return [];
  }
}

// Test the generated API locally on the Hetzner server — no sandbox VMs needed
async function testLocally(
  name: string,
  files: GeneratedFile[]
): Promise<{ success: boolean; error?: string }> {
  const testDir = join(PROJECT_DIR, ".test-builds", name);

  try {
    // Clean up any previous test
    await Bun.spawn(["rm", "-rf", testDir]).exited;
    await Bun.spawn(["mkdir", "-p", testDir]).exited;

    // Write generated files with path containment enforcement
    const resolvedBase = resolve(testDir);
    for (const file of files) {
      // Sanitize path: strip traversal components
      const safePath = file.path
        .replace(/\\/g, "/")
        .split("/")
        .filter((p) => p !== ".." && p !== "." && p.length > 0)
        .join("/");

      if (!safePath || safePath.length === 0) {
        console.error(`[build] Rejecting invalid file path: "${file.path}"`);
        return { success: false, error: `Invalid file path in GPT response: "${file.path}"` };
      }

      // Only allow .ts and .json files
      if (!/\.(ts|json)$/.test(safePath)) {
        console.error(`[build] Rejecting non-ts/json file: "${safePath}"`);
        return { success: false, error: `Disallowed file extension: "${safePath}"` };
      }

      const filePath = join(testDir, safePath);
      const resolvedPath = resolve(filePath);
      if (!resolvedPath.startsWith(resolvedBase + "/")) {
        console.error(`[build] Path traversal blocked: "${file.path}" -> "${resolvedPath}"`);
        return { success: false, error: `Path traversal attempt: "${file.path}"` };
      }

      const dir = filePath.substring(0, filePath.lastIndexOf("/"));
      await Bun.spawn(["mkdir", "-p", dir]).exited;
      await Bun.write(filePath, file.content);
    }

    // Step 1: Syntax check — transpile the main file (output to stdout, no write)
    console.log(`[build] Checking syntax...`);
    const syntaxCheck = Bun.spawnSync(
      [BUN, "build", "--no-bundle", join(testDir, "index.ts")],
      { cwd: PROJECT_DIR, stderr: "pipe", stdout: "pipe" }
    );
    if (syntaxCheck.exitCode !== 0) {
      const stderr = new TextDecoder().decode(syntaxCheck.stderr);
      const stdout = new TextDecoder().decode(syntaxCheck.stdout);
      const detail = stderr || stdout || `exit code ${syntaxCheck.exitCode}`;
      console.error(`[build] Syntax check failed: ${detail.slice(0, 300)}`);
      return { success: false, error: `Syntax/build error: ${detail.slice(0, 500)}` };
    }
    console.log("[build] Syntax check passed");

    // Step 2: Copy to apis/ temporarily so imports resolve against real shared modules
    const tempApiDir = join(APIS_DIR, `_test_${name}`);
    await Bun.spawn(["rm", "-rf", tempApiDir]).exited;
    await Bun.spawn(["cp", "-r", testDir, tempApiDir]).exited;

    // Step 3: Start on a test port and health check
    console.log(`[build] Starting test server on port ${TEST_PORT}...`);
    // Strip sensitive env vars from LLM-generated code execution
    const safeEnv = { ...process.env, PORT: String(TEST_PORT) };
    delete safeEnv.DASHBOARD_TOKEN;
    delete safeEnv.CDP_API_KEY_ID;
    delete safeEnv.CDP_API_KEY_SECRET;
    delete safeEnv.CONWAY_API_KEY;

    const testProc = Bun.spawn(
      [BUN, "run", join(tempApiDir, "index.ts")],
      {
        cwd: PROJECT_DIR,
        env: safeEnv,
        stdout: "pipe",
        stderr: "pipe",
      }
    );

    // Wait for startup
    await Bun.sleep(3000);

    // Check if process crashed
    if (testProc.exitCode !== null) {
      const stderr = new TextDecoder().decode(await new Response(testProc.stderr).arrayBuffer());
      console.error(`[build] Server crashed (exit ${testProc.exitCode}): ${stderr.slice(0, 300)}`);
      await cleanup(tempApiDir, testDir);
      return { success: false, error: `Server crashed on startup: ${stderr.slice(0, 500)}` };
    }

    console.log(`[build] Server running (pid ${testProc.pid}), checking health...`);

    // Health check
    let healthOk = false;
    try {
      const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      healthOk = res.ok;
      const body = await res.text();
      console.log(`[build] Health check: ${res.status} ${body.slice(0, 100)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[build] Health check connection failed: ${msg}`);
    }

    // Kill test server
    testProc.kill();
    await testProc.exited;

    // Cleanup temp api dir
    await Bun.spawn(["rm", "-rf", tempApiDir]).exited;

    if (!healthOk) {
      await cleanup(tempApiDir, testDir);
      return { success: false, error: "Health check failed — /health did not return 200" };
    }

    console.log(`[build] Local test passed for ${name}`);
    // Keep testDir — the deploy step will use it
    return { success: true };
  } catch (e) {
    const error = e instanceof Error ? `${e.message}\n${e.stack}` : String(e);
    console.error(`[build] Local test failed: ${error}`);
    await cleanup(join(APIS_DIR, `_test_${name}`), testDir);
    return { success: false, error };
  }
}

async function cleanup(...dirs: string[]) {
  for (const dir of dirs) {
    try { await Bun.spawn(["rm", "-rf", dir]).exited; } catch {}
  }
}

async function updateRegistry(name: string) {
  const content = await Bun.file(REGISTRY_PATH).text();
  if (content.includes(`"${name}"`)) return;

  const camelName = toCamelCase(name);
  const importLine = `import { app as ${camelName} } from "./${name}/index";`;

  const lines = content.split("\n");
  const importLines: string[] = [];
  const otherLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("import ")) {
      importLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  importLines.push(importLine);

  const rebuilt = otherLines.map((line) => {
    if (line.trim() === "};") {
      return `  "${name}": ${camelName},\n};`;
    }
    return line;
  });

  const newContent = [...importLines, "", ...rebuilt].join("\n");
  await Bun.write(REGISTRY_PATH, newContent);
}

function toCamelCase(kebab: string): string {
  return kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export async function build(): Promise<boolean> {
  const item = getTopBacklogItem();
  if (!item) {
    console.log("[build] No pending backlog items");
    return false;
  }

  // Validate API name before using it in paths or code
  if (!API_NAME_PATTERN.test(item.name)) {
    console.error(`[build] Invalid API name format: "${item.name}" — skipping`);
    updateBacklogStatus(item.id, "failed");
    return false;
  }
  if (RESERVED_NAMES.has(item.name)) {
    console.error(`[build] Reserved name: "${item.name}" — skipping`);
    updateBacklogStatus(item.id, "failed");
    return false;
  }

  console.log(`[build] Building: ${item.name} — ${item.description}`);
  updateBacklogStatus(item.id, "building");

  const client = await createMcpClient(120_000);

  try {
    let files: GeneratedFile[] = [];
    let lastError: string | undefined;

    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      console.log(`[build] Attempt ${attempt}/${MAX_RETRIES}`);

      files = await generateApi(item.name, item.description, client, lastError);
      if (files.length === 0) {
        lastError = "Model returned empty or unparseable response";
        continue;
      }

      const testResult = await testLocally(item.name, files);
      if (testResult.success) {
        success = true;
        break;
      }

      lastError = testResult.error;
    }

    if (!success) {
      console.error(`[build] All ${MAX_RETRIES} attempts failed for ${item.name}`);
      updateBacklogStatus(item.id, "failed");
      return false;
    }

    // Deploy: move files from test dir to apis/<name>/
    const apiDir = join(APIS_DIR, item.name);
    const testDir = join(PROJECT_DIR, ".test-builds", item.name);
    await Bun.spawn(["rm", "-rf", apiDir]).exited;
    await Bun.spawn(["cp", "-r", testDir, apiDir]).exited;
    await Bun.spawn(["rm", "-rf", testDir]).exited;
    console.log(`[build] Deployed apis/${item.name}/`);

    // Update registry
    await updateRegistry(item.name);
    console.log(`[build] Updated apis/registry.ts`);

    // Register in database
    registerApi(item.name, 3001, item.name);
    updateBacklogStatus(item.id, "deployed");

    console.log(`[build] Successfully deployed: ${item.name}`);

    // Restart router
    try {
      Bun.spawnSync(["sudo", "/usr/local/bin/conway-deploy-restart"]);
      console.log("[build] Services restarted via deploy wrapper");
    } catch {
      console.log("[build] Router restart skipped (not on server or no sudo)");
    }

    return true;
  } finally {
    client.close();
    // Clean up test builds dir
    await cleanup(join(PROJECT_DIR, ".test-builds"));
  }
}

// Run directly
if (import.meta.main) {
  const result = await build();
  console.log(`Build result: ${result ? "SUCCESS" : "FAILED/SKIPPED"}`);
}
