import WebSocket from "ws";
import type { Logger } from "../logger.js";

export interface KnownWsEvent {
  event: "posted";
  data: { post: string; channel_name?: string; sender_name?: string };
  broadcast: { channel_id: string; team_id: string };
}

interface ReactionAddedEvent {
  event: "reaction_added";
  data: { reaction: string };
  broadcast: { channel_id: string };
}

interface UserAddedEvent {
  event: "user_added";
  data: { user_id: string; team_id: string };
  broadcast: { channel_id: string };
}

export interface UnknownWsEvent {
  event: string;
  data: unknown;
  broadcast: unknown;
}

export type WsEvent = KnownWsEvent | ReactionAddedEvent | UserAddedEvent | UnknownWsEvent;

interface WsMessage {
  seq_reply?: number;
  event?: string;
  data?: unknown;
  broadcast?: unknown;
  status?: string;
}

export interface MattermostWebSocketOpts {
  url: string;
  token: string;
  logger: Logger;
  dispatch: (event: WsEvent) => void;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const NO_MESSAGE_TIMEOUT_MS = 60_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export class MattermostWebSocket {
  private readonly opts: MattermostWebSocketOpts;
  private closed = false;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private noMessageTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  constructor(opts: MattermostWebSocketOpts) {
    this.opts = opts;
  }

  connect(): void {
    void this.connectionLoop();
  }

  close(): void {
    this.closed = true;
    this.cleanup();
    this.ws?.terminate();
    this.ws = null;
  }

  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.noMessageTimer) {
      clearTimeout(this.noMessageTimer);
      this.noMessageTimer = null;
    }
  }

  private async connectionLoop(): Promise<void> {
    while (!this.closed) {
      try {
        await this.connectOnce();
      } catch (err) {
        this.opts.logger.error({ err }, "ws_loop_error");
      }
      if (this.closed) break;

      const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX_MS);
      this.opts.logger.warn({ reconnect_attempt: this.reconnectAttempt, delay_ms: delay }, "ws_reconnecting");
      this.reconnectAttempt++;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve) => {
      const wsUrl = this.opts.url.replace(/^http/, "ws") + "/api/v4/websocket";
      this.opts.logger.info({ url: wsUrl }, "ws_connecting");

      let ws: WebSocket;
      try {
        ws = new WebSocket(wsUrl);
      } catch (err) {
        this.opts.logger.error({ err }, "ws_constructor_failed");
        resolve();
        return;
      }
      this.ws = ws;

      let authenticated = false;
      let seq = 1;

      const resetNoMessageTimer = (): void => {
        if (this.noMessageTimer) clearTimeout(this.noMessageTimer);
        // no-message timeout forces reconnect because Mattermost can drop the WS silently
        this.noMessageTimer = setTimeout(() => {
          this.opts.logger.warn("ws_no_message_timeout — forcing reconnect");
          ws.terminate();
        }, NO_MESSAGE_TIMEOUT_MS);
      };

      ws.on("open", () => {
        this.cleanup();
        this.opts.logger.debug("ws_open — sending auth challenge");
        ws.send(
          JSON.stringify({
            seq: seq++,
            action: "authentication_challenge",
            data: { token: this.opts.token },
          }),
        );
        resetNoMessageTimer();

        this.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ seq: seq++, action: "ping" }));
            this.opts.logger.debug("ws_heartbeat_sent");
          }
        }, HEARTBEAT_INTERVAL_MS);
      });

      ws.on("message", (raw) => {
        resetNoMessageTimer();

        let msg: WsMessage;
        try {
          msg = JSON.parse(raw.toString()) as WsMessage;
        } catch {
          this.opts.logger.warn({ raw: raw.toString() }, "ws_invalid_json");
          return;
        }

        if (msg.seq_reply !== undefined && msg.status === "OK") {
          if (!authenticated) {
            authenticated = true;
            this.opts.logger.info("ws_authenticated");
          }
          return;
        }

        const event = msg.event;

        if (event === "hello") {
          this.reconnectAttempt = 0;
          this.opts.logger.info("ws_connected");
          return;
        }

        if (event === "pong" || !event) {
          this.opts.logger.debug({ msg }, "ws_internal_event");
          return;
        }

        const wsEvent: WsEvent = {
          event,
          data: msg.data,
          broadcast: msg.broadcast,
        };
        this.opts.dispatch(wsEvent);
      });

      ws.on("error", (err) => {
        this.opts.logger.error({ err }, "ws_error");
      });

      ws.on("close", (code, reason) => {
        this.cleanup();
        this.opts.logger.info({ code, reason: reason.toString() }, "ws_closed");
        resolve();
      });
    });
  }
}
