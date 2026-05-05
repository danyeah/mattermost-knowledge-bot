import type { OutlineClient } from "./client.js";
import { retryWithBackoff, HttpError } from "../utils/retry.js";
import { config } from "../config.js";

export interface OutlineAttachment {
  id: string;
  url: string;
  name: string;
  contentType: string;
  size: number;
}

interface AttachmentCreateResponse {
  uploadUrl: string;
  form: Record<string, string>;
  attachment: {
    id: string;
    url: string;
    name: string;
    contentType: string;
    size: number;
  };
}

export async function uploadAttachment(
  client: OutlineClient,
  opts: { buffer: Buffer; filename: string; mimeType: string; size: number },
): Promise<OutlineAttachment> {
  const { buffer, filename, mimeType, size } = opts;

  const raw = await client.post<AttachmentCreateResponse>("/attachments.create", {
    name: filename,
    contentType: mimeType,
    size,
  });

  if (!raw.uploadUrl || !raw.form || !raw.attachment?.id) {
    throw new Error(`Unexpected attachments.create response: ${JSON.stringify(raw)}`);
  }

  const { uploadUrl, form, attachment } = raw;

  const resolvedUploadUrl = uploadUrl.startsWith("/")
    ? `${config.OUTLINE_URL.replace(/\/$/, "")}${uploadUrl}`
    : uploadUrl;

  const formData = new FormData();
  for (const [key, value] of Object.entries(form)) {
    formData.append(key, value);
  }
  formData.append("file", new Blob([buffer], { type: mimeType }), filename);

  await retryWithBackoff(
    async () => {
      const res = await fetch(resolvedUploadUrl, {
        method: "POST",
        body: formData,
        // No Authorization header — presigned URLs reject extra auth headers
      });
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `attachment upload failed ${res.status}: ${text}`);
      }
    },
    {
      shouldRetry: (err) => {
        if (err instanceof HttpError) return err.status >= 500;
        // Retry network-level errors only; presigned 4xx means bad signature — don't retry
        if (err instanceof TypeError) return true;
        return false;
      },
    },
  );

  return {
    id: attachment.id,
    url: attachment.url,
    name: filename,
    contentType: mimeType,
    size,
  };
}
