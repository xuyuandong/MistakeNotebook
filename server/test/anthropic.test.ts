import { createServer, type Server } from "node:http";
import { createAnthropicProvider, createChatClient } from "../src/ai/client.js";
import { loadConfig } from "../src/config/index.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function startStubServer(): Promise<{ server: Server; port: number; lastBody: () => unknown }> {
  let lastBody: unknown = null;
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      lastBody = JSON.parse(data || "{}");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          content: [
            { type: "thinking", thinking: "..." },
            { type: "text", text: '{"stemMd":"(stub)题干"}' },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port, lastBody: () => lastBody });
    });
  });
}

describe("Anthropic 协议 provider", () => {
  test("data URL 转图片块;system 独立;thinking 块被跳过", async () => {
    const stub = await startStubServer();
    try {
      const provider = createAnthropicProvider();
      const res = await provider.chat(
        {
          provider: "kimi",
          protocol: "anthropic",
          baseUrl: `http://127.0.0.1:${stub.port}`,
          apiKey: "test-key",
          model: "k3-256k",
        },
        {
          taskType: "judge_answer",
          system: "只输出JSON",
          messages: [{ role: "user", content: `请转录 ${DATA_URL}` }],
          jsonMode: true,
        },
      );

      expect(res.text).toBe('{"stemMd":"(stub)题干"}');
      expect(res.run.status).toBe("ok");
      expect(JSON.parse(res.run.usageJson!)).toEqual({ promptTokens: 10, completionTokens: 5 });

      const body = stub.lastBody() as {
        model: string;
        max_tokens: number;
        system: string;
        messages: { role: string; content: unknown }[];
      };
      expect(body.model).toBe("k3-256k");
      expect(body.system).toBe("只输出JSON");
      expect(body.max_tokens).toBeGreaterThan(0);
      const content = body.messages[0].content as { type: string }[];
      expect(content).toHaveLength(2);
      expect(content[0].type).toBe("text");
      expect(content[1].type).toBe("image");
    } finally {
      stub.server.close();
    }
  });

  test("createChatClient 按槽位 protocol 分发到 anthropic provider", async () => {
    const stub = await startStubServer();
    try {
      const dir = mkdtempSync(join(tmpdir(), "cfg-"));
      const cfgPath = join(dir, "models.yaml");
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        cfgPath,
        `text_model:
  provider: kimi
  protocol: anthropic
  base_url: http://127.0.0.1:${stub.port}
  api_key_env: KIMI_API_KEY
  model: k3-256k
`,
      );
      const cfg = loadConfig({
        env: "development",
        configPath: cfgPath,
        envMap: { KIMI_API_KEY: "k-test" },
      });
      const client = createChatClient(cfg);
      const res = await client.chat("text", {
        taskType: "judge_answer",
        system: "s",
        messages: [{ role: "user", content: "hi" }],
      });
      expect(res.run.provider).toBe("kimi");
      expect(res.text).toBe('{"stemMd":"(stub)题干"}');
      const body = stub.lastBody() as { messages: unknown[] };
      expect(body.messages).toHaveLength(1); // 走的是 anthropic 端点
    } finally {
      stub.server.close();
    }
  });

  test("配置校验拒绝非法 protocol", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const cfgPath = join(dir, "models.yaml");
    writeFileSync(
      cfgPath,
      `text_model:
  provider: kimi
  protocol: grpc
  base_url: https://x
  api_key_env: KIMI_API_KEY
  model: m
`,
    );
    expect(() =>
      loadConfig({
        env: "development",
        configPath: cfgPath,
        envMap: { KIMI_API_KEY: "k" },
      }),
    ).toThrow(/protocol 非法/);
  });
});
