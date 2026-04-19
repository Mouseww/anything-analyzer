import { EventEmitter } from "events";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as tls from "tls";
import * as url from "url";
import { v4 as uuidv4 } from "uuid";
import type { CaManager } from "./ca-manager";

const MAX_BODY_SIZE = 1024 * 1024; // 1MB — same limit as CdpManager
const BINARY_CONTENT_TYPES = [
  "image/",
  "font/",
  "audio/",
  "video/",
  "application/octet-stream",
  "application/pdf",
  "application/zip",
];
const STATIC_EXTENSIONS = /\.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?|ttf|eot|map)$/i;

/**
 * MitmProxyServer — An embedded HTTP/HTTPS man-in-the-middle proxy.
 *
 * HTTP requests are forwarded directly.
 * HTTPS CONNECT requests are intercepted via dynamic TLS certificates
 * issued by the CaManager's root CA.
 *
 * Emits 'response-captured' events with the same data shape as CdpManager,
 * so CaptureEngine can handle them identically.
 */
export class MitmProxyServer extends EventEmitter {
  private server: http.Server | null = null;
  private port: number | null = null;
  private connections = new Set<net.Socket>();

  constructor(private caManager: CaManager) {
    super();
  }

  async start(port: number): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.server.on("connect", (req, clientSocket, head) => {
      this.handleConnect(req, clientSocket, head);
    });

    this.server.on("connection", (socket) => {
      this.connections.add(socket);
      socket.on("close", () => this.connections.delete(socket));
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(port, "127.0.0.1", () => {
        this.port = port;
        console.log(`[MitmProxy] Listening on port ${port}`);
        resolve();
      });
      this.server!.on("error", (err) => {
        console.error("[MitmProxy] Server error:", err.message);
        reject(err);
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;

    // Close all active connections
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();

    return new Promise((resolve) => {
      this.server!.close(() => {
        console.log("[MitmProxy] Stopped");
        this.server = null;
        this.port = null;
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  getPort(): number | null {
    return this.port;
  }

  // ---- HTTP (non-CONNECT) proxy ----

  private handleHttpRequest(
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
  ): void {
    const startTime = Date.now();
    const requestId = `proxy-${uuidv4()}`;

    const targetUrl = clientReq.url;
    if (!targetUrl) {
      clientRes.writeHead(400);
      clientRes.end("Bad Request");
      return;
    }

    const parsed = url.parse(targetUrl);
    const reqBodyChunks: Buffer[] = [];

    clientReq.on("data", (chunk: Buffer) => {
      if (Buffer.concat(reqBodyChunks).length < MAX_BODY_SIZE) {
        reqBodyChunks.push(chunk);
      }
    });

    clientReq.on("end", () => {
      const reqBody = Buffer.concat(reqBodyChunks);
      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.path,
        method: clientReq.method,
        headers: { ...clientReq.headers },
      };

      // Remove proxy-specific headers
      delete options.headers!["proxy-connection"];

      const proxyReq = http.request(options, (proxyRes) => {
        this.relayResponse(
          requestId,
          startTime,
          clientReq,
          reqBody,
          targetUrl,
          proxyRes,
          clientRes,
        );
      });

      proxyReq.on("error", (err) => {
        console.warn("[MitmProxy] HTTP proxy error:", err.message);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502);
          clientRes.end("Bad Gateway");
        }
      });

      if (reqBody.length > 0) proxyReq.write(reqBody);
      proxyReq.end();
    });
  }

  // ---- HTTPS CONNECT tunnel ----

  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    const [hostname, portStr] = (req.url || "").split(":");
    const port = parseInt(portStr, 10) || 443;

    if (!hostname) {
      clientSocket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }

    // Check if this is a WebSocket upgrade — just tunnel through
    const upgradeHeader = req.headers["upgrade"];
    if (upgradeHeader && upgradeHeader.toLowerCase() === "websocket") {
      this.tunnelDirect(hostname, port, clientSocket, head);
      return;
    }

    // Acknowledge CONNECT
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

    // Create TLS server socket with a dynamic certificate for this host
    const secureContext = this.caManager.getSecureContextForHost(hostname);
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      isServer: true,
      secureContext,
    });

    if (head.length > 0) tlsSocket.unshift(head);

    // Create a mini HTTP server on the decrypted stream
    const miniServer = http.createServer((decryptedReq, decryptedRes) => {
      this.handleDecryptedRequest(
        hostname,
        port,
        decryptedReq,
        decryptedRes,
      );
    });

    // Pipe the TLS socket into the mini server
    miniServer.emit("connection", tlsSocket);

    tlsSocket.on("error", (err) => {
      console.warn(`[MitmProxy] TLS error for ${hostname}:`, err.message);
    });

    clientSocket.on("error", () => {
      tlsSocket.destroy();
    });
  }

  /**
   * Handle a decrypted HTTPS request (after TLS interception).
   */
  private handleDecryptedRequest(
    hostname: string,
    port: number,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
  ): void {
    const startTime = Date.now();
    const requestId = `proxy-${uuidv4()}`;
    const fullUrl = `https://${hostname}${port !== 443 ? ":" + port : ""}${clientReq.url || "/"}`;

    const reqBodyChunks: Buffer[] = [];

    clientReq.on("data", (chunk: Buffer) => {
      if (Buffer.concat(reqBodyChunks).length < MAX_BODY_SIZE) {
        reqBodyChunks.push(chunk);
      }
    });

    clientReq.on("end", () => {
      const reqBody = Buffer.concat(reqBodyChunks);
      const options: https.RequestOptions = {
        hostname,
        port,
        path: clientReq.url,
        method: clientReq.method,
        headers: { ...clientReq.headers, host: hostname },
        rejectUnauthorized: false, // We are the MITM — upstream cert check is lax
      };

      const proxyReq = https.request(options, (proxyRes) => {
        this.relayResponse(
          requestId,
          startTime,
          clientReq,
          reqBody,
          fullUrl,
          proxyRes,
          clientRes,
        );
      });

      proxyReq.on("error", (err) => {
        console.warn("[MitmProxy] HTTPS proxy error:", err.message);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502);
          clientRes.end("Bad Gateway");
        }
      });

      if (reqBody.length > 0) proxyReq.write(reqBody);
      proxyReq.end();
    });
  }

