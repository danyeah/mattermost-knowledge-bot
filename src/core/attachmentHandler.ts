import type { MattermostClient } from "../mattermost/client.js";
import type { OutlineClient } from "../outline/client.js";
import type { Logger } from "../logger.js";
import { uploadAttachment } from "../outline/attachments.js";
import { config } from "../config.js";

export interface AttachmentMapping {
  fileId: string;
  outlineUrl: string;
  filename: string;
  mimeType: string;
  isImage: boolean;
}

export async function processThreadAttachments(opts: {
  thread: Array<{ id: string; file_ids?: string[] }>;
  ctx: { mmClient: MattermostClient; outlineClient: OutlineClient; logger: Logger };
}): Promise<Map<string, AttachmentMapping>> {
  const { thread, ctx } = opts;
  const { mmClient, outlineClient, logger } = ctx;

  const uniqueFileIds = new Set<string>();
  for (const post of thread) {
    for (const fid of post.file_ids ?? []) {
      uniqueFileIds.add(fid);
    }
  }

  const result = new Map<string, AttachmentMapping>();

  await Promise.all(
    [...uniqueFileIds].map(async (fileId) => {
      try {
        const blob = await mmClient.getFileBlob(fileId);
        const attachment = await uploadAttachment(outlineClient, {
          buffer: blob.buffer,
          filename: blob.name,
          mimeType: blob.mimeType,
          size: blob.size,
        });

        const isImage = blob.mimeType.startsWith("image/");

        // Resolve relative URLs to absolute using the configured Outline base URL
        const outlineUrl = attachment.url.startsWith("/")
          ? `${config.OUTLINE_URL.replace(/\/$/, "")}${attachment.url}`
          : attachment.url;

        result.set(fileId, {
          fileId,
          outlineUrl,
          filename: blob.name,
          mimeType: blob.mimeType,
          isImage,
        });
      } catch (err) {
        logger.warn({ err, fileId }, "attachment_process_failed");
      }
    }),
  );

  return result;
}
