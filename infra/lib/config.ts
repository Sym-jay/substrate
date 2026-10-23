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
    // Memory-optimized, 16 vCPU / 128 GiB, supports nested virtualization.
    instanceType: 'r8i.4xlarge',
    // Ubuntu 24.04 amd64. Pinned for the same reason as the control box.
    ami: 'ami-0fc5120b2d80d4749',
    rootGiB: 30,
    dataGiB: 50,
    hostdPort: 7070,
  },

  // AWS-managed list of CloudFront's origin-facing addresses in ap-south-1.
  cloudFrontPrefixList: 'pl-9aa247f3',
} as const
