/**
 * Server-side helpers for a custom web app: the platform member-session
 * control plane (exchange a provider handoff for a credential, revoke it).
 *
 * @packageDocumentation
 */

export {
  memberSessions,
  MemberSessionError,
  type MemberIdentity,
  type MemberSession,
  type MemberSessionsApi,
  type MemberSessionsOptions,
  type RevokeOutcome,
} from "./member-sessions.js";
