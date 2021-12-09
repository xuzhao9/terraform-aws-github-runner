import { Octokit } from '@octokit/rest';
import { bool } from 'aws-sdk/clients/signer';
import moment from 'moment';
import {
  listRunners,
  RunnerInfo,
  terminateRunner,
  Repo,
  createGitHubClientForRunner,
  listGithubRunners,
  getRepo,
  ghRunnersCache,
  ghClientCache,
  getRunner,
  GhRunner,
} from './runners';
import { getIdleRunnerCount, ScalingDownConfig } from './scale-down-config';

function runnerMinimumTimeExceeded(runner: RunnerInfo, minimumRunningTimeInMinutes: string): boolean {
  const launchTimePlusMinimum = moment(runner.launchTime).utc().add(minimumRunningTimeInMinutes, 'minutes');
  const now = moment(new Date()).utc();
  return launchTimePlusMinimum < now;
}

export async function scaleDown(): Promise<void> {
  const enableOrgLevel = false;
  const environment = process.env.ENVIRONMENT as string;
  const minimumRunningTimeInMinutes = process.env.MINIMUM_RUNNING_TIME_IN_MINUTES as string;

  // list and sort runners, newest first. This ensure we keep the newest runners longer.
  const runners = (
    await listRunners({
      environment: environment,
    })
  ).sort((a, b): number => {
    if (a.launchTime === undefined) return 1;
    if (b.launchTime === undefined) return 1;
    if (a.launchTime < b.launchTime) return 1;
    if (a.launchTime > b.launchTime) return -1;
    return 0;
  });

  if (runners.length === 0) {
    console.debug(`No active runners found for environment: '${environment}'`);
    return;
  }

  // Ensure a clean cache before attempting each scale down event
  ghRunnersCache.reset();
  ghClientCache.reset();

  for await (const ec2runner of runners) {
    if (!runnerMinimumTimeExceeded(ec2runner, minimumRunningTimeInMinutes)) {
      console.debug(
        `Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] has not been alive long enough, skipping`,
      );
      continue;
    }

    const githubAppClient = await createGitHubClientForRunner(ec2runner.org, ec2runner.repo, enableOrgLevel);
    const repo = getRepo(ec2runner.org, ec2runner.repo, enableOrgLevel);
    const ghRunners = await listGithubRunners(githubAppClient, ec2runner.org, ec2runner.repo, enableOrgLevel);
    let ghRunner: GhRunner | undefined = ghRunners.find((runner) => runner.name === ec2runner.instanceId);
    // ec2Runner matches a runner that's registered to github and that runner is marked as busy
    if (ghRunner && ghRunner.busy) {
      console.info(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] is busy, skipping`);
      continue;
    }
    // First attempt to de-register runner from Github, catch scenario should only happen
    // when attempting to de-register a runner that is currently running a job
    // Attempting to de-register a non-existent runner will result in a continuation to terminate
    // the instance on AWS
    try {
      console.info(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] will be de-registered from Github`);
      await githubAppClient.actions.deleteSelfHostedRunnerFromRepo({
        runner_id: Number(ec2runner.ghRunnerId),
        owner: repo.repoOwner,
        repo: repo.repoName,
      });
    } catch (e) {
      // Shoud catch scenarios when attempting to de-register a runner that is currently running a job
      console.warn(`Error de-registering '${ec2runner.instanceId}' [${ec2runner.runnerType}]: ${e}`);
      return;
    }
    // Remove orphan AWS runners.
    console.info(`Runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] will be terminated on AWS`);
    try {
      await terminateRunner(ec2runner);
    } catch (e) {
      console.error(`Orphan runner '${ec2runner.instanceId}' [${ec2runner.runnerType}] cannot be removed: ${e}`);
    }
  }
}
