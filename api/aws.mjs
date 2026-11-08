// What sync needs from AWS once deployed: the GitHub App's private key and webhook secret, read from SSM
// Parameter Store (SecureString, free tier) and kept in memory, and one-off EventBridge schedules that
// wake the worker for a retry, each deleting itself once it has run. Nothing here runs while idle.

const once = (fn) => {
  let p = null;
  return () => (p ??= fn().catch((err) => ((p = null), Promise.reject(err))));
};

export function awsSync(env = process.env) {
  const prefix = env.GITHUB_APP_SSM_PREFIX;
  const parameter = (name) =>
    once(async () => {
      const { SSMClient, GetParameterCommand } = await import('@aws-sdk/client-ssm');
      const res = await new SSMClient({}).send(new GetParameterCommand({ Name: `${prefix}/${name}`, WithDecryption: true }));
      return res.Parameter.Value;
    });

  let functionArn = env.SYNC_FUNCTION_ARN ?? null;
  /** A one-off schedule that runs drain(projectId) at `at`. Booking it again moves it. */
  async function schedule(projectId, at) {
    if (!functionArn || !env.SCHEDULER_ROLE_ARN) throw new Error('No function ARN or scheduler role to book a retry with');
    const { SchedulerClient, CreateScheduleCommand, UpdateScheduleCommand } = await import('@aws-sdk/client-scheduler');
    const input = {
      Name: `${env.SCHEDULE_PREFIX}-sync-${projectId}`.slice(0, 64),
      ScheduleExpression: `at(${new Date(Math.max(Date.parse(at), Date.now() + 60_000)).toISOString().slice(0, 19)})`,
      ScheduleExpressionTimezone: 'UTC',
      FlexibleTimeWindow: { Mode: 'OFF' },
      ActionAfterCompletion: 'DELETE',
      Target: { Arn: functionArn, RoleArn: env.SCHEDULER_ROLE_ARN, Input: JSON.stringify({ overworld: 'drain', projectId }) },
    };
    const client = new SchedulerClient({});
    try {
      await client.send(new CreateScheduleCommand(input));
    } catch (err) {
      if (err.name !== 'ConflictException') throw err;
      await client.send(new UpdateScheduleCommand(input));
    }
  }

  return {
    enabled: Boolean(prefix && env.GITHUB_APP_ID && env.GITHUB_INSTALLATION_ID),
    app: { appId: env.GITHUB_APP_ID, installationId: env.GITHUB_INSTALLATION_ID, slug: env.GITHUB_APP_SLUG, privateKey: parameter('private-key') },
    webhookSecret: parameter('webhook-secret'),
    schedule,
    /** The Lambda knows its own ARN only once it runs: schedules point back at it. */
    seenFunction: (arn) => (functionArn ??= arn?.split(':').slice(0, 7).join(':') ?? null),
  };
}
