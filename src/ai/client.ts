import { config } from "../config.js";
import { retryWithBackoff } from "../utils/retry.js";

export interface CallModelResult {
  text: string;
  usage: { input: number; output: number };
}

async function callOpenAICompatible(opts: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}): Promise<CallModelResult> {
  const body = {
    model: config.LLM_MODEL,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: opts.userPrompt },
    ],
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
  };

  // The self-hosted LLM occasionally drops the socket mid-generation
  // ("fetch failed: other side closed"). Retry with backoff — it's a
  // transient network/server condition rather than a real failure.
  const data = await retryWithBackoff(async () => {
    const res = await fetch(`${config.LLM_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`LLM request failed: ${res.status} ${err}`);
    }

    return await res.json() as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
    };
  });

  const text = data.choices[0]?.message?.content ?? "";
  return {
    text,
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
  };
}

async function callAnthropic(opts: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}): Promise<CallModelResult> {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  const response = await client.messages.create({
    model: config.ANTHROPIC_MODEL,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.userPrompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in Claude response");
  }

  return {
    text: textBlock.text,
    usage: {
      input: response.usage.input_tokens,
      output: response.usage.output_tokens,
    },
  };
}

export async function callModel(opts: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  temperature: number;
}): Promise<CallModelResult> {
  if (config.LLM_BASE_URL) {
    return callOpenAICompatible(opts);
  }
  return callAnthropic(opts);
}
