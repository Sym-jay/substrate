import { ArnFormat, CfnDeletionPolicy, CfnOutput, Duration, Fn, RemovalPolicy, Size, Stack, Tags, type StackProps } from 'aws-cdk-lib'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as dlm from 'aws-cdk-lib/aws-dlm'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as ssm from 'aws-cdk-lib/aws-ssm'
import type { Construct } from 'constructs'
import { config } from './config.ts'

export class SubstrateStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props)
    Tags.of(this).add('project', 'substrate')

    // One public subnet and no NAT gateway. Nothing accepts traffic from the
    // internet: CloudFront reaches the control box, the control box reaches the
    // host, and admins come in through SSM.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(config.vpcCidr),
      availabilityZones: [config.availabilityZone],
      natGateways: 0,
      subnetConfiguration: [{ name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 }],
    })

    // Build artifacts (setup scripts, binaries, later the guest kernel and rootfs).
    // Everything in it can be rebuilt, so it goes away with the stack.
    const artifacts = new s3.Bucket(this, 'Artifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      // Every deploy uploads its own release (scripts/deploy-*.ts). Boxes need
      // it only while installing, and what a new box boots from is copied to
      // fixed keys, so old releases can go.
      lifecycleRules: [
        { prefix: 'host/releases/', expiration: Duration.days(14) },
        { prefix: 'control/releases/', expiration: Duration.days(14) },
      ],
    })

    const controlSg = new ec2.SecurityGroup(this, 'ControlSg', {
      vpc,
      description: 'Substrate control box: reachable from CloudFront only',
    })
    controlSg.addIngressRule(
      ec2.Peer.prefixList(config.cloudFrontPrefixList),
      ec2.Port.tcp(config.control.port),
      'CloudFront to the control API',
    )

    const hostSg = new ec2.SecurityGroup(this, 'HostSg', {
      vpc,
      description: 'Substrate sandbox host: reachable from the control box only',
    })
    hostSg.addIngressRule(controlSg, ec2.Port.tcp(config.host.hostdPort), 'Control box to hostd')

    const ssmCore = iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    const readSubstrateParams = new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:GetParameters'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: 'substrate/*' })],
    })

    // Sandbox host.
    const hostRole = new iam.Role(this, 'HostRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ssmCore],
    })
    artifacts.grantRead(hostRole, 'host/*')
    hostRole.addToPolicy(readSubstrateParams)

    const hostData = new ec2.Volume(this, 'HostData', {
      availabilityZone: config.availabilityZone,
      size: Size.gibibytes(config.host.dataGiB),
      volumeType: ec2.EbsDeviceVolumeType.GP3,
      encrypted: true,
      // Holds the ZFS pool with every VM, so it outlives the host and the stack.
      removalPolicy: RemovalPolicy.RETAIN,
      volumeName: 'substrate-host-data',
    })

    // Daily snapshots of the data disk, by Data Lifecycle Manager. ZFS keeps
    // its pool consistent on disk at every moment, so a snapshot of the live
    // disk restores like a power cut: at most seconds of writes lost.
    Tags.of(hostData).add('substrate:backup', 'daily')
    const snapshotRole = new iam.Role(this, 'DataSnapshotRole', {
      assumedBy: new iam.ServicePrincipal('dlm.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSDataLifecycleManagerServiceRole')],
    })
    new dlm.CfnLifecyclePolicy(this, 'DataSnapshots', {
      description: 'Substrate daily snapshots of the host data disk',
      state: 'ENABLED',
      executionRoleArn: snapshotRole.roleArn,
      policyDetails: {
        policyType: 'EBS_SNAPSHOT_MANAGEMENT',
        resourceTypes: ['VOLUME'],
        targetTags: [{ key: 'substrate:backup', value: 'daily' }],
        schedules: [
          {
            name: 'Daily',
            createRule: { interval: 24, intervalUnit: 'HOURS', times: [config.host.dataSnapshots.time] },
            retainRule: { count: config.host.dataSnapshots.keep },
            copyTags: true,
            tagsToAdd: [{ key: 'substrate:snapshot', value: 'daily' }],
          },
        ],
      },
    })

    const hostUserData = ec2.UserData.forLinux()
    hostUserData.addCommands(
      'mkdir -p /etc/substrate /opt/substrate',
      `cat > /etc/substrate/host.env <<'EOF'`,
      `SUBSTRATE_REGION=${config.region}`,
      `SUBSTRATE_BUCKET=${artifacts.bucketName}`,
      `SUBSTRATE_DATA_VOLUME=${hostData.volumeId}`,
      'EOF',
      'snap install aws-cli --classic',
      'export PATH="$PATH:/snap/bin"',
      // A replacement host re-runs the last deployed setup. A brand-new stack has
      // none yet; `bun run setup:host` provides it.
      `if aws s3 cp s3://${artifacts.bucketName}/host/setup-host.sh /opt/substrate/setup-host.sh; then bash /opt/substrate/setup-host.sh; fi`,
    )

    // Nested virtualization can only be switched on through a launch template.
    // Keep this template unchanged: a new template version replaces the host.
    const hostTemplate = new ec2.CfnLaunchTemplate(this, 'HostTemplate', {
      launchTemplateData: {
        metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
      },
    })
    hostTemplate.addPropertyOverride('LaunchTemplateData.CpuOptions.NestedVirtualization', 'enabled')

    const host = new ec2.Instance(this, 'Host', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      availabilityZone: config.availabilityZone,
      instanceType: new ec2.InstanceType(config.host.instanceType),
      machineImage: ec2.MachineImage.genericLinux({ [config.region]: config.host.ami }),
      securityGroup: hostSg,
      role: hostRole,
      userData: hostUserData,
      instanceName: 'substrate-host',
      blockDevices: [
        {
          deviceName: '/dev/sda1',
          volume: ec2.BlockDeviceVolume.ebs(config.host.rootGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    })
    const cfnHost = host.node.defaultChild as ec2.CfnInstance
    cfnHost.launchTemplate = {
      launchTemplateId: hostTemplate.ref,
      version: hostTemplate.attrLatestVersionNumber,
    }

    new ec2.CfnVolumeAttachment(this, 'HostDataAttachment', {
      instanceId: host.instanceId,
      volumeId: hostData.volumeId,
      device: '/dev/sdf',
    })

    // Control box.
    const controlRole = new iam.Role(this, 'ControlRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ssmCore],
    })
    artifacts.grantRead(controlRole, 'control/*')
    controlRole.addToPolicy(readSubstrateParams)
    controlRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['ec2:DescribeInstances'], resources: ['*'] }),
    )
    // For M5, where the control box stops the host when every VM is idle.
    controlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StartInstances', 'ec2:StopInstances'],
        resources: [
          this.formatArn({ service: 'ec2', resource: 'instance', resourceName: host.instanceId }),
        ],
      }),
    )

    // Windows workspaces (M9). The control box reaches each one's SSH (for
    // terminals) and VNC (for the desktop); nothing else can.
    const windowsSg = new ec2.SecurityGroup(this, 'WindowsSg', {
      vpc,
      description: 'Substrate Windows workspaces: SSH and VNC from the control box only',
    })
    windowsSg.addIngressRule(controlSg, ec2.Port.tcp(22), 'Control box to SSH (terminals)')
    windowsSg.addIngressRule(controlSg, ec2.Port.tcp(5900), 'Control box to VNC (desktop)')
    const windowsRole = new iam.Role(this, 'WindowsRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [ssmCore],
    })
    const windowsProfile = new iam.InstanceProfile(this, 'WindowsProfile', {
      role: windowsRole,
      instanceProfileName: config.windows.instanceProfile,
    })
    // Nested virtualization (for WSL2) can only be switched on through a launch template.
    const windowsTemplate = new ec2.CfnLaunchTemplate(this, 'WindowsTemplate', {
      launchTemplateName: config.windows.launchTemplate,
      launchTemplateData: {
        iamInstanceProfile: { arn: windowsProfile.instanceProfileArn },
        securityGroupIds: [windowsSg.securityGroupId],
        metadataOptions: { httpEndpoint: 'enabled', httpTokens: 'required', httpPutResponseHopLimit: 1 },
        blockDeviceMappings: [
          {
            deviceName: '/dev/sda1',
            ebs: { volumeSize: config.windows.rootGiB, volumeType: 'gp3', encrypted: true, deleteOnTermination: true },
          },
        ],
      },
    })
    windowsTemplate.addPropertyOverride('LaunchTemplateData.CpuOptions.NestedVirtualization', 'enabled')
    new ssm.StringParameter(this, 'WindowsSubnet', { parameterName: config.windows.subnetParameter, stringValue: vpc.publicSubnets[0]!.subnetId })

    // The control box creates, starts, stops and deletes them: only instances
    // it tagged as workspaces, from this template, in this subnet.
    const ec2Arn = (resource: string, name = '*') => this.formatArn({ service: 'ec2', resource, resourceName: name })
    controlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:RunInstances'],
        resources: [ec2Arn('instance'), ec2Arn('volume'), ec2Arn('network-interface')],
        conditions: { StringEquals: { 'aws:RequestTag/substrate:windows': 'workspace' } },
      }),
    )
    controlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:RunInstances'],
        resources: [
          `arn:${this.partition}:ec2:${this.region}::image/*`,
          ec2Arn('subnet', vpc.publicSubnets[0]!.subnetId),
          ec2Arn('security-group', windowsSg.securityGroupId),
          ec2Arn('launch-template', windowsTemplate.ref),
        ],
      }),
    )
    controlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:CreateTags'],
        resources: [ec2Arn('instance'), ec2Arn('volume'), ec2Arn('network-interface')],
        conditions: { StringEquals: { 'ec2:CreateAction': 'RunInstances' } },
      }),
    )
    controlRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:TerminateInstances'],
        resources: [ec2Arn('instance')],
        conditions: { StringEquals: { 'aws:ResourceTag/substrate:windows': 'workspace' } },
      }),
    )
    controlRole.addToPolicy(new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [windowsRole.roleArn] }))
    // CPU, so a workspace busy with an agent isn't stopped as idle.
    controlRole.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:GetMetricData'], resources: ['*'] }))

    const controlUserData = ec2.UserData.forLinux()
    controlUserData.addCommands(
      'mkdir -p /etc/substrate /opt/substrate',
      `cat > /etc/substrate/control.env <<'EOF'`,
      `AWS_REGION=${config.region}`,
      `PORT=${config.control.port}`,
      `SUBSTRATE_BUCKET=${artifacts.bucketName}`,
      `SUBSTRATE_HOST_INSTANCE_ID=${host.instanceId}`,
      'EOF',
      `if aws s3 cp s3://${artifacts.bucketName}/control/setup-control.sh /opt/substrate/setup-control.sh; then bash /opt/substrate/setup-control.sh; fi`,
    )

    const control = new ec2.Instance(this, 'Control', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      availabilityZone: config.availabilityZone,
      instanceType: new ec2.InstanceType(config.control.instanceType),
      machineImage: ec2.MachineImage.genericLinux({ [config.region]: config.control.ami }),
      securityGroup: controlSg,
      role: controlRole,
      userData: controlUserData,
      instanceName: 'substrate-control',
      // Amazon Linux 2023 already requires IMDSv2.
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(config.control.rootGiB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
          }),
        },
      ],
    })

    // A fixed address, so CloudFront's origin never changes.
    const controlIp = new ec2.CfnEIP(this, 'ControlIp', {
      instanceId: control.instanceId,
      tags: [{ key: 'Name', value: 'substrate-control' }],
    })
    // CloudFront needs a hostname, not an IP: use the EIP's public EC2 DNS name.
    const controlHostname = Fn.join('', [
      'ec2-',
      Fn.join('-', Fn.split('.', controlIp.ref)),
      `.${config.region}.compute.amazonaws.com`,
    ])

    // The public HTTPS URL. CloudFront terminates TLS, so no domain is needed.
    const web = new cloudfront.Distribution(this, 'Web', {
      comment: 'Substrate',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: {
        origin: new origins.HttpOrigin(controlHostname, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: config.control.port,
          readTimeout: Duration.seconds(60),
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    })

    new CfnOutput(this, 'Url', { value: `https://${web.distributionDomainName}` })
    // GitHub's OAuth redirect comes back to it (Phase 2).
    new ssm.StringParameter(this, 'PublicUrl', { parameterName: '/substrate/public-url', stringValue: `https://${web.distributionDomainName}` })
    const previews = new cloudfront.Distribution(this, 'Previews', {
      comment: 'Substrate workspace previews',
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        origin: new origins.HttpOrigin(controlHostname, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
          httpPort: config.control.port,
          readTimeout: Duration.seconds(60),
          customHeaders: { 'x-substrate-preview': '1' },
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      },
    })
    new ssm.StringParameter(this, 'PreviewOrigin', { parameterName: '/substrate/preview-origin', stringValue: `https://${previews.distributionDomainName}` })
    new CfnOutput(this, 'PreviewUrl', { value: `https://${previews.distributionDomainName}` })
    this.phase2({ vpc, controlSg, controlRole })

    new CfnOutput(this, 'ArtifactsBucket', { value: artifacts.bucketName })
    new CfnOutput(this, 'ControlInstanceId', { value: control.instanceId })
    new CfnOutput(this, 'HostInstanceId', { value: host.instanceId })
    new CfnOutput(this, 'HostDataVolumeId', { value: hostData.volumeId })
  }

  // Phase 2: the control box's Postgres, the key for users' secrets, and
  // scheduled token rotation.
  private phase2({ vpc, controlSg, controlRole }: { vpc: ec2.IVpc; controlSg: ec2.SecurityGroup; controlRole: iam.Role }) {
    const db = config.database
    // Added beside the VPC's public subnet rather than through its subnet
    // configuration, which would renumber (and so replace) what's there. No
    // route table entries: nothing in them reaches the internet.
    const subnets = db.subnets.map(({ availabilityZone, cidr }, i) =>
      new ec2.Subnet(this, `DatabaseSubnet${i + 1}`, { vpcId: vpc.vpcId, availabilityZone, cidrBlock: cidr, mapPublicIpOnLaunch: false }))
    const subnetGroup = new rds.CfnDBSubnetGroup(this, 'DatabaseSubnets', {
      dbSubnetGroupDescription: 'Substrate control database',
      subnetIds: subnets.map((subnet) => subnet.subnetId),
    })
    const databaseSg = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      description: 'Substrate control database: reachable from the control box only',
      allowAllOutbound: false,
    })
    databaseSg.addIngressRule(controlSg, ec2.Port.tcp(5432), 'Control box to Postgres')

    const database = new rds.CfnDBInstance(this, 'Database', {
      engine: 'postgres',
      engineVersion: db.engineVersion,
      dbInstanceClass: db.instanceClass,
      allocatedStorage: String(db.storageGib),
      storageType: 'gp3',
      storageEncrypted: true,
      dbName: db.name,
      masterUsername: 'substrate_admin',
      // RDS keeps it in Secrets Manager and rotates it; nothing here sees it.
      manageMasterUserPassword: true,
      enableIamDatabaseAuthentication: true,
      dbSubnetGroupName: subnetGroup.ref,
      vpcSecurityGroups: [databaseSg.securityGroupId],
      publiclyAccessible: false,
      multiAz: false,
      backupRetentionPeriod: 7,
      deletionProtection: true,
      autoMinorVersionUpgrade: true,
      copyTagsToSnapshot: true,
    })
    database.cfnOptions.deletionPolicy = CfnDeletionPolicy.SNAPSHOT
    database.cfnOptions.updateReplacePolicy = CfnDeletionPolicy.SNAPSHOT

    const parameter = (name: string, value: string) =>
      new ssm.StringParameter(this, `Database${name.replace(/(^|-)(\w)/g, (_m, _d, c: string) => c.toUpperCase())}`, { parameterName: `/substrate/database/${name}`, stringValue: value })
    parameter('host', database.attrEndpointAddress)
    parameter('port', database.attrEndpointPort)
    parameter('name', db.name)
    parameter('user', db.user)
    parameter('master-secret', database.attrMasterUserSecretSecretArn)

    controlRole.addToPolicy(new iam.PolicyStatement({
      actions: ['rds-db:connect'],
      resources: [this.formatArn({ service: 'rds-db', resource: 'dbuser', resourceName: `${database.attrDbiResourceId}/${db.user}`, arnFormat: ArnFormat.COLON_RESOURCE_NAME })],
    }))
    // Only to create its own user, the first time (apps/control/src/database.ts).
    controlRole.addToPolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [database.attrMasterUserSecretSecretArn] }))

    // Users' agent keys and GitHub tokens (apps/control/src/secrets.ts).
    const userSecrets = new kms.Key(this, 'UserSecretsKey', {
      alias: 'alias/substrate-user-secrets',
      description: "Substrate: users' agent API keys and GitHub tokens",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    })
    userSecrets.grantEncryptDecrypt(controlRole)
    new ssm.StringParameter(this, 'KmsKey', { parameterName: '/substrate/kms-key', stringValue: userSecrets.keyArn })

    // Token rotation: a new hostd token every month, the old one kept as
    // -previous so nothing is refused while the boxes catch up.
    const parameterArn = (name: string) => this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: name.replace(/^\//, '') })
    const rotate = new lambda.Function(this, 'RotateTokens', {
      functionName: 'substrate-rotate-tokens',
      description: 'Substrate: rotates tokens in Parameter Store, keeping the previous one',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: Duration.seconds(30),
      environment: { PARAMETERS: JSON.stringify(config.rotation.parameters) },
      code: lambda.Code.fromInline(`
const { SSMClient, GetParameterCommand, PutParameterCommand } = require('@aws-sdk/client-ssm')
const { randomBytes } = require('node:crypto')
const ssm = new SSMClient({})
exports.handler = async () => {
  for (const name of JSON.parse(process.env.PARAMETERS)) {
    const current = (await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }))).Parameter.Value
    await ssm.send(new PutParameterCommand({ Name: name + '-previous', Value: current, Type: 'SecureString', Overwrite: true }))
    await ssm.send(new PutParameterCommand({ Name: name, Value: randomBytes(32).toString('hex'), Type: 'SecureString', Overwrite: true }))
    console.log('rotated ' + name)
  }
}
`),
    })
    rotate.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: config.rotation.parameters.flatMap((name) => [parameterArn(name), parameterArn(`${name}-previous`)]),
    }))
    new events.Rule(this, 'RotateTokensSchedule', {
      description: 'Substrate: rotate tokens',
      schedule: events.Schedule.rate(Duration.days(config.rotation.everyDays)),
      targets: [new targets.LambdaFunction(rotate)],
    })
  }
}
