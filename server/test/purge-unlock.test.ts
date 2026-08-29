import { checkPurgeUnlock, PurgeLockError } from "../src/routes/resources.js";

/** 危险区解锁口令校验(PRD 5.5):口令来自 .env 的 APP_AUTH_TOKEN */
describe("一键清空解锁校验", () => {
  test("口令未配置 → 锁定,任何输入都被拒绝", () => {
    expect(() => checkPurgeUnlock(null, "anything")).toThrow(PurgeLockError);
    expect(() => checkPurgeUnlock(null, "anything")).toThrow(/锁定/);
    expect(() => checkPurgeUnlock(null, undefined)).toThrow(/锁定/);
  });

  test("口令不匹配(含非字符串输入)→ 拒绝", () => {
    expect(() => checkPurgeUnlock("family-secret", "wrong")).toThrow(/不正确/);
    expect(() => checkPurgeUnlock("family-secret", undefined)).toThrow(/不正确/);
    expect(() => checkPurgeUnlock("family-secret", 123 as unknown as string)).toThrow(/不正确/);
    expect(() => checkPurgeUnlock("family-secret", "")).toThrow(/不正确/);
  });

  test("口令完全一致 → 通过", () => {
    expect(() => checkPurgeUnlock("family-secret", "family-secret")).not.toThrow();
  });
});
