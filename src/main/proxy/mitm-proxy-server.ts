import { EventEmitter } from "events";
import * as http from "http";
import * as https from "https";
import * as net from "net";
import * as tls from "tls";
import * as url from "url";
import {
  brotliDecompressSync,
  gunzipSync,
  inflateSync,
} from "zlib";
import { v4 as uuidv4 } from "uuid";
import { SocksClient } from "socks";
import type { CaManager } from "./ca-manager";
import type { ProxyConfig } from "../../shared/types";

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

function headerToString(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : value || "";
}

function decodeCapturedBody(
  body: Buffer,
  contentEncoding: string | string[] | undefined,
): Buffer {
  const encodings = headerToString(contentEncoding)
    .toLowerCase()
    .split(",")
    .map((encoding) => encoding.trim())
    .filter(Boolean);

  return encodings.reduceRight((decoded, encoding) => {
    if (encoding === "br") return brotliDecompressSync(decoded);
    if (encoding === "gzip" || encoding === "x-gzip") {
      return gunzipSync(decoded);
    }
    if (encoding === "deflate") return inflateSync(decoded);
    return decoded;
  }, body);
}

function bodyToUtf8(
  body: Buffer,
  contentEncoding: string | string[] | undefined,
): string {
  try {
    return decodeCapturedBody(body, contentEncoding)
      .toString("utf-8")
      .substring(0, MAX_BODY_SIZE);
  } catch {
    return body.toString("utf-8").substring(0, MAX_BODY_SIZE);
  }
}

/**
 * MitmProxyServer — An embedded HTTP/HTTPS man-in-the-middle proxy.
 *
 * HTTP requests are forwarded directly (or via upstream proxy).
 * HTTPS CONNECT requests are intercepted via dynamic TLS certificates
 * issued by the CaManager's root CA.
 *
 * Supports upstream HTTP/HTTPS/SOCKS5 proxy for outbound connections.
 *
 * Emits 'response-captured' events with the same data shape as CdpManager,
 * so CaptureEngine can handle them identically.
 */
export class MitmProxyServer extends EventEmitter {
  private server: http.Server | null = null;
  private port: number | null = null;
  private connections = new Set<net.Socket>();
  private upstreamProxy: ProxyConfig | null = null;

  constructor(private caManager: CaManager) {
    super();
  }

  /**
   * Set upstream proxy config. Pass null or { type: "none" } to disable.
   */
  setUpstreamProxy(config: ProxyConfig | null): void {
    if (!config || config.type === "none") {
      this.upstreamProxy = null;
      console.log("[MitmProxy] Upstream proxy disabled");
    } else {
      this.upstreamProxy = config;
      console.log(`[MitmProxy] Upstream proxy set to ${config.type}://${config.host}:${config.port}`);
    }
  }

