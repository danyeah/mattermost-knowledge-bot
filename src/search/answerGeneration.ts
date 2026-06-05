import { callModel } from "../ai/client.js";
import type { RetrievedChunk } from "./retrieval.js";

export interface SearchAnswer {
  answer: string;
  sources: Array<{ docId: string; title: string; url: string; heading: string }>;
}

export async function generateAnswer(query: string, chunks: RetrievedChunk[], scopeLabel?: string): Promise<SearchAnswer> {
  const context = chunks
    .map((c, i) => `[${i + 1}] **${c.docTitle} › ${c.heading}**\n${c.content}`)
    .join("\n\n---\n\n");

  const scopeNote = scopeLabel ? ` Priorità ai contenuti di ${scopeLabel}, ma puoi usare anche il contesto più ampio se necessario.` : "";
  const systemPrompt = `Sei un assistente aziendale. Rispondi alle domande degli utenti usando SOLO le informazioni fornite nel contesto.${scopeNote}
Se il contesto non contiene informazioni sufficienti, dillo chiaramente.
Rispondi in italiano. Sii conciso (max 3-4 paragrafi). Cita le fonti con [numero].`;

  // `/no_think` tells Qwen 3.x to skip chain-of-thought — for a grounded Q&A
  // we want the answer, not the reasoning trace (and a long <think> phase
  // was eating the maxTokens budget, leaving the answer empty after strip).
  const userPrompt = `/no_think

Domanda: ${query}

Contesto:
${context}`;

  const { text } = await callModel({
    systemPrompt,
    userPrompt,
    maxTokens: 4000,
    temperature: 0.2,
  });

  const sources = chunks.map((c) => ({
    docId: c.docId,
    title: c.docTitle,
    url: c.docUrl,
    heading: c.heading,
  }));

  return { answer: text, sources };
}
