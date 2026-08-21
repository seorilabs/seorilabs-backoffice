// Discord Gateway v10 WebSocket 클라이언트. MESSAGE_CREATE 는 Gateway 로만 오므로
// AI 팀원의 멘션 대화에 필요하다. 저장소 관례대로 SDK 없이 Node 24 전역 WebSocket 을
// 사용하고, JSON encoding 만 쓴다(zlib 압축 미요청).

const API_BASE = "https://discord.com/api/v10";
const GATEWAY_QUERY = "/?v=10&encoding=json";

// IDENTIFY intents. 봇이 멘션된 메시지는 MESSAGE_CONTENT 특권 인텐트 없이도
// 본문이 전달되므로 비특권 2종이면 충분하다.
export const GATEWAY_INTENT_GUILDS = 1 << 0;
export const GATEWAY_INTENT_GUILD_MESSAGES = 1 << 9;

const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

export interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string | null;
}

export function parseGatewayPayload(raw: unknown): GatewayPayload | null {
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw) as GatewayPayload;
    if (!parsed || typeof parsed !== "object" || typeof parsed.op !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * close code 별 재접속 방식. 4004(인증 실패)와 4010–4014(shard/버전/intent 오류)는
 * 재시도해도 같은 이유로 끊기므로 fatal. 4007(잘못된 seq)과 4009(세션 만료)는
 * 세션을 버리고 재식별. 나머지는 RESUME 시도.
 */
export type GatewayCloseAction = "resume" | "identify" | "fatal";

export function closeCodeAction(code: number | undefined): GatewayCloseAction {
  if (code === undefined) return "resume";
  if (code === 4004 || (code >= 4010 && code <= 4014)) return "fatal";
  if (code === 4007 || code === 4009) return "identify";
  return "resume";
}

export function nextBackoffMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, Math.min(attempt, 6)));
}

// 첫 heartbeat 는 interval * jitter(0~1) 뒤에 보내 동시 재접속 폭주를 피한다.
export function initialHeartbeatDelay(intervalMs: number, rand: number): number {
  const ratio = Math.min(1, Math.max(0, rand));
  return Math.max(0, Math.round(intervalMs * ratio));
}

