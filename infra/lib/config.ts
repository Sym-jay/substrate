// Everything a deploy depends on, in one place. Nothing here is secret: the
// account comes from your AWS credentials at deploy time.

export const config = {
  stackName: 'Substrate',
  region: 'ap-south-1',
  // One AZ keeps the host and its data disk together.
  availabilityZone: 'ap-south-1a',
  vpcCidr: '10.40.0.0/16',

  control: {
    instanceType: 't4g.small',
    // Amazon Linux 2023 arm64. Pinned so a new AMI never replaces the box on deploy.
    ami: 'ami-094f9581a7ca8be38',
    rootGiB: 20,
    port: 8080,
  },

  // Phase 2: the control box's Postgres, in two isolated subnets of the VPC
  // (RDS needs two zones) that route nowhere.
  database: {
    instanceClass: 'db.t4g.micro',
    engineVersion: '17',
    storageGib: 20,
    name: 'substrate',
    // The control box signs in as this user with IAM; RDS keeps the master's
    // password in Secrets Manager and rotates it.
    user: 'substrate_app',
    subnets: [
      { availabilityZone: 'ap-south-1a', cidr: '10.40.20.0/24' },
      { availabilityZone: 'ap-south-1b', cidr: '10.40.21.0/24' },
    ],
  },
  // Tokens a scheduled job replaces, keeping the previous one valid (see
  // apps/hostd/src/tokens.ts).
  rotation: { parameters: ['/substrate/hostd-token'], everyDays: 30 },

  host: {
    // Memory-optimized, 32 vCPU / 256 GiB, supports nested virtualization.
    // With the control box and one Windows workspace, 50 of the account's 64
    // on-demand vCPUs; the rest leaves room to build a Windows image.
    instanceType: 'r8i.8xlarge',
    // Ubuntu 24.04 amd64. Pinned for the same reason as the control box.
    ami: 'ami-0fc5120b2d80d4749',
    rootGiB: 30,
    dataGiB: 50,
    hostdPort: 7070,
    // Daily EBS snapshots of the data disk (every VM), kept for a week. UTC:
    // 21:30 is 03:00 in India.
    dataSnapshots: { time: '21:30', keep: 7 },
  },

  // AWS-managed list of CloudFront's origin-facing addresses in ap-south-1.
  cloudFrontPrefixList: 'pl-9aa247f3',
} as const