  async start(port: number): Promise<void> {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.server.on("connect", (req, clientSocket, head) => {
      this.handleConnect(req, clientSocket, head);
    });

    this.server.on("upgrade", (req, socket, head) => {
      this.handleHttpWebSocketUpgrade(req, socket as net.Socket, head);
    });

    this.server.on("connection", (socket) => {
      this.connections.add(socket);
      socket.on("close", () => this.connections.delete(socket));
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(port, "0.0.0.0", () => {
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

  // ---- Upstream proxy helpers ----

  /**
   * Establish a TCP connection to the target, optionally through the upstream proxy.
   * Returns a connected net.Socket ready for use.
   */
  private async connectToTarget(hostname: string, port: number): Promise<net.Socket> {
    const proxy = this.upstreamProxy;

    if (!proxy) {
      // Direct connection
      return new Promise((resolve, reject) => {
        const socket = net.connect(port, hostname, () => resolve(socket));
        socket.on("error", reject);
      });
    }

    if (proxy.type === "socks5") {
      return this.connectViaSocks5(hostname, port);
    }

    // HTTP/HTTPS upstream proxy — use CONNECT tunnel
    return this.connectViaHttpProxy(hostname, port);
  }

  /**
   * Establish a CONNECT tunnel through an HTTP/HTTPS upstream proxy.
   * Uses tls.connect for HTTPS proxy type, net.connect for HTTP.
   */
  private connectViaHttpProxy(hostname: string, port: number): Promise<net.Socket> {
    const proxy = this.upstreamProxy!;
    const CONNECT_TIMEOUT = 30_000;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void) => {
        if (!settled) { settled = true; fn(); }
      };

      // Use tls.connect for HTTPS proxy, net.connect for HTTP
      const connectFn = proxy.type === "https" ? tls.connect : net.connect;
      const proxySocket = connectFn(proxy.port, proxy.host, () => {
        // Build CONNECT request with optional auth
        let connectReq = `CONNECT ${hostname}:${port} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n`;
        if (proxy.username && proxy.password) {
          const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
          connectReq += `Proxy-Authorization: Basic ${auth}\r\n`;
        }
        connectReq += "\r\n";
        proxySocket.write(connectReq);

        // Wait for proxy response — accumulate raw Buffers to avoid encoding issues
        const chunks: Buffer[] = [];
        const HEADER_END = Buffer.from("\r\n\r\n");

        const onData = (chunk: Buffer) => {
          chunks.push(chunk);
          const accumulated = Buffer.concat(chunks);
          const endIdx = accumulated.indexOf(HEADER_END);
          if (endIdx === -1) return; // Header not complete yet

          proxySocket.removeListener("data", onData);

          // Parse status line from ASCII-safe header portion
          const headerStr = accumulated.subarray(0, endIdx).toString("ascii");
          const statusLine = headerStr.split("\r\n")[0];
          const statusCode = parseInt(statusLine.split(" ")[1], 10);

          if (statusCode === 200) {
            // Push back any trailing data (e.g. TLS ClientHello from server)
            const trailing = accumulated.subarray(endIdx + 4);
            if (trailing.length > 0) {
              proxySocket.unshift(trailing);
            }
            settle(() => resolve(proxySocket));
          } else {
            proxySocket.destroy();
            settle(() => reject(new Error(`Upstream proxy CONNECT failed: ${statusLine}`)));
          }
        };
        proxySocket.on("data", onData);
      });

      // Timeout protection
      const timer = setTimeout(() => {
        proxySocket.destroy();
        settle(() => reject(new Error(`Upstream proxy CONNECT timed out after ${CONNECT_TIMEOUT}ms`)));
      }, CONNECT_TIMEOUT);

      proxySocket.on("error", (err) => {
        clearTimeout(timer);
        settle(() => reject(new Error(`Upstream proxy connection failed: ${err.message}`)));
      });

      // Clear timeout on successful resolve
      const origResolve = resolve;
      resolve = ((val: net.Socket) => {
        clearTimeout(timer);
        origResolve(val);
      }) as typeof resolve;
    });
  }

  /**
   * Establish a connection through a SOCKS5 proxy.
   */
  private async connectViaSocks5(hostname: string, port: number): Promise<net.Socket> {
    const proxy = this.upstreamProxy!;
    const socksOptions: Parameters<typeof SocksClient.createConnection>[0] = {
      proxy: {
        host: proxy.host,
        port: proxy.port,
        type: 5,
        ...(proxy.username && proxy.password
          ? { userId: proxy.username, password: proxy.password }
          : {}),
      },
      command: "connect",
      destination: { host: hostname, port },
    };

    const { socket } = await SocksClient.createConnection(socksOptions);
    return socket;
  }

  // ---- HTTP (non-CONNECT) proxy ----

  /**
   * Handle plain HTTP WebSocket upgrade (ws://) from the main server.
   */
  private handleHttpWebSocketUpgrade(
    clientReq: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    const startTime = Date.now();
    const requestId = `proxy-${uuidv4()}`;
    const targetUrl = clientReq.url || "/";
    const parsed = url.parse(targetUrl);
    const hostname = parsed.hostname || "localhost";
    const port = parseInt(parsed.port || "80", 10);
    const fullUrl = targetUrl.startsWith("http") ? targetUrl : `ws://${hostname}:${port}${parsed.path || "/"}`;

    const connectToServer = (serverSocket: net.Socket): void => {
      const headers = { ...clientReq.headers, host: hostname };
      let rawReq = `${clientReq.method} ${parsed.path || "/"} HTTP/1.1\r\n`;
      for (const [key, val] of Object.entries(headers)) {
        if (val === undefined) continue;
        const values = Array.isArray(val) ? val : [val];
        for (const v of values) {
          rawReq += `${key}: ${v}\r\n`;
        }
      }
      rawReq += "\r\n";

      serverSocket.write(rawReq);
      if (head.length > 0) serverSocket.write(head);

      let responseBuf = Buffer.alloc(0);
      const onData = (chunk: Buffer): void => {
        responseBuf = Buffer.concat([responseBuf, chunk]);
        const headerEnd = responseBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        serverSocket.removeListener("data", onData);

        const responseHeader = responseBuf.subarray(0, headerEnd + 4);
        const trailing = responseBuf.subarray(headerEnd + 4);

        const firstLine = responseHeader.toString("utf-8").split("\r\n")[0];
        const statusCode = parseInt(firstLine.split(" ")[1], 10) || 101;

        clientSocket.write(responseHeader);
        if (trailing.length > 0) clientSocket.write(trailing);

        serverSocket.pipe(clientSocket);
        clientSocket.pipe(serverSocket);

        serverSocket.on("error", () => clientSocket.destroy());
        clientSocket.on("error", () => serverSocket.destroy());
        serverSocket.on("close", () => clientSocket.destroy());
        clientSocket.on("close", () => serverSocket.destroy());

        this.emit("response-captured", {
          requestId,
          method: clientReq.method || "GET",
          url: fullUrl,
          requestHeaders: JSON.stringify(clientReq.headers || {}),
          requestBody: null,
          statusCode,
          responseHeaders: JSON.stringify(this.parseRawHeaders(responseHeader.toString("utf-8"))),
          responseBody: null,
          contentType: null,
          initiator: null,
          durationMs: Date.now() - startTime,
          isOptions: false,
          isStatic: false,
          isStreaming: false,
          isWebSocket: true,
          truncated: false,
          timestamp: startTime,
        });
      };

      serverSocket.on("data", onData);
    };

    if (this.upstreamProxy) {
      this.connectToTarget(hostname, port)
        .then(connectToServer)
        .catch((err) => {
          console.warn("[MitmProxy] WS upstream proxy error:", err.message);
          clientSocket.destroy();
        });
    } else {
      const serverSocket = net.connect(port, hostname, () => {
        connectToServer(serverSocket);
      });
      serverSocket.on("error", (err) => {
        console.warn(`[MitmProxy] WS connect error for ${hostname}:`, err.message);
        clientSocket.destroy();
      });
    }
  }

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
    let reqBodySize = 0;

    clientReq.on("data", (chunk: Buffer) => {
      if (reqBodySize < MAX_BODY_SIZE) {
        reqBodyChunks.push(chunk);
      }
      reqBodySize += chunk.length;
    });

    clientReq.on("end", () => {
      const reqBody = Buffer.concat(reqBodyChunks);
      const headers = { ...clientReq.headers };

      // Remove proxy-specific headers
      delete headers["proxy-connection"];

      const proxy = this.upstreamProxy;

      let options: http.RequestOptions;
      if (proxy && proxy.type !== "none" && proxy.type !== "socks5") {
        // HTTP/HTTPS upstream proxy: send full URL to proxy
        options = {
          hostname: proxy.host,
          port: proxy.port,
          path: targetUrl, // Full URL as path when going through HTTP proxy
          method: clientReq.method,
          headers,
        };
        // Add proxy auth if configured
        if (proxy.username && proxy.password) {
          const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString("base64");
          options.headers!["proxy-authorization"] = `Basic ${auth}`;
        }
      } else if (proxy && proxy.type === "socks5") {
        // SOCKS5: connect to target through SOCKS, then send normal request
        this.handleHttpViaSocks5(requestId, startTime, clientReq, clientRes, reqBody, targetUrl, parsed, headers);
        return;
      } else {
        // Direct connection
        options = {
          hostname: parsed.hostname,
          port: parsed.port || 80,
          path: parsed.path,
          method: clientReq.method,
          headers,
        };
      }

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

  /**
   * Handle HTTP request through SOCKS5 proxy — needs a custom socket.
   */
  private async handleHttpViaSocks5(
    requestId: string,
    startTime: number,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    reqBody: Buffer,
    targetUrl: string,
    parsed: url.UrlWithStringQuery,
    headers: http.IncomingHttpHeaders,
  ): Promise<void> {
    try {
      const socket = await this.connectViaSocks5(
        parsed.hostname || "localhost",
        parseInt(parsed.port || "80", 10),
      );

      const options: http.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.path,
        method: clientReq.method,
        headers,
        createConnection: () => socket,
      };

      const proxyReq = http.request(options, (proxyRes) => {
        this.relayResponse(requestId, startTime, clientReq, reqBody, targetUrl, proxyRes, clientRes);
      });

      proxyReq.on("error", (err) => {
        console.warn("[MitmProxy] HTTP SOCKS5 proxy error:", err.message);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502);
          clientRes.end("Bad Gateway");
        }
      });

      if (reqBody.length > 0) proxyReq.write(reqBody);
      proxyReq.end();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[MitmProxy] SOCKS5 connection error:", message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502);
        clientRes.end("Bad Gateway");
      }
    }
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

    // Handle WebSocket upgrade requests inside the TLS tunnel
    miniServer.on("upgrade", (upgradeReq, upgradeSocket, upgradeHead) => {
      this.handleWebSocketUpgrade(hostname, port, upgradeReq, upgradeSocket as net.Socket, upgradeHead);
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
   * When upstream proxy is configured, establishes a tunnel first.
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
    let reqBodySize = 0;

    clientReq.on("data", (chunk: Buffer) => {
      if (reqBodySize < MAX_BODY_SIZE) {
        reqBodyChunks.push(chunk);
      }
      reqBodySize += chunk.length;
    });

    clientReq.on("end", () => {
      const reqBody = Buffer.concat(reqBodyChunks);

      if (this.upstreamProxy) {
        // Route through upstream proxy
        this.handleDecryptedViaProxy(
          requestId, startTime, hostname, port, clientReq, clientRes, reqBody, fullUrl,
        );
      } else {
        // Direct connection
        this.handleDecryptedDirect(
          requestId, startTime, hostname, port, clientReq, clientRes, reqBody, fullUrl,
        );
      }
    });
  }

  /**
   * Handle a WebSocket upgrade request received inside a decrypted TLS tunnel.
   * Forwards the upgrade to the real server and pipes bidirectional frames.
   */
  private handleWebSocketUpgrade(
    hostname: string,
    port: number,
    clientReq: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    const startTime = Date.now();
    const requestId = `proxy-${uuidv4()}`;
    const fullUrl = `wss://${hostname}${port !== 443 ? ":" + port : ""}${clientReq.url || "/"}`;

    const connectAndUpgrade = (targetSocket: net.Socket): void => {
      // Perform TLS handshake with the real server
      const tlsConnection = tls.connect(
        {
          host: hostname,
          port,
          socket: targetSocket,
          rejectUnauthorized: false,
          servername: hostname,
        },
        () => {
          // Build the upgrade request to send to the real server
          const headers = { ...clientReq.headers, host: hostname };
          let rawReq = `${clientReq.method} ${clientReq.url} HTTP/1.1\r\n`;
          for (const [key, val] of Object.entries(headers)) {
            if (val === undefined) continue;
            const values = Array.isArray(val) ? val : [val];
            for (const v of values) {
              rawReq += `${key}: ${v}\r\n`;
            }
          }
          rawReq += "\r\n";

          tlsConnection.write(rawReq);
          if (head.length > 0) tlsConnection.write(head);

          // Wait for the server's upgrade response
          let responseBuf = Buffer.alloc(0);
          const onData = (chunk: Buffer): void => {
            responseBuf = Buffer.concat([responseBuf, chunk]);
            const headerEnd = responseBuf.indexOf("\r\n\r\n");
            if (headerEnd === -1) return;

            tlsConnection.removeListener("data", onData);

            const responseHeader = responseBuf.subarray(0, headerEnd + 4);
            const trailing = responseBuf.subarray(headerEnd + 4);

            // Parse status code from first line
            const firstLine = responseHeader.toString("utf-8").split("\r\n")[0];
            const statusCode = parseInt(firstLine.split(" ")[1], 10) || 101;

            // Forward the server response header to the client
            clientSocket.write(responseHeader);
            if (trailing.length > 0) clientSocket.write(trailing);

            // Pipe bidirectional WebSocket frames
            tlsConnection.pipe(clientSocket);
            clientSocket.pipe(tlsConnection);

            tlsConnection.on("error", () => clientSocket.destroy());
            clientSocket.on("error", () => tlsConnection.destroy());
            tlsConnection.on("close", () => clientSocket.destroy());
            clientSocket.on("close", () => tlsConnection.destroy());

            // Emit capture event for the WebSocket upgrade request
            this.emit("response-captured", {
              requestId,
              method: clientReq.method || "GET",
              url: fullUrl,
              requestHeaders: JSON.stringify(clientReq.headers || {}),
              requestBody: null,
              statusCode,
              responseHeaders: JSON.stringify(this.parseRawHeaders(responseHeader.toString("utf-8"))),
              responseBody: null,
              contentType: null,
              initiator: null,
              durationMs: Date.now() - startTime,
              isOptions: false,
              isStatic: false,
              isStreaming: false,
              isWebSocket: true,
              truncated: false,
              timestamp: startTime,
            });
          };

          tlsConnection.on("data", onData);
        },
      );

      tlsConnection.on("error", (err) => {
        console.warn(`[MitmProxy] WebSocket upstream TLS error for ${hostname}:`, err.message);
        clientSocket.destroy();
      });
    };

    if (this.upstreamProxy) {
      this.connectToTarget(hostname, port)
        .then(connectAndUpgrade)
        .catch((err) => {
          console.warn("[MitmProxy] WebSocket upstream proxy error:", err.message);
          clientSocket.destroy();
        });
    } else {
      const targetSocket = net.connect(port, hostname, () => {
        connectAndUpgrade(targetSocket);
      });
      targetSocket.on("error", (err) => {
        console.warn(`[MitmProxy] WebSocket connect error for ${hostname}:`, err.message);
        clientSocket.destroy();
      });
    }
  }

  /**
   * Parse raw HTTP response headers into a key-value object.
   */
  private parseRawHeaders(raw: string): Record<string, string> {
    const headers: Record<string, string> = {};
    const lines = raw.split("\r\n").slice(1); // skip status line
    for (const line of lines) {
      if (!line) break;
      const colonIdx = line.indexOf(":");
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim().toLowerCase();
        const value = line.substring(colonIdx + 1).trim();
        headers[key] = value;
      }
    }
    return headers;
  }

  /**
   * Direct HTTPS request to the target (no upstream proxy).
   */
  private handleDecryptedDirect(
    requestId: string,
    startTime: number,
    hostname: string,
    port: number,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    reqBody: Buffer,
    fullUrl: string,
  ): void {
    const options: https.RequestOptions = {
      hostname,
      port,
      path: clientReq.url,
      method: clientReq.method,
      headers: { ...clientReq.headers, host: hostname },
      rejectUnauthorized: false, // We are the MITM — upstream cert check is lax
    };

    const proxyReq = https.request(options, (proxyRes) => {
      this.relayResponse(requestId, startTime, clientReq, reqBody, fullUrl, proxyRes, clientRes);
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
  }

  /**
   * HTTPS request routed through the upstream proxy (HTTP/HTTPS/SOCKS5).
   * Establishes a tunnel to the target, then performs TLS + HTTP on top.
   */
  private async handleDecryptedViaProxy(
    requestId: string,
    startTime: number,
    hostname: string,
    port: number,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse,
    reqBody: Buffer,
    fullUrl: string,
  ): Promise<void> {
    try {
      const tunnelSocket = await this.connectToTarget(hostname, port);

      const options: https.RequestOptions = {
        hostname,
        port,
        path: clientReq.url,
        method: clientReq.method,
        headers: { ...clientReq.headers, host: hostname },
        rejectUnauthorized: false,
        socket: tunnelSocket, // Use the pre-established tunnel
      };

      const proxyReq = https.request(options, (proxyRes) => {
        this.relayResponse(requestId, startTime, clientReq, reqBody, fullUrl, proxyRes, clientRes);
      });

      proxyReq.on("error", (err) => {
        console.warn("[MitmProxy] HTTPS upstream proxy error:", err.message);
        tunnelSocket.destroy();
        if (!clientRes.headersSent) {
          clientRes.writeHead(502);
          clientRes.end("Bad Gateway");
        }
      });

      if (reqBody.length > 0) proxyReq.write(reqBody);
      proxyReq.end();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn("[MitmProxy] Upstream tunnel error:", message);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502);
        clientRes.end("Bad Gateway");
      }
    }
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
      const isWebSocket = false; // Regular HTTP/HTTPS — WS upgrade is handled separately
      const isOptions = method === "OPTIONS";
      const isStatic = STATIC_EXTENSIONS.test(fullUrl);

      const requestHeaders = JSON.stringify(clientReq.headers || {});
      const responseHeaders = JSON.stringify(proxyRes.headers || {});

      const requestBody =
        reqBody.length > 0 && !isBinary
          ? bodyToUtf8(reqBody, clientReq.headers["content-encoding"])
          : null;

      const responseBody =
        resBody.length > 0 && !isBinary
          ? bodyToUtf8(resBody, proxyRes.headers["content-encoding"])
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
   * Routes through upstream proxy when configured.
   */
  private tunnelDirect(
    hostname: string,
    port: number,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    if (this.upstreamProxy) {
      // Tunnel through upstream proxy
      this.connectToTarget(hostname, port)
        .then((serverSocket) => {
          clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (head.length > 0) serverSocket.write(head);
          serverSocket.pipe(clientSocket);
          clientSocket.pipe(serverSocket);
          serverSocket.on("error", () => clientSocket.destroy());
          clientSocket.on("error", () => serverSocket.destroy());
        })
        .catch((err) => {
          console.warn("[MitmProxy] Tunnel via upstream proxy error:", err.message);
          clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        });
    } else {
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
}
