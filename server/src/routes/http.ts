/** 统一错误信封(原 routes/uploads.ts,该模块已随附件流程移除) */
export function err(code: string, message: string, details?: unknown) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}
