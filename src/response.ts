/** Default maximum body size parsed by module transports (one mebibyte). */
export const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;

/** Raised when a successful parsed response exceeds its configured body limit. */
export class ModuleResponseTooLargeError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`Module response body exceeds the ${limitBytes} byte limit`);
    this.name = "ModuleResponseTooLargeError";
    this.limitBytes = limitBytes;
  }
}

/** @internal */
export function resolveMaxResponseBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("maxResponseBytes must be a positive safe integer");
  }
  return value;
}

function cancelStream(
  stream: ReadableStream<Uint8Array>,
  reason?: unknown,
): void {
  try {
    // A cloned response is one branch of a tee. Awaiting its cancellation can
    // wait for the other branch, so cancellation is deliberately best-effort.
    void stream.cancel(reason).catch(() => undefined);
  } catch {
    // Preserve the response-size or caller-visible lifecycle result.
  }
}

/** @internal */
export function cancelResponseBody(response: Response, reason?: unknown): void {
  if (response.body !== null) cancelStream(response.body, reason);
}

/** @internal */
export async function readResponseText(
  response: Response,
  maxResponseBytes: number,
): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const declaredBytes = Number(declaredLength);
    if (
      Number.isSafeInteger(declaredBytes)
      && declaredBytes >= 0
      && declaredBytes > maxResponseBytes
    ) {
      const error = new ModuleResponseTooLargeError(maxResponseBytes);
      cancelResponseBody(response, error);
      throw error;
    }
  }

  if (response.body === null) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let receivedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      receivedBytes += value.byteLength;
      if (receivedBytes > maxResponseBytes) {
        const error = new ModuleResponseTooLargeError(maxResponseBytes);
        try {
          void reader.cancel(error).catch(() => undefined);
        } catch {
          // Preserve the deterministic response-size error.
        }
        throw error;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    return parts.join("");
  } finally {
    reader.releaseLock();
  }
}
