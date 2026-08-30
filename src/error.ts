import type { ModuleScope } from "./plugin.js";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  readResponseText,
} from "./response.js";

/** Construction data retained by {@link ModuleClientError}. */
export interface ModuleClientErrorOptions {
  readonly status: number;
  readonly code?: string;
  readonly message: string;
  readonly details?: unknown;
  readonly body: unknown;
  readonly requestId?: string;
  readonly moduleRef: string;
  readonly scope: ModuleScope;
  readonly path: string;
}

/** A non-successful HTTP response returned by a MirrorStack module. */
export class ModuleClientError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  readonly details: unknown;
  readonly body: unknown;
  readonly requestId: string | undefined;
  readonly moduleRef: string;
  readonly scope: ModuleScope;
  readonly path: string;

  constructor(options: ModuleClientErrorOptions) {
    super(options.message);
    this.name = "ModuleClientError";
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
    this.body = options.body;
    this.requestId = options.requestId;
    this.moduleRef = options.moduleRef;
    this.scope = options.scope;
    this.path = options.path;
  }
}

interface ParsedErrorEnvelope {
  readonly code?: string;
  readonly message?: string;
  readonly details?: unknown;
  readonly requestId?: string;
}

function stringProperty(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const property = (value as Record<string, unknown>)[key];
  return typeof property === "string" ? property : undefined;
}

function parseEnvelope(body: unknown): ParsedErrorEnvelope {
  if (body === null || typeof body !== "object") return {};
  const record = body as Record<string, unknown>;
  const error = record.error;
  const requestId =
    stringProperty(record, "request_id") ?? stringProperty(record, "requestId");

  if (typeof error === "string") {
    return {
      code: error,
      message: stringProperty(record, "message"),
      details: record.details,
      requestId,
    };
  }
  if (error !== null && typeof error === "object") {
    return {
      code: stringProperty(error, "code"),
      message: stringProperty(error, "message"),
      details: (error as Record<string, unknown>).details,
      requestId,
    };
  }
  return { requestId };
}

async function readBody(response: Response, maxResponseBytes: number): Promise<unknown> {
  const text = await readResponseText(response, maxResponseBytes);
  if (text === "") return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** @internal */
export async function errorCodeFromResponse(
  response: Response,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<string | undefined> {
  try {
    return parseEnvelope(await readBody(response, maxResponseBytes)).code;
  } catch {
    return undefined;
  }
}

/** @internal */
export async function moduleClientErrorFromResponse(
  response: Response,
  context: Pick<ModuleClientErrorOptions, "moduleRef" | "scope" | "path">,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<ModuleClientError> {
  let body: unknown = null;
  try {
    body = await readBody(response, maxResponseBytes);
  } catch {
    // A broken error body must not hide the useful HTTP context.
  }
  const envelope = parseEnvelope(body);
  const requestId =
    response.headers.get("x-request-id") ??
    response.headers.get("x-ms-request-id") ??
    envelope.requestId;
  const message =
    envelope.message ??
    `Module request failed with status ${response.status}${
      envelope.code === undefined ? "" : ` (${envelope.code})`
    }`;

  return new ModuleClientError({
    ...context,
    status: response.status,
    code: envelope.code,
    message,
    details: envelope.details,
    body,
    ...(requestId === null || requestId === undefined ? {} : { requestId }),
  });
}
