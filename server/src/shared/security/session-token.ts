import { config } from '../config/config';
import { deriveKey } from './crypto';
import { signToken, TokenClaims, verifyToken } from './signed-token';

/**
 * The token a client uses for the client API and the WebSocket. Minted by
 * chat-app when the host backend creates or resumes a session, scoped to ONE
 * conversation: whatever a client sends, it can only read or write the
 * conversation its token names.
 *
 * The per-turn caps ride in the token so chat-socket — which has no database —
 * can enforce the agent's real limits instead of global defaults.
 */
export const SESSION_TOKEN_TYPE = 'aic.session';

export interface SessionTokenClaims extends TokenClaims {
  /** Conversation id. */
  cid: string;
  /** External user id, as the host knows the user. */
  sub: string;
  /** Agent id. */
  aid: string;
  /** maxMessagesPerTurn and maxBodyChars from the agent's client settings. */
  mpt: number;
  mbc: number;
}

export interface SessionTokenInput {
  conversationId: string;
  externalUserId: string;
  agentId: string;
  maxMessagesPerTurn: number;
  maxBodyChars: number;
}

const sessionKey = (): Buffer => deriveKey(config.AUTH_SECRET ?? '', 'session-token');

export const signSessionToken = (input: SessionTokenInput, ttlSeconds = config.SESSION_TOKEN_TTL_SEC): string =>
  signToken(
    {
      typ: SESSION_TOKEN_TYPE,
      cid: input.conversationId,
      sub: input.externalUserId,
      aid: input.agentId,
      mpt: input.maxMessagesPerTurn,
      mbc: input.maxBodyChars,
    },
    sessionKey(),
    ttlSeconds,
  );

export const verifySessionToken = (token: string): SessionTokenClaims | null =>
  verifyToken<SessionTokenClaims>(token, sessionKey(), SESSION_TOKEN_TYPE);

/** Bearer header first, then the socket.io `auth.token` handshake field, then `?token=`. */
export const extractBearerToken = (authorization: string | undefined): string | null => {
  if (typeof authorization === 'string' && authorization.startsWith('Bearer ')) {
    const token = authorization.slice('Bearer '.length).trim();
    return token.length > 0 ? token : null;
  }
  return null;
};
