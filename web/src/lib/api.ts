export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 统一响应处理:非 2xx 转 ApiError(免登录,无 401 跳转) */
async function parseResponse<T>(res: Response): Promise<T> {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(err?.code ?? "INTERNAL", err?.message ?? `请求失败(${res.status})`);
  }
  return body as T;
}

/** 统一 API 封装(免登录):错误信封转 ApiError */
export async function api<T>(
  path: string,
  options: { method?: string; json?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      ...(options.json !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: options.json !== undefined ? JSON.stringify(options.json) : undefined,
  });
  return parseResponse<T>(res);
}

/** 上传 .json 导入文件:FormData(不带 content-type,让浏览器带 boundary) */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(path, { method: "POST", body: fd });
  return parseResponse<T>(res);
}
