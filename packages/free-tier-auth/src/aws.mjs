// The AWS side, loaded only when deployed: the Lambda runtime supplies the SDK, so the package has no dependencies of its own.
export async function cognitoClient({ region } = {}) {
  const sdk = await import('@aws-sdk/client-cognito-identity-provider');
  const client = new sdk.CognitoIdentityProviderClient({ region });
  const call = (Command) => (input) => client.send(new Command(input));
  return {
    adminCreateUser: call(sdk.AdminCreateUserCommand),
    adminSetUserPassword: call(sdk.AdminSetUserPasswordCommand),
    adminInitiateAuth: call(sdk.AdminInitiateAuthCommand),
    adminRespondToAuthChallenge: call(sdk.AdminRespondToAuthChallengeCommand),
    revokeToken: call(sdk.RevokeTokenCommand),
  };
}

export async function ssmSecret(name) {
  const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
  const r = await new SSMClient({}).send(new GetParameterCommand({ Name: name, WithDecryption: true }));
  return r.Parameter.Value;
}
