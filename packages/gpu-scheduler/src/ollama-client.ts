/**
 * Ollama telemetry probe client.
 *
 * Thin wrapper over the Ollama HTTP API using node's native fetch.
 * Default base URL is 127.0.0.1 (NOT localhost — a ghost empty instance
 * may listen on ::1 on this machine).
 */

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

const REQUEST_TIMEOUT_MS = 3_000;

export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  digest: string;
}

export interface OllamaRunningModel {
  name: string;
  sizeBytes: number;
  /** e.g. "100% GPU" — this is where VRAM usage shows up. */
  processor: string;
  expiresAt: string;
}

export interface OllamaProbeResult {
  models: OllamaModelInfo[];
  running: OllamaRunningModel[];
  reachable: boolean;
  latencyMs: number;
}

export interface VramEstimate {
  paramsB: number;
  estimatedGB: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

async function getJson<T>(baseUrl: string, path: string): Promise<T> {
  const res = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Ollama ${path} returned HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** GET /api/tags — all locally available models. */
export async function getModels(
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
): Promise<OllamaModelInfo[]> {
  const data = await getJson<{ models?: Array<{ name?: string; size?: number; digest?: string }> }>(
    baseUrl,
    '/api/tags',
  );
  return (data.models ?? []).map((m) => ({
    name: m.name ?? '',
    sizeBytes: m.size ?? 0,
    digest: m.digest ?? '',
  }));
}

/** GET /api/ps — currently loaded models (VRAM usage lives here). */
export async function getRunning(
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
): Promise<OllamaRunningModel[]> {
  const data = await getJson<{
    models?: Array<{
      name?: string;
      size?: number;
      size_vram?: number;
      processor?: string;
      expires_at?: string;
    }>
  }>(baseUrl, '/api/ps');
  return (data.models ?? [])
    .filter((m) => typeof m?.name === 'string' && m.name.length > 0)
    .map((m) => ({
      name: m.name as string,
      sizeBytes: Number.isFinite(m.size_vram) ? (m.size_vram as number) : Number.isFinite(m.size) ? (m.size as number) : 0,
      // E9 审查修复：processor 形如 '100% GPU'/'6%/94% CPU/GPU'，异型值归一为空串
      processor: typeof m.processor === 'string' ? m.processor : '',
      // expires_at 是时间戳字符串；非法值归空（调用方只做展示）
      expiresAt: typeof m.expires_at === 'string' && !Number.isNaN(Date.parse(m.expires_at)) ? m.expires_at : '',
    }));
}

/** Aggregate probe: reachability + models + running, with measured latency. */
export async function probe(
  baseUrl: string = DEFAULT_OLLAMA_BASE_URL,
): Promise<OllamaProbeResult> {
  const started = Date.now();
  try {
    const [models, running] = await Promise.all([getModels(baseUrl), getRunning(baseUrl)]);
    return { models, running, reachable: true, latencyMs: Date.now() - started };
  } catch {
    return { models: [], running: [], reachable: false, latencyMs: Date.now() - started };
  }
}

/**
 * Rough VRAM estimate for a model based on its parameter count.
 *
 * Parses the parameter count from names like 'qwen3:0.6b' or 'llama3:8b'.
 * Q4 quantization heuristic: paramsB * 0.55 GB + 1 GB overhead.
 * Returns null when no `<n>b` suffix is found (e.g. 'qwen3.6').
 */
export function estimateVram(modelName: string): VramEstimate | null {
  // E9 审查修复：只认「冒号后的量化 tag」里的参数量（'qwen3:0.6b'、'llama3:8b'），
  // 避免 '8x7b' 取 7、'mixtral-8x22b' 取 22 这类误取；MoE（x 记法）按总参保守估。
  const tag = modelName.includes(':') ? modelName.split(':').slice(1).join(':') : modelName;
  const moe = /(\d+)x(\d+(?:\.\d+)?)b/i.exec(tag);
  if (moe) {
    const totalB = Number(moe[1]) * Number(moe[2]);
    return { paramsB: totalB, estimatedGB: Number((totalB * 0.55 + 1).toFixed(2)), moe: true };
  }
  const match = /(\d+(?:\.\d+)?)b\b/i.exec(tag);
  if (!match) return null;
  const paramsB = Number(match[1]);
  if (!Number.isFinite(paramsB) || paramsB <= 0) return null;
  return { paramsB, estimatedGB: Number((paramsB * 0.55 + 1).toFixed(2)) };
}
