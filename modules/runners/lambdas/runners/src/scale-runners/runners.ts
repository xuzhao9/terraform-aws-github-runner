import { EC2, SSM } from 'aws-sdk';
import { Octokit } from '@octokit/rest';
import { createOctoClient, createGithubAuth } from './gh-auth';

export interface RunnerInfo {
  instanceId: string;
  launchTime: Date | undefined;
  repo: string | undefined;
  org: string | undefined;
  runnerType: string | undefined;
}

export interface ListRunnerFilters {
  repoName?: string;
  orgName?: string;
  environment?: string;
}

export interface RunnerType {
  instance_type: string,
  os: string,
  ami_filter: string,
  max_available: number,
  min_available: number,
  disk_size: number,
  runnerTypeName: string,
}

export async function findAmiID(filter: string, owners: string = "amazon"): Promise<string> {
  const ec2 = new EC2();
  const filters = [
    { Name: "name", Values: [filter] },
    { Name: "state", Values: ["available"] }
  ]
  const describeImagesResponse = await ec2.describeImages({Owners: [owners], Filters: filters}).promise();
  await sortByCreationDate(describeImagesResponse)
  const latestImage = describeImagesResponse.Images?.shift();
  console.info("findAmiID", {filter: filter, latestImage: latestImage});
  return latestImage?.ImageId as string
}

// Shamelessly stolen from https://ajahne.github.io/blog/javascript/aws/2019/05/15/getting-an-ami-id-nodejs.html
async function sortByCreationDate(data: EC2.DescribeImagesResult): Promise<void> {
  const images = data.Images as EC2.ImageList;
  images.sort(function(a: EC2.Image,b: EC2.Image) {
    const dateA: string = a['CreationDate'] as string;
    const dateB: string = b['CreationDate'] as string;
    if (dateA < dateB) {
      return -1;
    }
    if (dateA > dateB) {
      return 1;
    }
    // dates are equal
    return 0;
  });

  // arrange the images by date in descending order
  images.reverse();
}

export async function listRunners(filters: ListRunnerFilters | undefined = undefined): Promise<RunnerInfo[]> {
  const ec2 = new EC2();
  const ec2Filters = [
    { Name: 'tag:Application', Values: ['github-action-runner'] },
    { Name: 'instance-state-name', Values: ['running', 'pending'] },
  ];
  if (filters) {
    if (filters.environment !== undefined) {
      ec2Filters.push({ Name: 'tag:Environment', Values: [filters.environment] });
    }
    if (filters.repoName !== undefined) {
      ec2Filters.push({ Name: 'tag:Repo', Values: [filters.repoName] });
    }
    if (filters.orgName !== undefined) {
      ec2Filters.push({ Name: 'tag:Org', Values: [filters.orgName] });
    }
  }
  const runningInstances = await ec2.describeInstances({ Filters: ec2Filters }).promise();
  const runners: RunnerInfo[] = [];
  if (runningInstances.Reservations) {
    for (const r of runningInstances.Reservations) {
      if (r.Instances) {
        for (const i of r.Instances) {
          runners.push({
            instanceId: i.InstanceId as string,
            launchTime: i.LaunchTime,
            repo: i.Tags?.find((e) => e.Key === 'Repo')?.Value,
            org: i.Tags?.find((e) => e.Key === 'Org')?.Value,
            runnerType: i.Tags?.find((e) => e.Key === 'RunnerType')?.Value,
          });
        }
      }
    }
  }
  return runners;
}

export interface RunnerInputParameters {
  runnerConfig: string;
  environment: string;
  repoName?: string;
  orgName?: string;
  runnerType: RunnerType;
}

export async function terminateRunner(runner: RunnerInfo): Promise<void> {
  const ec2 = new EC2();
  await ec2
    .terminateInstances({
      InstanceIds: [runner.instanceId],
    })
    .promise();
  console.debug('Runner terminated.' + runner.instanceId);
}

