import { assertAppSlug } from "../base-url.js";
import { normalizeBaseUrl } from "../transport.js";

/**
 * App-scoped platform member sessions — the control plane a custom web app
 * uses to turn an auth provider's one-time handoff into a credential it can
 * present on every module call, and to revoke it again.
 *
 * These routes are dispatch's, not a module's: `POST /dispatch/apps/<app>/member-sessions`
 * and `DELETE …/current`. Dispatch resolves the app's auth-provider slot,
 * redeems the code with that provider itself, and issues its own `mss1_`
 * credential, which every installed module then accepts as
 * `Authorization: Bearer …`. That is why this lives beside `platformBaseUrl`
 * and not in any module's client: the exchange is identical for every
 * provider that can fill the slot, and a module plugin only has module-scoped
 * transports.
 */

/** Inputs for {@link memberSessions}. */
export interface MemberSessionsOptions {
  /** Absolute HTTP(S) platform API URL, typically `MIRRORSTACK_API_URL`. */
  readonly apiUrl: string;
  /** The custom application's slug, typically `MIRRORSTACK_APP_SLUG`. */
  readonly appSlug: string;
  /** Fetch implementation, for SSR and tests. Defaults to `globalThis.fetch`. */
  readonly fetch?: typeof globalThis.fetch;
}

/** The identity the platform returns with a freshly issued member session. */
export interface MemberIdentity {
  readonly id: string;
  readonly email: string | null;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly createdAt: string;
  readonly lastSignInAt: string;
}

/** A member session as issued by the platform. */
export interface MemberSession {
  /** The `mss1_` credential to present as a bearer on module calls. Server-side only. */
  readonly credential: string;
  readonly identity: MemberIdentity;
  /** RFC 3339 expiry of the credential. */
  readonly expiresAt: string;
}

/**
 * The outcome of a revoke. `revoked` and `alreadyInvalid` are both a finished
 * sign-out; `unavailable` means the platform could not say, so the credential
 * may still be live and a caller must not hide that behind a cleared cookie.
 */
export type RevokeOutcome = "revoked" | "alreadyInvalid" | "unavailable";

/** A non-successful response from the member-session control plane. */
export class MemberSessionError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "MemberSessionError";
    this.status = status;
    this.code = code;
  }
}

/** The member-sessions API a custom app talks to. */
export interface MemberSessionsApi {
  /** A fresh one-time handoff state: 32 lowercase hex characters, inside the provider's 16–256 byte window. */
  newState(): string;
  /** Redeem a one-time handoff code for a member session. `state` must be the one this app issued for the sign-in. */
  exchange(code: string, state: string): Promise<MemberSession>;
  /** Revoke the current member session on the platform. Never throws; see {@link RevokeOutcome}. */
  revoke(credential: string): Promise<RevokeOutcome>;
  /** The control-plane URL this instance talks to, for assertions and logs. */
  readonly url: string;
}

const HANDOFF_STATE_BYTES = 16;
const ENVELOPE_VERSION = 1;
const MAX_ERROR_BODY_BYTES = 4096;

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function nullableStringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function errorCodeOf(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const error = (body as Record<string, unknown>).error;
  if (error === null || typeof error !== "object") return undefined;
  return stringField(error as Record<string, unknown>, "code");
}

async function boundedText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > MAX_ERROR_BODY_BYTES ? text.slice(0, MAX_ERROR_BODY_BYTES) : text;
  } catch {
    return "";
  }
}

function parseMemberSession(body: unknown): MemberSession {
  if (body === null || typeof body !== "object") {
    throw new MemberSessionError(502, "invalid_member_session_response", "member session response is not an object");
  }
  const record = body as Record<string, unknown>;
  const credential = stringField(record, "credential");
  const expiresAt = stringField(record, "expiresAt");
  const identity = record.identity;
  if (
    credential === undefined || credential.length === 0 ||
    expiresAt === undefined ||
    identity === null || typeof identity !== "object"
  ) {
    throw new MemberSessionError(502, "invalid_member_session_response", "member session response is missing credential, identity, or expiresAt");
  }
  const id = stringField(identity as Record<string, unknown>, "id");
  if (id === undefined || id.length === 0) {
    throw new MemberSessionError(502, "invalid_member_session_response", "member session identity has no id");
  }
  const identityRecord = identity as Record<string, unknown>;
  return {
    credential,
    expiresAt,
    identity: {
      id,
      email: nullableStringField(identityRecord, "email"),
      displayName: nullableStringField(identityRecord, "display_name"),
      avatarUrl: nullableStringField(identityRecord, "avatar_url"),
      createdAt: stringField(identityRecord, "created_at") ?? "",
      lastSignInAt: stringField(identityRecord, "last_sign_in_at") ?? "",
    },
  };
}

/**
 * Creates the member-sessions API for one custom application.
 *
 * ```ts
 * const sessions = memberSessions({
 *   apiUrl: process.env.MIRRORSTACK_API_URL!,
 *   appSlug: process.env.MIRRORSTACK_APP_SLUG!,
 * });
 * const state = sessions.newState();           // stored in an HttpOnly cookie, sent on startUrl
 * const session = await sessions.exchange(code, state);
 * await sessions.revoke(session.credential);
 * ```
 *
 * Both inputs are validated up front, like {@link platformBaseUrl}, so a
 * misconfigured environment fails at startup rather than on the first sign-in.
 */
export function memberSessions(options: MemberSessionsOptions): MemberSessionsApi {
  if (options === null || typeof options !== "object") {
    throw new TypeError("memberSessions options must be an object");
  }
  const { apiUrl, appSlug } = options;
  if (typeof apiUrl !== "string" || !/^https?:\/\//u.test(apiUrl)) {
    throw new TypeError("apiUrl must be an absolute HTTP(S) URL");
  }
  const parsed = new URL(apiUrl);
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new TypeError("apiUrl must not carry credentials, a query, or a fragment");
  }
  assertAppSlug(appSlug);
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new TypeError("a fetch implementation is required");
  }
  const url = `${normalizeBaseUrl(apiUrl)}/dispatch/apps/${encodeURIComponent(appSlug)}/member-sessions`;

  return {
    url,
    newState() {
      const bytes = new Uint8Array(HANDOFF_STATE_BYTES);
      globalThis.crypto.getRandomValues(bytes);
      return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    },
    async exchange(code, state) {
      if (typeof code !== "string" || code.length === 0) {
        throw new TypeError("a handoff code is required");
      }
      if (typeof state !== "string" || state.length === 0) {
        throw new TypeError("the issued handoff state is required");
      }
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ v: ENVELOPE_VERSION, code, state }),
        cache: "no-store",
      });
      if (!response.ok) {
        const text = await boundedText(response);
        let body: unknown;
        try { body = JSON.parse(text); } catch { body = undefined; }
        throw new MemberSessionError(
          response.status,
          errorCodeOf(body),
          `member session exchange failed (${response.status})`,
        );
      }
      return parseMemberSession(await response.json());
    },
    async revoke(credential) {
      if (typeof credential !== "string" || credential.length === 0) {
        throw new TypeError("a member session credential is required");
      }
      try {
        const response = await fetchImpl(`${url}/current`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${credential}` },
          cache: "no-store",
        });
        if (response.status === 204) return "revoked";
        if (response.status === 401) return "alreadyInvalid";
        return "unavailable";
      } catch {
        return "unavailable";
      }
    },
  };
}
