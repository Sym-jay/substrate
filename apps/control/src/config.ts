// Set by `bun build --define` in scripts/deploy-control.ts.
declare const BUILD_VERSION: string | undefined

export const config = {
  port: Number(process.env.PORT ?? 8080),
  region: process.env.AWS_REGION ?? 'ap-south-1',
  // Unset in local development, where there is no sandbox host.
  hostInstanceId: process.env.SUBSTRATE_HOST_INSTANCE_ID || null,
  // The built web app, relative to the working directory.
  webDir: process.env.SUBSTRATE_WEB_DIR ?? 'web',
  version: typeof BUILD_VERSION === 'string' ? BUILD_VERSION : 'dev',
}
