import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, ConfigError } from "../src/config/index.js";

function writeYaml(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cfg-"));
  const file = join(dir, "models.yaml");
  writeFileSync(file, content);
  return file;
}

// v0.3:只有 text_model 一个槽位(识题在豆包侧);APP_AUTH_TOKEN 自 v0.4 起复用为危险区解锁口令
const validYaml = `
text_model:
  provider: deepseek
  base_url: https://api.deepseek.example
  api_key_env: DEEPSEEK_API_KEY
  model: deepseek-chat
`;

const fullEnv = {
  DEEPSEEK_API_KEY: "d-test",
};

describe("配置加载", () => {
  test("合法配置 + 密钥齐全时正确解析", () => {
    const cfg = loadConfig({
      env: "development",
      configPath: writeYaml(validYaml),
      envMap: fullEnv,
    });
    expect(cfg.textModel.provider).toBe("deepseek");
    expect(cfg.textModel.apiKey).toBe("d-test");
    expect(cfg.warnings).toHaveLength(0);
  });

  test("开发环境缺密钥时降级 mock 并产生警告", () => {
    const cfg = loadConfig({
      env: "development",
      configPath: writeYaml(validYaml),
      envMap: {},
    });
    expect(cfg.textModel.provider).toBe("mock");
    expect(cfg.warnings.length).toBe(1);
  });

  test("base_url 支持 ${VAR} 展开", () => {
    const cfg = loadConfig({
      env: "development",
      configPath: writeYaml(
        validYaml.replace("https://api.deepseek.example", "${DEEPSEEK_BASE_URL}"),
      ),
      envMap: { ...fullEnv, DEEPSEEK_BASE_URL: "https://custom.example" },
    });
    expect(cfg.textModel.baseUrl).toBe("https://custom.example");
  });

  test("生产环境缺密钥直接报错", () => {
    expect(() =>
      loadConfig({
        env: "production",
        configPath: writeYaml(validYaml),
        envMap: { DEEPSEEK_API_KEY: undefined },
      }),
    ).toThrow(ConfigError);
  });

  test("provider 白名单校验", () => {
    expect(() =>
      loadConfig({
        env: "development",
        configPath: writeYaml(validYaml.replace("provider: deepseek", "provider: openai")),
        envMap: fullEnv,
      }),
    ).toThrow(/provider 非法/);
  });

  test("缺少 text_model 槽位直接报错", () => {
    expect(() =>
      loadConfig({
        env: "development",
        configPath: writeYaml("vision_model:\n  provider: mock\n  model: m\n"),
        envMap: {},
      }),
    ).toThrow(/text_model/);
  });

  test("APP_AUTH_TOKEN 读入 appAuthToken;空值归一为 null(清空功能锁定)", () => {
    const withToken = loadConfig({
      env: "development",
      configPath: writeYaml(validYaml),
      envMap: { ...fullEnv, APP_AUTH_TOKEN: "  family-secret  " },
    });
    expect(withToken.appAuthToken).toBe("family-secret"); // 去首尾空白

    const noToken = loadConfig({
      env: "development",
      configPath: writeYaml(validYaml),
      envMap: { ...fullEnv, APP_AUTH_TOKEN: "" },
    });
    expect(noToken.appAuthToken).toBeNull();
  });
});
