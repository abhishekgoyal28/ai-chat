import { Injectable } from '@nestjs/common';
import { config } from '../../shared/config/config';
import { UnauthorizedError } from '../../shared/errors/app-errors';
import { describeError, getLogger } from '../../shared/logger/logger';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';
const REQUEST_TIMEOUT_MS = 10_000;

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
}

interface UserInfoResponse {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/** Google's OAuth 2.0 authorization-code flow, wrapped so the rest of the app never calls Google directly. */
@Injectable()
export class GoogleOAuthClient {
  private readonly log = getLogger(GoogleOAuthClient.name);

  isConfigured(): boolean {
    return Boolean(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET);
  }

  authorizationUrl(state: string, redirectUri: string): string {
    const params = new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID ?? '',
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      prompt: 'select_account',
      state,
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async fetchProfile(code: string, redirectUri: string): Promise<GoogleProfile> {
    const accessToken = await this.exchangeCode(code, redirectUri);
    const info = await this.requestJson<UserInfoResponse>('userinfo', USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` } });
    if (!info.sub || !info.email) {
      throw new UnauthorizedError('Google did not return an email address');
    }
    return { sub: info.sub, email: info.email, emailVerified: info.email_verified === true, name: info.name?.trim() || null };
  }

  private async exchangeCode(code: string, redirectUri: string): Promise<string> {
    const body = new URLSearchParams({
      code,
      client_id: config.GOOGLE_CLIENT_ID ?? '',
      client_secret: config.GOOGLE_CLIENT_SECRET ?? '',
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const token = await this.requestJson<{ access_token?: string }>('token exchange', TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!token.access_token) {
      throw new UnauthorizedError('Google sign-in failed — please try again');
    }
    return token.access_token;
  }

  private async requestJson<T>(step: string, url: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      this.log.error({ step, error: describeError(error) }, 'Google OAuth request failed');
      throw new UnauthorizedError('could not reach Google — please try again');
    }
    if (!response.ok) {
      this.log.warn({ step, status: response.status }, 'Google OAuth request rejected');
      throw new UnauthorizedError('Google sign-in failed — please try again');
    }
    return (await response.json()) as T;
  }
}
