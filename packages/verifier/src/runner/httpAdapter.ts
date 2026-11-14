// Node.js `HttpPort` adapter (task 2.15). It sends only to the origin it was built with, after the address check, honors the time
// limit and the `AbortSignal`, and uses `node:http` only (no new dependency). It follows no redirect, keeps no connection alive, and
// exposes no file-write, process, Docker, or Git operation.
import { request } from "node:http";
import { resolveRequestTarget } from "./address.js";
import { AddressNotAllowedError, HttpAbortedError, HttpTimeoutError, HttpTransportError, type HttpPort, type HttpRequest, type HttpResponse } from "./types.js";

export interface HttpAdapterConfig {
  /** The origin accepted by `checkTestApiAddress`. */
  readonly origin: string;
  /** Responses larger than this are a transport error (default 1 MiB). */
  readonly maxResponseBytes?: number;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;

export function createHttpPort(config: HttpAdapterConfig): HttpPort {
  const max = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  return {
    send(req: HttpRequest, timeoutMs: number, signal: AbortSignal): Promise<HttpResponse> {
      return new Promise<HttpResponse>((resolve, reject) => {
        const target = resolveRequestTarget(config.origin, req.path);
        if (!target.ok) return reject(new AddressNotAllowedError());
        if (signal.aborted) return reject(new HttpAbortedError());
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return reject(new HttpTimeoutError());

        let settled = false;
        let timer: NodeJS.Timeout | undefined;
        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          fn();
        };
        const headers: Record<string, string> = { ...(req.headers ?? {}), connection: "close" };
        if (req.body !== undefined) headers["content-length"] = String(Buffer.byteLength(req.body, "utf8"));
        const clientRequest = request(
          { protocol: target.value.protocol, hostname: target.value.hostname, port: target.value.port, path: target.value.pathname, method: req.method, headers, agent: false },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > max) {
                finish(() => reject(new HttpTransportError("response too large")));
                clientRequest.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => finish(() => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") })));
            res.on("error", () => finish(() => reject(new HttpTransportError())));
          },
        );
        const onAbort = (): void => {
          finish(() => reject(new HttpAbortedError()));
          clientRequest.destroy();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          finish(() => reject(new HttpTimeoutError()));
          clientRequest.destroy();
        }, timeoutMs);
        clientRequest.on("error", () => finish(() => reject(new HttpTransportError())));
        if (req.body !== undefined) clientRequest.write(req.body);
        clientRequest.end();
      });
    },
  };
}