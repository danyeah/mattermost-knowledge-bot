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
}
