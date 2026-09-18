import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // workspace 包以 TS 源码发布，需要 Next 转译
  transpilePackages: ['@aichat/db', '@aichat/contracts'],
};

export default nextConfig;
