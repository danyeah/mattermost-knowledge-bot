import type { Logger } from "../logger.js";
import { retryWithBackoff, HttpError } from "../utils/retry.js";

export interface Post {
  id: string;
  create_at: number;
  update_at: number;
  user_id: string;
  channel_id: string;
  root_id: string;
  message: string;
  type: string;
  props: Record<string, unknown>;
  file_ids?: string[];
  metadata?: Record<string, unknown>;
}

export interface User {
  id: string;
  username: string;
  first_name: string;
  last_name: string;
  email: string;
  nickname: string;
}

export interface Channel {
  id: string;
  name: string;
  display_name: string;
  team_id: string;
  type: string;
}

export interface Team {
  id: string;
  name: string;
  display_name: string;
}

export interface Thread {
  order: string[];
  posts: Record<string, Post>;
}

export class MattermostAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MattermostAuthError";
  }
}

export class MattermostClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly logger: Logger;

  constructor(baseUrl: string, token: string, logger: Logger) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.token = token;
    this.logger = logger;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}/api/v4${path}`;
    return retryWithBackoff(async () => {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      if (res.status === 401) {
        const text = await res.text();
        throw new MattermostAuthError(`Authentication failed (401): ${text}`);
      }

      if (!res.ok) {
        const text = await res.text();
        throw new HttpError(res.status, text, `HTTP ${res.status} ${method} ${path}: ${text}`);
      }

      return res.json() as Promise<T>;
    }, {
      shouldRetry: (err) => {
        if (err instanceof MattermostAuthError) return false;
        if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
        return false;
      },
    });
  }

  async me(): Promise<User> {
    return this.request<User>("GET", "/users/me");
  }

  async getMyTeams(): Promise<Team[]> {
    return this.request<Team[]>("GET", "/users/me/teams");
  }

  async getChannel(channelId: string): Promise<Channel> {
    return this.request<Channel>("GET", `/channels/${channelId}`);
  }

  async getThread(rootId: string): Promise<Thread> {
    return this.request<Thread>("GET", `/posts/${rootId}/thread`);
  }

  async getUsersByIds(ids: string[]): Promise<User[]> {
    if (ids.length === 0) return [];
    return this.request<User[]>("POST", "/users/ids", ids);
  }

  async getTeam(teamId: string): Promise<Team> {
    return this.request<Team>("GET", `/teams/${teamId}`);
  }

  async createPost(params: { channel_id: string; message: string; root_id?: string }): Promise<Post> {
    this.logger.debug({ channel_id: params.channel_id, root_id: params.root_id }, "create_post");
    return this.request<Post>("POST", "/posts", params);
  }

  async deletePost(postId: string): Promise<void> {
    await this.request<void>("DELETE", `/posts/${postId}`);
  }

  async getFileInfo(fileId: string): Promise<{
    id: string;
    name: string;
    mime_type: string;
    size: number;
    [key: string]: unknown;
  }> {
    return this.request(`GET`, `/files/${fileId}/info`);
  }

  async getFileBlob(fileId: string): Promise<{
    buffer: Buffer;
    mimeType: string;
    size: number;
    name: string;
  }> {
    const url = `${this.baseUrl}/api/v4/files/${fileId}`;
    return retryWithBackoff(
      async () => {
        const res = await fetch(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${this.token}` },
        });

        if (res.status === 401) {
          const text = await res.text();
          throw new MattermostAuthError(`Authentication failed (401): ${text}`);
        }

        if (!res.ok) {
          const text = await res.text();
          throw new HttpError(res.status, text, `HTTP GET /files/${fileId}: ${text}`);
        }

        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const contentType = res.headers.get("Content-Type") ?? "";
        const mimeType = contentType.split(";")[0]?.trim() ?? "application/octet-stream";

        const disposition = res.headers.get("Content-Disposition") ?? "";
        const filenameMatch = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
        let name = filenameMatch?.[1]?.trim() ?? "";
        if (!name) {
          // Fall back to file info endpoint for the filename
          const info = await this.getFileInfo(fileId);
          name = info.name;
        }

        return { buffer, mimeType, size: buffer.length, name };
      },
      {
        shouldRetry: (err) => {
          if (err instanceof MattermostAuthError) return false;
          if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
          return false;
        },
      },
    );
  }
}
