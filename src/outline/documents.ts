import type { OutlineClient } from "./client.js";

export interface OutlineDocument {
  id: string;
  title: string;
  text: string;
  revision?: number;
  urlId?: string;
  collectionId?: string;
  url?: string;
}

export async function createDocument(
  client: OutlineClient,
  opts: { collectionId: string; title: string; text: string },
): Promise<OutlineDocument> {
  const res = await client.post<OutlineDocument>("/documents.create", {
    collectionId: opts.collectionId,
    title: opts.title,
    text: opts.text,
    publish: true,
  });
  if (typeof res?.id !== "string" || typeof res?.title !== "string") {
    throw new Error(`Outline response missing expected fields: ${JSON.stringify(res)}`);
  }
  return res;
}

export async function getDocument(client: OutlineClient, id: string): Promise<OutlineDocument> {
  const res = await client.post<OutlineDocument>("/documents.info", { id });
  if (typeof res?.id !== "string" || typeof res?.title !== "string") {
    throw new Error(`Outline response missing expected fields: ${JSON.stringify(res)}`);
  }
  return res;
}

export async function updateDocument(
  client: OutlineClient,
  opts: { id: string; text: string },
): Promise<OutlineDocument> {
  const res = await client.post<OutlineDocument>("/documents.update", {
    id: opts.id,
    text: opts.text,
    append: false,
  });
  if (typeof res?.id !== "string" || typeof res?.title !== "string") {
    throw new Error(`Outline response missing expected fields: ${JSON.stringify(res)}`);
  }
  return res;
}

export async function deleteDocument(client: OutlineClient, id: string): Promise<void> {
  await client.post("/documents.delete", { id, permanent: true });
}

interface DocumentListResponse {
  data: OutlineDocument[];
  pagination: { total: number; limit: number; offset: number };
}

export async function* listAllDocuments(client: OutlineClient): AsyncGenerator<OutlineDocument> {
  const limit = 25;
  let offset = 0;

  while (true) {
    const res = await client.post<DocumentListResponse>("/documents.list", {
      limit,
      offset,
      sort: "updatedAt",
      direction: "DESC",
    });

    const docs: OutlineDocument[] = Array.isArray(res)
      ? (res as OutlineDocument[])
      : ((res as DocumentListResponse).data ?? []);

    for (const doc of docs) {
      // Fetch full text (list endpoint returns truncated text)
      try {
        const full = await client.post<OutlineDocument>("/documents.info", { id: doc.id });
        yield full;
      } catch {
        yield doc;
      }
    }

    if (docs.length < limit) break;
    offset += limit;
  }
}