export async function fetchGatewayUrl(token: string): Promise<string> {
  const response = await fetch(`${API_BASE}/gateway/bot`, {
    headers: { authorization: `Bot ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Discord /gateway/bot HTTP ${response.status}`);
  const json = (await response.json().catch(() => null)) as { url?: unknown } | null;
  if (!json || typeof json.url !== "string" || !json.url) {
    throw new Error("Discord /gateway/bot 응답에 url 없음");
  }
  return json.url;
}

export interface GatewayHandlers {
  onDispatch: (type: string, data: unknown) => void;
  onReady?: (info: { sessionId: string; botUserId: string }) => void;
}

interface ReadyData {
  session_id?: string;
  resume_gateway_url?: string;
  user?: { id?: string };
}

export class DiscordGatewayConnection {
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeGatewayUrl: string | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private firstHeartbeat: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private awaitingAck = false;
  private attempts = 0;
  private stopped = false;
  private fatalReason: string | null = null;

  constructor(
    private readonly options: {
      token: string;
      intents: number;
      gatewayUrl: string;
      label: string;
      handlers: GatewayHandlers;
    },
  ) {}

  get fatal(): string | null {
    return this.fatalReason;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    try {
      this.ws?.close(1000);
    } catch {
      /* 이미 닫힌 소켓 */
    }
    this.ws = null;
  }

  private log(message: string): void {
    console.log(`[gateway:${this.options.label}] ${message}`);
  }

  private clearTimers(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.firstHeartbeat) clearTimeout(this.firstHeartbeat);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatInterval = null;
    this.firstHeartbeat = null;
    this.reconnectTimer = null;
  }

  private connect(): void {
    if (this.stopped || this.fatalReason) return;
    const base = this.sessionId && this.resumeGatewayUrl ? this.resumeGatewayUrl : this.options.gatewayUrl;
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${base}${GATEWAY_QUERY}`);
    } catch (error) {
      this.log(`연결 생성 실패: ${error instanceof Error ? error.message : "error"}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener("message", (event) => {
      if (this.ws === ws) this.onMessage(event.data);
    });
    ws.addEventListener("close", (event) => {
      if (this.ws === ws) this.onClose(event.code);
    });
    ws.addEventListener("error", () => {
      // 오류 후에는 close 이벤트가 따라온다. 재접속은 close 에서 처리한다.
    });
  }

  private send(payload: GatewayPayload): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (error) {
      this.log(`send 실패: ${error instanceof Error ? error.message : "error"}`);
    }
  }

  private onMessage(raw: unknown): void {
    const payload = parseGatewayPayload(raw);
    if (!payload) return;
    if (typeof payload.s === "number") this.seq = payload.s;
    switch (payload.op) {
      case OP_HELLO: {
        const interval = Number((payload.d as { heartbeat_interval?: unknown } | null)?.heartbeat_interval);
        this.startHeartbeats(Number.isFinite(interval) && interval > 0 ? interval : 41_250);
        if (this.sessionId) {
          this.send({
            op: OP_RESUME,
            d: { token: this.options.token, session_id: this.sessionId, seq: this.seq },
          });
        } else {
          this.identify();
        }
        return;
      }
      case OP_HEARTBEAT_ACK:
        this.awaitingAck = false;
        return;
      case OP_HEARTBEAT:
        this.send({ op: OP_HEARTBEAT, d: this.seq });
        return;
      case OP_RECONNECT:
        this.log("서버 RECONNECT 요청 — RESUME 재접속");
        this.restart();
        return;
      case OP_INVALID_SESSION:
        if (payload.d !== true) this.sessionId = null;
        this.log(`INVALID_SESSION (resumable=${payload.d === true})`);
        this.restart();
        return;
      case OP_DISPATCH: {
        const type = payload.t ?? "";
        if (type === "READY") {
          const data = (payload.d ?? {}) as ReadyData;
          this.sessionId = typeof data.session_id === "string" ? data.session_id : null;
          this.resumeGatewayUrl =
            typeof data.resume_gateway_url === "string" ? data.resume_gateway_url : null;
          this.attempts = 0;
          const botUserId = typeof data.user?.id === "string" ? data.user.id : "";
          this.log(`READY (bot=${botUserId})`);
          if (this.sessionId && botUserId) {
            this.options.handlers.onReady?.({ sessionId: this.sessionId, botUserId });
          }
        } else if (type === "RESUMED") {
          this.attempts = 0;
          this.log("RESUMED");
        }
        if (type) this.options.handlers.onDispatch(type, payload.d);
        return;
      }
      default:
        return;
    }
  }

  private identify(): void {
    this.send({
      op: OP_IDENTIFY,
      d: {
        token: this.options.token,
        intents: this.options.intents,
        properties: { os: "linux", browser: "seorilabs-backoffice", device: "seorilabs-backoffice" },
      },
    });
  }

  private startHeartbeats(intervalMs: number): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.firstHeartbeat) clearTimeout(this.firstHeartbeat);
    this.awaitingAck = false;
    this.firstHeartbeat = setTimeout(() => {
      this.beat();
      this.heartbeatInterval = setInterval(() => this.beat(), intervalMs);
    }, initialHeartbeatDelay(intervalMs, Math.random()));
  }

  private beat(): void {
    if (this.awaitingAck) {
      // 직전 heartbeat 에 ACK 이 없으면 좀비 연결이다. 닫고 RESUME 한다.
      this.log("heartbeat ACK 누락 — 재접속");
      this.restart();
      return;
    }
    this.awaitingAck = true;
    this.send({ op: OP_HEARTBEAT, d: this.seq });
  }

  // 현재 소켓을 닫고 close 핸들러 경유로 재접속한다(세션 유지 시 RESUME).
  private restart(): void {
    const ws = this.ws;
    if (!ws) {
      this.scheduleReconnect();
      return;
    }
    try {
      ws.close(3000);
    } catch {
      this.onClose(undefined);
    }
  }

  private onClose(code: number | undefined): void {
    this.clearTimers();
    this.ws = null;
    this.awaitingAck = false;
    if (this.stopped) return;
    const action = closeCodeAction(code);
    if (action === "fatal") {
      this.fatalReason = `Gateway close ${code}`;
      console.error(`[gateway:${this.options.label}] 복구 불가 종료 (${code}) — 재접속 중단`);
      return;
    }
    if (action === "identify") this.sessionId = null;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.fatalReason || this.reconnectTimer) return;
    const delay = nextBackoffMs(this.attempts);
    this.attempts += 1;
    this.log(`${delay}ms 후 재접속 (attempt ${this.attempts})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
