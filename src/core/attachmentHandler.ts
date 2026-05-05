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

  for (const fileId of uniqueFileIds) {
    try {
      const download = await mmClient.getFileBlob(fileId);
      const attachment = await uploadAttachment(outlineClient, {
        buffer: download.buffer,
        filename: download.name,
        mimeType: download.mimeType,
        size: download.size,
      });

      const isImage = download.mimeType.startsWith("image/");

      const outlineUrl = attachment.url.startsWith("/")
        ? `${config.OUTLINE_URL.replace(/\/$/, "")}${attachment.url}`
        : attachment.url;

      result.set(fileId, {
        fileId,
        outlineUrl,
        filename: download.name,
        mimeType: download.mimeType,
        isImage,
      });
    } catch (err) {
      logger.warn({ err, fileId }, "attachment_process_failed");
    }
  }

  return result;
}