  /**
   * Relay upstream response back to the client, and emit a capture event.
   */
  private relayResponse(
    requestId: string,
    startTime: number,
    clientReq: http.IncomingMessage,
    reqBody: Buffer,
    fullUrl: string,
    proxyRes: http.IncomingMessage,
    clientRes: http.ServerResponse,
  ): void {
    const resBodyChunks: Buffer[] = [];
    let totalResSize = 0;
    let truncated = false;

    proxyRes.on("data", (chunk: Buffer) => {
      if (totalResSize < MAX_BODY_SIZE) {
        resBodyChunks.push(chunk);
      } else {
        truncated = true;
      }
      totalResSize += chunk.length;
    });

    proxyRes.on("end", () => {
      const durationMs = Date.now() - startTime;
      const resBody = Buffer.concat(resBodyChunks);
      const contentType =
        (proxyRes.headers["content-type"] as string) || null;
      const method = clientReq.method || "GET";

      // Determine if body should be captured (skip binary)
      const isBinary = contentType
        ? BINARY_CONTENT_TYPES.some((t) => contentType.startsWith(t))
        : false;

      const isStreaming =
        contentType?.includes("text/event-stream") || false;
      const isWebSocket = false; // WebSocket is tunneled, not intercepted
      const isOptions = method === "OPTIONS";
      const isStatic = STATIC_EXTENSIONS.test(fullUrl);

      const requestHeaders = JSON.stringify(clientReq.headers || {});
      const responseHeaders = JSON.stringify(proxyRes.headers || {});

      const requestBody =
        reqBody.length > 0 && !isBinary
          ? reqBody.toString("utf-8").substring(0, MAX_BODY_SIZE)
          : null;

      const responseBody =
        resBody.length > 0 && !isBinary
          ? resBody.toString("utf-8").substring(0, MAX_BODY_SIZE)
          : null;

      this.emit("response-captured", {
        requestId,
        method,
        url: fullUrl,
        requestHeaders,
        requestBody,
        statusCode: proxyRes.statusCode || 0,
        responseHeaders,
        responseBody,
        contentType,
        initiator: null,
        durationMs,
        isOptions,
        isStatic,
        isStreaming,
        isWebSocket,
        truncated,
        timestamp: startTime,
      });
    });

    // Forward response to client
    clientRes.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
    proxyRes.pipe(clientRes);
  }

  /**
   * Direct tunnel for WebSocket or other non-intercepted CONNECT targets.
   */
  private tunnelDirect(
    hostname: string,
    port: number,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    const serverSocket = net.connect(port, hostname, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) serverSocket.write(head);
      serverSocket.pipe(clientSocket);
      clientSocket.pipe(serverSocket);
    });

    serverSocket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => serverSocket.destroy());
  }
}
