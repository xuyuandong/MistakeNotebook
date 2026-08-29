/** 最小日志封装:只输出操作级信息,不记录题目正文/答案/文件 URL/密钥(AGENTS §4)。 */
export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(scope = "app"): Logger {
  const write = (level: string, msg: string) => {
    const line = `${new Date().toISOString()} [${level}] (${scope}) ${msg}`;
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  };
  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m) => write("error", m),
  };
}
