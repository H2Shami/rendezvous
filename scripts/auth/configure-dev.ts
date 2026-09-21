/** Run with AWS_PROFILE=rendezvous node --env-file=.env --import tsx scripts/auth/configure-dev.ts.
 * Secrets travel directly to Cognito; no provider response or credentials are logged. */
import { CognitoIdentityProviderClient, DescribeUserPoolClientCommand, UpdateUserPoolClientCommand,
  ListIdentityProvidersCommand, CreateIdentityProviderCommand, UpdateIdentityProviderCommand } from '@aws-sdk/client-cognito-identity-provider';
const env = process.env;
const issuer = new URL(env.OWNER_OIDC_ISSUER!);
const pool = issuer.pathname.slice(1);
const client = new CognitoIdentityProviderClient({ region: pool.split('_')[0], maxAttempts: 2 });
try {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.OWNER_OIDC_CLIENT_ID) throw new Error('Missing auth settings');
  const providers = await client.send(new ListIdentityProvidersCommand({ UserPoolId: pool, MaxResults: 60 }));
  const input = { UserPoolId: pool, ProviderName: 'Google',
    ProviderDetails: { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, authorize_scopes: 'openid email profile' },
    AttributeMapping: { email: 'email', username: 'sub' } };
  if (providers.Providers?.some(p => p.ProviderName === 'Google')) await client.send(new UpdateIdentityProviderCommand(input));
  else await client.send(new CreateIdentityProviderCommand({ ...input, ProviderType: 'Google' }));
  const described = await client.send(new DescribeUserPoolClientCommand({ UserPoolId: pool, ClientId: env.OWNER_OIDC_CLIENT_ID }));
  const { CreationDate, LastModifiedDate, ClientSecret, ...settings } = described.UserPoolClient!;
  await client.send(new UpdateUserPoolClientCommand({ ...settings,
    UserPoolId: pool, ClientId: env.OWNER_OIDC_CLIENT_ID,
    SupportedIdentityProviders: [...new Set([...(settings.SupportedIdentityProviders || ['COGNITO']), 'Google'])],
    ExplicitAuthFlows: [...new Set<import('@aws-sdk/client-cognito-identity-provider').ExplicitAuthFlowsType>([...(settings.ExplicitAuthFlows || ['ALLOW_REFRESH_TOKEN_AUTH', 'ALLOW_USER_SRP_AUTH']), 'ALLOW_USER_PASSWORD_AUTH'])],
  }));
  const verified = (await client.send(new DescribeUserPoolClientCommand({UserPoolId:pool, ClientId:env.OWNER_OIDC_CLIENT_ID}))).UserPoolClient!;
  console.log(JSON.stringify({ googleEnabled: verified.SupportedIdentityProviders?.includes('Google'), emailPasswordEnabled: verified.ExplicitAuthFlows?.includes('ALLOW_USER_PASSWORD_AUTH'), callbackUrls:verified.CallbackURLs }));
} catch (error) {
  console.error('Cognito setup failed:', error instanceof Error ? error.name : 'Unknown error');
  process.exitCode = 1;
}
