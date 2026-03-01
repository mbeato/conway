import { getActiveApis } from "../../shared/db";
import { join } from "path";

const PUBLIC_DIR = join(import.meta.dir, "..", "..", "public");
const WELL_KNOWN_DIR = join(PUBLIC_DIR, ".well-known");

export async function list(): Promise<void> {
  const apis = getActiveApis();
  console.log(`[list] Found ${apis.length} active APIs`);

  // Ensure directories exist
  await Bun.spawn(["mkdir", "-p", WELL_KNOWN_DIR]).exited;

  // Generate x402 discovery file
  const discovery = {
    version: "1.0",
    provider: "Conway (apimesh.xyz)",
    updated_at: new Date().toISOString(),
    apis: apis.map((api) => ({
      name: api.name,
      subdomain: api.subdomain,
      url: `https://${api.subdomain}.apimesh.xyz`,
      status: api.status,
      protocol: "x402",
      network: "eip155:8453",
    })),
  };

  const discoveryPath = join(WELL_KNOWN_DIR, "x402.json");
  await Bun.write(discoveryPath, JSON.stringify(discovery, null, 2));
  console.log(`[list] Wrote ${discoveryPath}`);

  // Generate Smithery tool schemas for each API
  for (const api of apis) {
    const schemaPath = join(import.meta.dir, "..", "..", "apis", api.name, "smithery.json");
    const schema = {
      name: api.name,
      description: `${api.name} API on apimesh.xyz`,
      url: `https://${api.subdomain}.apimesh.xyz`,
      protocol: "x402",
      tools: [
        {
          name: api.name,
          description: `Use the ${api.name} API`,
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    };

    try {
      await Bun.write(schemaPath, JSON.stringify(schema, null, 2));
      console.log(`[list] Wrote smithery schema: apis/${api.name}/smithery.json`);
    } catch {
      console.log(`[list] Skipped smithery schema for ${api.name} (dir may not exist)`);
    }
  }

  console.log("[list] Done");
}

// Run directly
if (import.meta.main) {
  await list();
}
