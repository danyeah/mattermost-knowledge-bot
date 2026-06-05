import { callModel } from "../ai/client.js";

const MAX_EXTRACT_BYTES = 5 * 1024 * 1024; // 5 MB
const MIN_TEXT_CHARS = 80;
const MAX_TEXT_FOR_LLM = 12000;

const TEXT_EXTS = new Set([
  "txt", "md", "markdown", "json", "csv", "tsv", "log",
  "js", "ts", "tsx", "jsx", "py", "go", "rs", "java", "rb",
  "yml", "yaml", "html", "css", "sh", "sql",
]);

function getExt(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : "";
}

export interface ExtractResult {
  text: string;
  /** Reason text is empty/unsupported, useful for logging. Null means success. */
  skipReason: string | null;
}

export async function extractTextFromFile(
  buffer: Buffer,
  filename: string,
  mimeType: string,
): Promise<ExtractResult> {
  if (buffer.length > MAX_EXTRACT_BYTES) {
    return { text: "", skipReason: `file too large (${buffer.length} bytes)` };
  }

  const ext = getExt(filename);

  if (TEXT_EXTS.has(ext) || mimeType.startsWith("text/")) {
    return { text: buffer.toString("utf8"), skipReason: null };
  }

  if (ext === "pdf" || mimeType === "application/pdf") {
    // pdf-parse is CJS — dynamic import keeps cold start cheap for non-PDF saves.
    const { default: pdfParse } = (await import("pdf-parse")) as { default: (b: Buffer) => Promise<{ text: string }> };
    const parsed = await pdfParse(buffer);
    return { text: parsed.text ?? "", skipReason: null };
  }

  if (
    ext === "docx" ||
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value ?? "", skipReason: null };
  }

  return { text: "", skipReason: `unsupported format (.${ext} / ${mimeType})` };
}

export async function summarizeFile(text: string, filename: string): Promise<string | null> {
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_CHARS) return null;

  // `/no_think` is Qwen 3.x's signal to skip the <think>...</think> reasoning
  // phase. A file summary doesn't need chain-of-thought and skipping it
  // halves latency and frees up the token budget for the actual answer.
  const userPrompt = `/no_think

Riassumi in italiano il seguente documento (nome file: ${filename}).

Rispondi con:
- Una frase di sintesi (max 25 parole)
- 3-5 punti chiave come bullet list

Documento:
${trimmed.slice(0, MAX_TEXT_FOR_LLM)}`;

  const result = await callModel({
    systemPrompt:
      "Sei un assistente che estrae riassunti brevi e concreti da documenti aziendali. Rispondi solo in italiano, senza preamboli.",
    userPrompt,
    maxTokens: 500,
    temperature: 0.3,
  });

  const out = result.text.trim();
  return out.length > 0 ? out : null;
}
