import type {
  DataChannelMessage,
  DataChannelResponse,
  WsOpened,
  WsFrame,
  WsClose,
  WsError,
  SdpOffer,
  SdpAnswer,
  ApiResponse,
} from "shared/types";
import { bytesToBase64 } from "@remote/shared/lib/relay/bytes";
import { requestRelayHostApi } from "@remote/shared/lib/relayHostApi";
import { Defragmenter, fragment } from "./chunking";

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();
const HTTP_TIMEOUT_MS = 30_000;
const BUFFER_HIGH_WATER = 1024 * 1024;
const BUFFER_LOW_WATER = 256 * 1024;
// Includes base64 overhead for the backend's 50 MiB signed request limit.
const MAX_QUEUED_BYTES = 128 * 1024 * 1024;

export interface WebRtcConnectionCallbacks {
  onDisconnect: () => void;
}

interface PendingHttp {
  resolve: (resp: DataChannelResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  sendState: "queued" | "sending" | "sent";
  sendAbort: AbortController;
}

interface WsHandlers {
  onFrame: (frame: WsFrame) => void;
  onClose: (close: WsClose) => void;
  onError: (error: WsError) => void;
}

export class WebRtcConnection {
  private peerConnection: RTCPeerConnection;
  private dataChannel: RTCDataChannel;
  private defragmenter = new Defragmenter();
  private connected = false;
  private sendQueue: Promise<void> = Promise.resolve();
  private queuedBytes = 0;
  private sendAbort = new AbortController();

  private pendingHttp = new Map<string, PendingHttp>();
  private pendingWsOpen = new Map<
    string,
    {
      resolve: (opened: WsOpened) => void;
      reject: (err: Error) => void;
    }
  >();
  private activeWs = new Map<string, WsHandlers>();

  private constructor(
    pc: RTCPeerConnection,
    dc: RTCDataChannel,
    private callbacks: WebRtcConnectionCallbacks,
  ) {
    this.peerConnection = pc;
    this.dataChannel = dc;
    this.setupDataChannel();
    this.setupIceStateMonitoring();
  }

  static async connect(
    hostId: string,
    callbacks: WebRtcConnectionCallbacks,
  ): Promise<WebRtcConnection> {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const dc = pc.createDataChannel("relay", { ordered: true });

    const gatheringDone = new Promise<void>((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      const timeout = setTimeout(() => {
        done();
      }, 5000);

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          if (event.candidate.type === "srflx") {
            clearTimeout(timeout);
            done();
          }
        } else {
          clearTimeout(timeout);
          done();
        }
      };
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await gatheringDone;

    const sessionId = crypto.randomUUID();
    const offerSdp = pc.localDescription!.sdp;

    const sdpOffer: SdpOffer = { sdp: offerSdp, session_id: sessionId };
    const response = await requestRelayHostApi(hostId, "/api/webrtc/offer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sdpOffer),
    });

    if (!response.ok) {
      pc.close();
      throw new Error(
        `WebRTC offer failed: ${response.status} ${response.statusText}`,
      );
    }

    const answerResponse: ApiResponse<SdpAnswer> = await response.json();
    if (!answerResponse.success || !answerResponse.data) {
      pc.close();
      throw new Error(
        answerResponse.message ?? "WebRTC offer response missing SDP answer",
      );
    }

    await pc.setRemoteDescription({
      type: "answer",
      sdp: answerResponse.data.sdp,
    });

    const conn = new WebRtcConnection(pc, dc, callbacks);
    await conn.waitForOpen();
    return conn;
  }

  get isConnected(): boolean {
    return this.connected && this.dataChannel.readyState === "open";
  }

  sendHttpRequest(
    method: string,
    path: string,
    headers: Record<string, string[]>,
    body?: Uint8Array,
  ): Promise<DataChannelResponse> {
    if (!this.isConnected) {
      return Promise.reject(new Error("WebRTC not connected"));
    }

    const id = crypto.randomUUID();
    const bodyB64 = body ? bytesToBase64(body) : undefined;

    const msg: DataChannelMessage = {
      type: "http_request",
      id,
      method,
      path,
      headers,
      body_b64: bodyB64,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingHttp.delete(id);
        reject(new Error("WebRTC HTTP request timed out"));
        pending.sendAbort.abort();
        // Only a partially sent message corrupts this ordered chunk stream.
        // Queued and fully sent requests can expire without failing their peers.
        if (pending.sendState === "sending") {
          this.handleDisconnect();
          this.close();
        }
      }, HTTP_TIMEOUT_MS);

