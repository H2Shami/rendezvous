import {
  CognitoIdentityProviderClient, InitiateAuthCommand, SignUpCommand,
  ConfirmSignUpCommand, ResendConfirmationCodeCommand, ForgotPasswordCommand,
  ConfirmForgotPasswordCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { HttpError } from '../validation.js';

export interface EmailIdentity { issuer: string; subject: string }
export interface EmailAuth {
  login(email: string, password: string): Promise<EmailIdentity>;
  signup(email: string, password: string): Promise<void>;
  confirm(email: string, code: string): Promise<void>;
  resend(email: string): Promise<void>;
  forgot(email: string): Promise<void>;
  reset(email: string, code: string, password: string): Promise<void>;
}
function authError(error: unknown): never {
  const name = error instanceof Error ? error.name : '';
  const errors: Record<string, [string, string, number]> = {
    UserNotConfirmedException: ['CONFIRMATION_REQUIRED', 'Verify your email to finish signing up.', 409],
    NotAuthorizedException: ['LOGIN_FAILED', 'Email or password is incorrect.', 401],
    UserNotFoundException: ['LOGIN_FAILED', 'Email or password is incorrect.', 401],
    UsernameExistsException: ['ACCOUNT_EXISTS', 'An account already exists. Sign in or finish email verification.', 409],
    CodeMismatchException: ['INVALID_CODE', 'That code is incorrect. Check the email and try again.', 400],
    ExpiredCodeException: ['EXPIRED_CODE', 'That code expired. Request a new code.', 400],
    InvalidPasswordException: ['INVALID_PASSWORD', 'Use at least 12 characters with uppercase, lowercase, a number, and a symbol.', 400],
    PasswordResetRequiredException: ['RESET_REQUIRED', 'Reset your password to continue.', 409],
    TooManyRequestsException: ['RATE_LIMITED', 'Too many attempts. Please wait before trying again.', 429],
    LimitExceededException: ['RATE_LIMITED', 'Too many attempts. Please wait before trying again.', 429],
  };
  const [code, message, status] = errors[name] || ['AUTH_UNAVAILABLE', 'Unable to complete this step. Please try again.', 503];
  throw new HttpError(code, message, status);
}
export class CognitoEmailAuth implements EmailAuth {
  private client: CognitoIdentityProviderClient;
  private keys: JWTVerifyGetKey;
  constructor(private issuer: string, private clientId: string, dependencies?: { client: CognitoIdentityProviderClient; keys: JWTVerifyGetKey }) {
    const match = /^https:\/\/cognito-idp\.([a-z0-9-]+)\.amazonaws\.com\/[a-zA-Z0-9_-]+$/.exec(issuer);
    if (!match) throw new Error('Email sign-in requires a Cognito user pool issuer.');
    this.client = dependencies?.client ?? new CognitoIdentityProviderClient({ region: match[1], maxAttempts: 1, requestHandler: { requestTimeout: 10_000, connectionTimeout: 3_000 } });
    this.keys = dependencies?.keys ?? createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  }
  async login(email: string, password: string) {
    try {
      const result = await this.client.send(new InitiateAuthCommand({ ClientId: this.clientId,
        AuthFlow: 'USER_PASSWORD_AUTH', AuthParameters: { USERNAME: email, PASSWORD: password } }));
      if (!result.AuthenticationResult?.IdToken) throw new Error('Unsupported authentication challenge');
      const { payload } = await jwtVerify(result.AuthenticationResult.IdToken, this.keys, {
        issuer: this.issuer, audience: this.clientId, algorithms: ['RS256'],
      });
      if (payload.token_use !== 'id' || !payload.sub) throw new Error('Invalid identity token');
      return { issuer: this.issuer, subject: payload.sub };
    } catch (error) { return authError(error); }
  }
  async signup(email: string, password: string) {
    try { await this.client.send(new SignUpCommand({ ClientId: this.clientId, Username: email, Password: password,
      UserAttributes: [{ Name: 'email', Value: email }] })); } catch (error) { authError(error); }
  }
  async confirm(email: string, code: string) {
    try { await this.client.send(new ConfirmSignUpCommand({ ClientId: this.clientId, Username: email, ConfirmationCode: code })); }
    catch (error) { authError(error); }
  }
  async resend(email: string) {
    try { await this.client.send(new ResendConfirmationCodeCommand({ ClientId: this.clientId, Username: email })); }
    catch (error) {
      if (error instanceof Error && ['UserNotFoundException', 'InvalidParameterException', 'NotAuthorizedException'].includes(error.name)) return;
      authError(error);
    }
  }
  async forgot(email: string) {
    try { await this.client.send(new ForgotPasswordCommand({ ClientId: this.clientId, Username: email })); }
    catch (error) {
      if (error instanceof Error && ['UserNotFoundException', 'InvalidParameterException', 'NotAuthorizedException'].includes(error.name)) return;
      authError(error);
    }
  }
  async reset(email: string, code: string, password: string) {
    try { await this.client.send(new ConfirmForgotPasswordCommand({ ClientId: this.clientId, Username: email, ConfirmationCode: code, Password: password })); }
    catch (error) { authError(error); }
  }
}
