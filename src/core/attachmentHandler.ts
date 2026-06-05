import type { MattermostClient } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { uploadAttachment } from "../outline/attachments.js";
import { config } from "../config.js";
import { extractTextFromFile, summarizeFile } from "./fileSummarizer.js";

export interface AttachmentMapping {
  fileId: string;
  outlineUrl: string;
  filename: string;
  mimeType: string;
  isImage: boolean;
  /** LLM-generated summary if the file content could be extracted. */
  summary?: string;
  /** Raw extracted text — fed to the section-merge AI so it can populate
   * Summary/Decisions/Technical from the document content. */
  extractedText?: string;
}

export async function processThreadAttachments(opts: {
  thread: Array<{ id: string; file_ids?: string[] }>;
  documentId?: string;
  ctx: { mmClient: MattermostClient; outlineClient: OutlineClient; logger: Logger };
}): Promise<Map<string, AttachmentMapping>> {
  const { thread, documentId, ctx } = opts;
  const { mmClient, outlineClient, logger } = ctx;

  const uniqueFileIds = new Set<string>();
  for (const post of thread) {
    for (const fid of post.file_ids ?? []) {
      uniqueFileIds.add(fid);
    }
  }

  const result = new Map<string, AttachmentMapping>();

  for (const fileId of uniqueFileIds) {
    try {
      const download = await mmClient.getFileBlob(fileId);
      const attachment = await uploadAttachment(outlineClient, {
        buffer: download.buffer,
        filename: download.name,
        mimeType: download.mimeType,
        size: download.size,
        documentId, // <-- attach to the specific document if provided
      });

      const isImage = download.mimeType.startsWith("image/");

      const outlineUrl = attachment.url.startsWith("/")
        ? `${config.OUTLINE_URL.replace(/\/$/, "")}${attachment.url}`
        : attachment.url;

      let summary: string | undefined;
      let extractedText: string | undefined;
      if (!isImage) {
        try {
          const extracted = await extractTextFromFile(
            download.buffer,
            download.name,
            download.mimeType,
          );
          if (extracted.skipReason) {
            logger.info(
              { fileId, filename: download.name, reason: extracted.skipReason },
              "attachment_text_extraction_skipped",
            );
          } else {
            if (extracted.text.trim().length > 0) {
              extractedText = extracted.text;
            }
            const s = await summarizeFile(extracted.text, download.name);
            if (s) summary = s;
          }
        } catch (err) {
          logger.warn({ err, fileId, filename: download.name }, "attachment_summary_failed");
        }
      }

      const mapping: AttachmentMapping = {
        fileId,
        outlineUrl,
        filename: download.name,
        mimeType: download.mimeType,
        isImage,
        ...(summary !== undefined && { summary }),
        ...(extractedText !== undefined && { extractedText }),
      };
      result.set(fileId, mapping);
    } catch (err) {
      logger.warn({ err, fileId }, "attachment_process_failed");
    }
  }

  return result;
}