      const pending: PendingHttp = {
        resolve,
        reject,
        timer,
        sendState: "queued",
        sendAbort: new AbortController(),
      };
      this.pendingHttp.set(id, pending);
      this.sendMessage(msg);
    });
  }

  openWs(
    path: string,
    protocols: string | undefined,
    handlers: WsHandlers,
  ): Promise<{
    connId: string;
    selectedProtocol?: string;
    send: (frame: WsFrame) => void;
    close: (code?: number, reason?: string) => void;
  }> {
    if (!this.isConnected) {
      return Promise.reject(new Error("WebRTC not connected"));
    }

    const connId = crypto.randomUUID();
    this.activeWs.set(connId, handlers);

    const msg: DataChannelMessage = {
      type: "ws_open",
      conn_id: connId,
      path,
      protocols,
    };

    return new Promise((resolve, reject) => {
      this.pendingWsOpen.set(connId, {
        resolve: (opened) => {
          resolve({
            connId: opened.conn_id,
            selectedProtocol: opened.selected_protocol ?? undefined,
            send: (frame) => this.sendMessage({ type: "ws_frame", ...frame }),
            close: (code, reason) => {
              this.activeWs.delete(connId);
              this.sendMessage({
                type: "ws_close",
                conn_id: connId,
                code,
                reason,
              } as DataChannelMessage);
            },
          });
        },
        reject: (err) => {
          this.activeWs.delete(connId);
          reject(err);
        },
      });

      this.sendMessage(msg);
    });
  }

  close(): void {
    // Connection-manager cleanup may be closing a stale connection. Do not
    // let its callback remove a newer connection for the same host.
    this.handleDisconnect(false);
    try {
      this.dataChannel.close();
    } catch {
      // ignore
    }
    try {
      this.peerConnection.close();
    } catch {
      // ignore
    }
  }

  // --- Private ---

  private waitForOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.dataChannel.readyState === "open") {
        this.connected = true;
        resolve();
        return;
      }
      const timeout = setTimeout(() => {
        reject(new Error("Data channel open timed out"));
      }, 10_000);
      this.dataChannel.addEventListener(
        "open",
        () => {
          clearTimeout(timeout);
          this.connected = true;
          resolve();
        },
        { once: true },
      );
      this.dataChannel.addEventListener(
        "error",
        () => {
          clearTimeout(timeout);
          reject(new Error("Data channel error during open"));
        },
        { once: true },
      );
    });
  }

  private setupDataChannel(): void {
    this.dataChannel.binaryType = "arraybuffer";
    this.dataChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;

    this.dataChannel.onmessage = (event: MessageEvent) => {
      const complete = this.defragmenter.process(event.data);
      if (complete) {
        this.handleMessage(complete);
      }
    };

    this.dataChannel.onclose = () => this.handleDisconnect();
    this.dataChannel.onerror = () => this.handleDisconnect();
  }

  private setupIceStateMonitoring(): void {
    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection.iceConnectionState;
      if (
        state === "disconnected" ||
        state === "failed" ||
        state === "closed"
      ) {
        this.handleDisconnect();
      }
    };
  }

  private handleDisconnect(notify = true): void {
    this.sendAbort.abort();
    if (!this.connected) return;
    this.connected = false;

    for (const [id, pending] of this.pendingHttp) {
      clearTimeout(pending.timer);
      pending.reject(new Error("WebRTC disconnected"));
      this.pendingHttp.delete(id);
    }

    for (const [connId, pending] of this.pendingWsOpen) {
      pending.reject(new Error("WebRTC disconnected"));
      this.pendingWsOpen.delete(connId);
    }

    for (const [connId, handlers] of this.activeWs) {
      handlers.onClose({
        conn_id: connId,
        code: 1006,
        reason: "WebRTC disconnected",
      });
      this.activeWs.delete(connId);
    }

    if (notify) this.callbacks.onDisconnect();
  }

  private handleMessage(raw: Uint8Array): void {
    let msg: DataChannelMessage;
    try {
      msg = JSON.parse(TEXT_DECODER.decode(raw));
    } catch {
      return;
    }

    switch (msg.type) {
      case "http_response": {
        const pending = this.pendingHttp.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingHttp.delete(msg.id);
          pending.resolve(msg);
        }
        break;
      }
      case "ws_opened": {
        const pending = this.pendingWsOpen.get(msg.conn_id);
        if (pending) {
          this.pendingWsOpen.delete(msg.conn_id);
          pending.resolve(msg);
        }
        break;
      }
      case "ws_frame":
        this.activeWs.get(msg.conn_id)?.onFrame(msg);
        break;
      case "ws_close": {
        const handlers = this.activeWs.get(msg.conn_id);
        if (handlers) {
          this.activeWs.delete(msg.conn_id);
          handlers.onClose(msg);
        }
        break;
      }
      case "ws_error": {
        const pending = this.pendingWsOpen.get(msg.conn_id);
        if (pending) {
          this.pendingWsOpen.delete(msg.conn_id);
          pending.reject(new Error(msg.error));
        } else {
          const handlers = this.activeWs.get(msg.conn_id);
          if (handlers) {
            this.activeWs.delete(msg.conn_id);
            handlers.onError(msg);
          }
        }
        break;
      }
    }
  }

  private waitForBuffer(requestAbort?: AbortSignal): Promise<void> {
    const dc = this.dataChannel;
    const signal = this.sendAbort.signal;
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        dc.removeEventListener("bufferedamountlow", onLow);
        dc.removeEventListener("close", onClosed);
        dc.removeEventListener("error", onClosed);
        signal.removeEventListener("abort", onClosed);
        requestAbort?.removeEventListener("abort", onClosed);
      };
      const onClosed = () => {
        cleanup();
        reject(new Error("WebRTC closed while waiting for send buffer"));
      };
      const onLow = () => {
        if (
          signal.aborted ||
          requestAbort?.aborted ||
          dc.readyState !== "open"
        ) {
          onClosed();
        } else if (dc.bufferedAmount <= BUFFER_LOW_WATER) {
          cleanup();
          resolve();
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("WebRTC send buffer timed out"));
      }, HTTP_TIMEOUT_MS);
      dc.addEventListener("bufferedamountlow", onLow);
      dc.addEventListener("close", onClosed);
      dc.addEventListener("error", onClosed);
      signal.addEventListener("abort", onClosed);
      requestAbort?.addEventListener("abort", onClosed);
      // Recheck after subscribing so drain/close cannot be missed.
      onLow();
    });
  }

  private async sendRaw(
    data: Uint8Array,
    pending?: PendingHttp,
  ): Promise<void> {
    const chunks = fragment(data);
    for (const chunk of chunks) {
      if (
        this.dataChannel.bufferedAmount + chunk.byteLength >
        BUFFER_HIGH_WATER
      ) {
        try {
          await this.waitForBuffer(pending?.sendAbort.signal);
        } catch (error) {
          if (pending?.sendAbort.signal.aborted) return;
          throw error;
        }
      }
      if (!this.isConnected || this.sendAbort.signal.aborted) {
        throw new Error("WebRTC not connected");
      }
      if (pending?.sendAbort.signal.aborted) return;
      if (pending) pending.sendState = "sending";
      this.dataChannel.send(new Uint8Array(chunk) as Uint8Array<ArrayBuffer>);
    }
    if (pending) pending.sendState = "sent";
  }

  private sendMessage(msg: DataChannelMessage): void {
    const data = TEXT_ENCODER.encode(JSON.stringify(msg));
    // Bound the JS backlog as well as the browser's SCTP buffer.
    if (this.queuedBytes + data.byteLength > MAX_QUEUED_BYTES) {
      this.handleDisconnect();
      this.close();
      return;
    }
    this.queuedBytes += data.byteLength;
    // The chunk protocol has no message IDs: fragments from different messages
    // must never interleave, including while the first message waits for drain.
    this.sendQueue = this.sendQueue
      .then(async () => {
        const pending =
          msg.type === "http_request"
            ? this.pendingHttp.get(msg.id)
            : undefined;
        if (msg.type === "http_request" && !pending) return;
        await this.sendRaw(data, pending);
      })
      .catch(() => {
        // A partial message cannot be resumed on this channel. Closing rejects
        // pending operations and lets the existing transport reconnect/fallback.
        this.handleDisconnect();
        this.close();
      })
      .finally(() => {
        this.queuedBytes -= data.byteLength;
      });
  }
}
