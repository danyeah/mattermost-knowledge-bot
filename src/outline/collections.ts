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
  return client.post<OutlineCollection>("/collections.create", {
    name: opts.name,
    description: opts.description ?? "",
    permission: "read",
  });
}
