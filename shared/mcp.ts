import { Subprocess } from "bun";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: { content: { type: string; text: string }[] };
  error?: { code: number; message: string; data?: unknown };
}

interface McpClient {
  callTool: (name: string, args?: Record<string, unknown>) => Promise<string>;
  chat: (messages: { role: string; content: string }[], model?: string) => Promise<string>;
  getBalance: () => Promise<string>;
  getCredits: () => Promise<string>;
  sandboxCreate: (template?: string) => Promise<string>;
  sandboxWriteFile: (sandboxId: string, path: string, content: string) => Promise<string>;
  sandboxExec: (sandboxId: string, command: string, args?: string[]) => Promise<string>;
  sandboxDelete: (sandboxId: string) => Promise<string>;
  close: () => void;
}

export async function createMcpClient(timeoutMs = 30_000): Promise<McpClient> {
  let proc: Subprocess<"pipe", "pipe", "pipe"> | null = null;
  let requestId = 0;
  let buffer = "";
  const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void; timer: Timer }>();

  function spawn() {
    proc = Bun.spawn(["conway-terminal"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      // Inherits env automatically — Bun auto-loads .env
    });

    // Read stdout for JSON-RPC responses
    (async () => {
      if (!proc?.stdout) return;
      const reader = proc.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          processBuffer();
        }
      } catch {
        // Process exited
      }
    })();

    // Log stderr for debugging
    (async () => {
      if (!proc?.stderr) return;
      const reader = proc.stderr.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = decoder.decode(value, { stream: true }).trim();
          if (text) console.error(`[mcp:stderr] ${text}`);
        }
      } catch {
        // Process exited
      }
    })();

    proc.exited.then(() => {
      for (const [id, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("MCP process exited unexpectedly"));
        pending.delete(id);
      }
    });
  }

  function processBuffer() {
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("{")) continue;
      try {
        const msg = JSON.parse(trimmed) as JsonRpcResponse;
        if (msg.id !== undefined && pending.has(msg.id)) {
          const p = pending.get(msg.id)!;
          clearTimeout(p.timer);
          pending.delete(msg.id);
          if (msg.error) {
            p.reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`));
          } else {
            const text = msg.result?.content?.map((c) => c.text).join("") ?? "";
            p.resolve(text);
          }
        }
      } catch {
        // Skip non-JSON lines (progress messages, etc.)
      }
    }
  }

  async function ensureProcess() {
    if (!proc || proc.exitCode !== null) {
      spawn();
      // Wait for initialization
      await Bun.sleep(500);
      // Send MCP initialize
      await sendRaw({
        jsonrpc: "2.0",
        id: ++requestId,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "conway-brain", version: "1.0.0" },
        },
      });
      // Send initialized notification (no id — it's a one-way notification)
      proc?.stdin?.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    }
  }

  function sendRaw(req: JsonRpcRequest): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(req.id);
        reject(new Error(`MCP call timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(req.id, { resolve, reject, timer });
      const data = JSON.stringify(req) + "\n";
      proc?.stdin?.write(data);
    });
  }

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<string> {
    await ensureProcess();
    return sendRaw({
      jsonrpc: "2.0",
      id: ++requestId,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }

  async function chat(
    messages: { role: string; content: string }[],
    model = "gpt-4o-mini"
  ): Promise<string> {
    const raw = await callTool("chat_completions", { messages, model });
    // Response is JSON with a content field — extract it
    try {
      const parsed = JSON.parse(raw);
      return parsed.content ?? raw;
    } catch {
      return raw;
    }
  }

  async function getBalance(): Promise<string> {
    return callTool("wallet_info");
  }

  async function getCredits(): Promise<string> {
    return callTool("credits_balance");
  }

  async function sandboxCreate(template = "base"): Promise<string> {
    return callTool("sandbox_create", { template });
  }

  async function sandboxWriteFile(sandboxId: string, path: string, content: string): Promise<string> {
    return callTool("sandbox_write_file", { sandbox_id: sandboxId, path, content });
  }

  async function sandboxExec(sandboxId: string, command: string, args: string[] = []): Promise<string> {
    return callTool("sandbox_exec", { sandbox_id: sandboxId, command, args });
  }

  async function sandboxDelete(sandboxId: string): Promise<string> {
    return callTool("sandbox_delete", { sandbox_id: sandboxId });
  }

  function close() {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("MCP client closed"));
    }
    pending.clear();
    proc?.kill();
    proc = null;
  }

  // Initialize on creation
  await ensureProcess();

  return {
    callTool,
    chat,
    getBalance,
    getCredits,
    sandboxCreate,
    sandboxWriteFile,
    sandboxExec,
    sandboxDelete,
    close,
  };
}

// Self-test when run directly
if (import.meta.main) {
  console.log("MCP Client self-test...");
  try {
    const client = await createMcpClient();
    console.log("Connected to conway-terminal");
    const credits = await client.getCredits();
    console.log("Credits:", credits);
    client.close();
    console.log("Self-test passed!");
  } catch (e) {
    console.error("Self-test failed:", e);
    Bun.exit(1);
  }
}
