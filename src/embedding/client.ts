import { config } from "../config.js";
import { logger } from "../logger.js";

const MODEL = "bge-m3";

export async function embed(texts: string[]): Promise<number[][]> {
  const url = `${config.OLLAMA_URL}/api/embed`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, input: texts }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Ollama embed failed: ${response.status} ${body}`);
  }

  const data = await response.json() as { embeddings: number[][] };
  if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
    throw new Error(`Unexpected Ollama embed response: ${JSON.stringify(data)}`);
  }
  return data.embeddings;
}

export async function embedOne(text: string): Promise<number[]> {
  const vecs = await embed([text]);
  if (!vecs[0]) throw new Error("Ollama returned empty embedding");
  return vecs[0];
}

export async function ensureModelReady(): Promise<void> {
  const url = `${config.OLLAMA_URL}/api/tags`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await res.json() as { models?: Array<{ name: string }> };
    const names = (data.models ?? []).map((m) => m.name);
    if (names.some((n) => n.startsWith(MODEL))) {
      logger.info({ model: MODEL }, "embedding_model_ready");
      return;
    }
  } catch (err) {
    logger.warn({ err }, "ollama_tags_check_failed");
  }

  logger.info({ model: MODEL }, "pulling_embedding_model");
  const pullRes = await fetch(`${config.OLLAMA_URL}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, stream: false }),
  });
  if (!pullRes.ok) {
    const body = await pullRes.text().catch(() => "");
    throw new Error(`Failed to pull embedding model ${MODEL}: ${pullRes.status} ${body}`);
  }
  logger.info({ model: MODEL }, "embedding_model_pulled");
}
