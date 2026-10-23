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

  // Windows workspaces (M9): an EC2 instance each, from our own image
  // (`bun run build:windows-image`), in the same subnet as the host.
  windows: {
    // 16 vCPU / 64 GiB; nested virtualization, so WSL2 works.
    instanceType: 'm8i.4xlarge',
    builderInstanceType: 'm8i.2xlarge',
    rootGiB: 100,
    // Fixed names: the control box and the image build look them up.
    launchTemplate: 'substrate-windows',
    instanceProfile: 'substrate-windows',
    baseImageParameter: '/aws/service/ami-windows-latest/Windows_Server-2025-English-Full-Base',
    // Set by the image build to the newest image; new workspaces use it.
    imageParameter: '/substrate/windows-ami',
    subnetParameter: '/substrate/windows-subnet',
  },

  // AWS-managed list of CloudFront's origin-facing addresses in ap-south-1.
  cloudFrontPrefixList: 'pl-9aa247f3',
} as const
