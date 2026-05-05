import type { OutlineClient } from "./client.js";

export interface OutlineCollection {
  id: string;
  name: string;
  urlId?: string;
  description?: string;
  permission?: string;
}

export async function createCollection(
  client: OutlineClient,
  opts: { name: string; description?: string },
): Promise<OutlineCollection> {
  const res = await client.post<OutlineCollection>("/collections.create", {
    name: opts.name,
    description: opts.description ?? "",
    permission: "read",
  });
  if (typeof res?.id !== "string") {
    throw new Error(`Outline response missing expected fields: ${JSON.stringify(res)}`);
  }
  return res;
}
