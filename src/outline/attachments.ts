import type { OutlineClient } from "./client.js";
import { retryWithBackoff, HttpError, isNetworkError } from "../utils/retry.js";
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
  opts: { 
    buffer: Buffer; 
    filename: string; 
    mimeType: string; 
    size: number;
    documentId?: string; 
  },
): Promise<OutlineAttachment> {
  const { buffer, filename, mimeType, size, documentId } = opts;

  const payload: any = {
    name: filename,
    contentType: mimeType,
    size,
  };
  if (documentId) {
    payload.documentId = documentId;
  }

  const raw = await client.post<AttachmentCreateResponse>("/attachments.create", payload);

  if (!raw.uploadUrl || !raw.form || !raw.attachment?.id) {
    throw new Error(`Unexpected attachments.create response: ${JSON.stringify(raw)}`);
  }

  const { uploadUrl, form, attachment } = raw;

  const outlineBase = config.OUTLINE_URL.replace(/\/$/, "");
  const resolvedUploadUrl = uploadUrl.startsWith("/")
    ? `${outlineBase}${uploadUrl}`
    : uploadUrl;

  // When Outline uses local file storage, the uploadUrl points back to Outline
  // itself and requires the Bearer token. With S3/MinIO it's a presigned URL
  // that rejects extra auth headers — detect by host match.
  const usesOutlineUpload =
    uploadUrl.startsWith("/") || resolvedUploadUrl.startsWith(outlineBase);

  const formData = new FormData();
  for (const [key, value] of Object.entries(form)) {
    formData.append(key, value);
  }
  formData.append("file", new Blob([new Uint8Array(buffer)], { type: mimeType }), filename);

  await retryWithBackoff(
    async () => {
      const res = await fetch(resolvedUploadUrl, {
        method: "POST",
        body: formData,
        headers: usesOutlineUpload
          ? { Authorization: `Bearer ${config.OUTLINE_API_TOKEN}` }
          : undefined,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `attachment upload failed ${res.status}: ${text}`);
      }
    },
    {
      shouldRetry: (err) => {
        if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
        return isNetworkError(err);
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