export async function createRunner(runnerParameters: RunnerInputParameters): Promise<void> {
  const launchTemplateNameLinux = process.env.LAUNCH_TEMPLATE_NAME_LINUX as string;
  const launchTemplateVersionLinux = process.env.LAUNCH_TEMPLATE_VERSION_LINUX as string;
  const launchTemplateNameWindows = process.env.LAUNCH_TEMPLATE_NAME_WINDOWS as string;
  const launchTemplateVersionWindows = process.env.LAUNCH_TEMPLATE_VERSION_WINDOWS as string;

  const subnets = (process.env.SUBNET_IDS as string).split(',');
  const randomSubnet = subnets[Math.floor(Math.random() * subnets.length)];
  console.debug('Runner configuration: ' + JSON.stringify(runnerParameters));
  const ec2 = new EC2();
  const imageID = await findAmiID(runnerParameters.runnerType.ami_filter);
  if (imageID === "") {
    console.error(`Could not find a matching AMI for filter ${runnerParameters.runnerType.ami_filter}`)
    return
  }
  const runInstancesResponse = await ec2
    .runInstances({
      MaxCount: 1,
      MinCount: 1,
      ImageId: imageID,
      LaunchTemplate: {
        LaunchTemplateName: runnerParameters.runnerType.os === "linux" ? launchTemplateNameLinux : launchTemplateNameWindows,
        Version: runnerParameters.runnerType.os === "linux" ? launchTemplateVersionLinux : launchTemplateVersionWindows,
      },
      InstanceType: runnerParameters.runnerType.instance_type,
      BlockDeviceMappings: [
        {
          DeviceName: "/dev/xvda",
          Ebs: {
            VolumeSize: runnerParameters.runnerType.disk_size,
            VolumeType: "gp3",
            Encrypted: true,
            DeleteOnTermination: true
          }
        }
      ],
      SubnetId: randomSubnet,
      TagSpecifications: [
        {
          ResourceType: 'instance',
          Tags: [
            { Key: 'Application', Value: 'github-action-runner' },
            {
              Key: runnerParameters.orgName ? 'Org' : 'Repo',
              Value: runnerParameters.orgName ? runnerParameters.orgName : runnerParameters.repoName,
            },
            { Key: 'RunnerType', Value: runnerParameters.runnerType.runnerTypeName }
          ],
        },
      ],
    })
    .promise();
  console.info('Created instance(s): ', runInstancesResponse.Instances?.map((i) => i.InstanceId).join(','));

  const ssm = new SSM();
  runInstancesResponse.Instances?.forEach(async (i: EC2.Instance) => {
    await ssm
      .putParameter({
        Name: runnerParameters.environment + '-' + (i.InstanceId as string),
        Value: runnerParameters.runnerConfig,
        Type: 'SecureString',
      })
      .promise();
  });
}

export interface Repo {
  repoName: string;
  repoOwner: string;
}

export function getRepo(org: string | undefined, repo: string | undefined, orgLevel: boolean): Repo {
  return { repoOwner: org as string, repoName: orgLevel ? '' : repo as string}
}

// scale-down
// createGitHubClientForRunner("", "seemethere/test-repo", false) // orgLevel false
// createGitHubClientForRunner("seemethere", "" , true) // orgLevel true
export function createGitHubClientForRunnerFactory(): (org: string | undefined, repo: string | undefined, orgLevel: boolean) => Promise<Octokit> {
  const cache: Map<string, Octokit> = new Map();

  return async (org: string | undefined, repo: string | undefined, orgLevel: boolean) => {
    const ghesBaseUrl = process.env.GHES_URL as string;
    let ghesApiUrl = '';
    if (ghesBaseUrl) {
      ghesApiUrl = `${ghesBaseUrl}/api/v3`;
    }
    const ghAuth = await createGithubAuth(undefined, 'app', ghesApiUrl);
    const githubClient = await createOctoClient(ghAuth.token, ghesApiUrl);
    const repository = getRepo(org, repo, orgLevel);
    const key = orgLevel ? repository.repoOwner : repository.repoOwner + repository.repoName;
    const cachedOctokit = cache.get(key);

    if (cachedOctokit) {
      console.debug(`[createGitHubClientForRunner] Cache hit for ${key}`);
      return cachedOctokit;
    }

    console.debug(`[createGitHubClientForRunner] Cache miss for ${key}`);
    const installationId = orgLevel
      ? (
        await githubClient.apps.getOrgInstallation({
          org: repository.repoOwner,
        })
      ).data.id
      : (
        await githubClient.apps.getRepoInstallation({
          owner: repository.repoOwner,
          repo: repository.repoName,
        })
      ).data.id;
    const ghAuth2 = await createGithubAuth(installationId, 'installation', ghesApiUrl);
    const octokit = await createOctoClient(ghAuth2.token, ghesApiUrl);
    cache.set(key, octokit);

    return octokit;
  };
}

/**
 * Extract the inner type of a promise if any
 */
export type UnboxPromise<T> = T extends Promise<infer U> ? U : T;

export type GhRunners = UnboxPromise<ReturnType<Octokit['actions']['listSelfHostedRunnersForRepo']>>['data']['runners'];

export function listGithubRunnersFactory(): (
  client: Octokit,
  org: string | undefined,
  repo: string | undefined,
  enableOrgLevel: boolean,
) => Promise<GhRunners> {
  const cache: Map<string, GhRunners> = new Map();
  return async (client: Octokit, org: string | undefined, repo: string | undefined, enableOrgLevel: boolean) => {
    const repository = getRepo(org, repo, enableOrgLevel);
    const key = enableOrgLevel ? repository.repoOwner : repository.repoOwner + repository.repoName;
    const cachedRunners = cache.get(key);
    if (cachedRunners) {
      console.debug(`[listGithubRunners] Cache hit for ${key}`);
      return cachedRunners;
    }

    console.debug(`[listGithubRunners] Cache miss for ${key}`);
    const runners = enableOrgLevel
      ? await client.paginate(client.actions.listSelfHostedRunnersForOrg, {
        org: repository.repoOwner,
      })
      : await client.paginate(client.actions.listSelfHostedRunnersForRepo, {
        owner: repository.repoOwner,
        repo: repository.repoName,
      });
    cache.set(key, runners);

    return runners;
  };
}
