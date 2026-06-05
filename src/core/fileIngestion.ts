import type { MattermostClient } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { createDocument } from "../outline/documents.js";
import { uploadAttachment } from "../outline/attachments.js";
import { callModel } from "../ai/client.js";

interface FileIngestionResult {
  outlineDocumentId: string;
  outlineUrl: string;
  title: string;
  summary: string;
}

/**
 * Estrae testo grezzo da un file (supporto base per file testuali).
 * Per PDF/DOCX serviranno dipendenze aggiuntive in futuro.
 */
async function extractTextFromFile(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop() || "";

  // File testuali puri
  if (
    ["txt", "md", "json", "csv", "tsv", "log", "js", "ts", "py", "go", "rs"].includes(ext) ||
    mimeType.startsWith("text/")
  ) {
    return buffer.toString("utf8");
  }

  // Placeholder per PDF (da implementare con pdf-parse o simile)
  if (ext === "pdf" || mimeType === "application/pdf") {
    return `[PDF non ancora supportato per estrazione testo completa - filename: ${filename}]`;
  }

  // Placeholder per altri formati binari
  return `[File binario non testuale: ${filename} (${mimeType})]`;
}

/**
 * Genera un riassunto del contenuto usando il modello Anthropic centralizzato.
 */
async function generateSummary(text: string, filename: string): Promise<string> {
  if (!text || text.length < 20) {
    return "Nessun contenuto testuale estraibile dal file.";
  }

  const userPrompt = `Riassumi in italiano il seguente documento (nome file: ${filename}).

Fornisci:
- Un titolo descrittivo
- Un riassunto di 4-6 frasi
- I punti chiave principali (bullet list)

Documento:
${text.slice(0, 12000)}`;

  try {
    const result = await callModel({
      systemPrompt: "Sei un assistente esperto nell'estrazione di conoscenza da documenti tecnici e aziendali.",
      userPrompt,
      maxTokens: 900,
      temperature: 0.3,
    });
    return result.text;
  } catch (err) {
    return `Errore durante la generazione del riassunto: ${err}`;
  }
}

/**
 * Crea una pagina Outline dedicata per un file caricato.
 * Titolo della pagina = nome del file.
 */
export async function ingestFileAsDocument(opts: {
  fileId: string;
  filename: string;
  mimeType: string;
  size: number;
  channelId: string;
  collectionId: string;
  ctx: {
    mmClient: MattermostClient;
    outlineClient: OutlineClient;
    logger: Logger;
  };
}): Promise<FileIngestionResult> {
  const { fileId, filename, mimeType, channelId, collectionId, ctx } = opts;
  const { mmClient, outlineClient, logger } = ctx;

  logger.info({ fileId, filename }, "file_ingestion_started");

  // 1. Scarica il file da Mattermost
  const download = await mmClient.getFileBlob(fileId);

  // 2. Estrai il testo
  const extractedText = await extractTextFromFile(download.buffer, filename, mimeType);

  // 3. Genera riassunto
  const summary = await generateSummary(extractedText, filename);

  // 4. Crea la pagina Outline con titolo = nome file
  const pageTitle = filename.replace(/\.[^/.]+$/, ""); // rimuovi estensione per titolo più pulito
  const pageContent = `# ${filename}

**Riassunto generato automaticamente**

${summary}

---

## Contenuto estratto

\`\`\`
${extractedText.slice(0, 8000)}
\`\`\`
`;

  const doc = await createDocument(outlineClient, {
    collectionId,
    title: pageTitle,
    text: pageContent,
  });

  // 5. Carica il file originale come attachment alla pagina
  try {
    await uploadAttachment(outlineClient, {
      buffer: download.buffer,
      filename,
      mimeType,
      size: download.size,
      documentId: doc.id, // se supportato
    });
  } catch (err) {
    logger.warn({ err, fileId }, "attachment_upload_to_document_failed");
  }

  const outlineUrl = `${config.OUTLINE_URL.replace(/\/$/, "")}/doc/${doc.urlId || doc.id}`;

  logger.info({ outlineDocumentId: doc.id, title: pageTitle }, "file_ingestion_completed");

  return {
    outlineDocumentId: doc.id,
    outlineUrl,
    title: pageTitle,
    summary,
  };
}
