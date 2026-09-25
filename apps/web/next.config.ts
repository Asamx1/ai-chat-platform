import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // workspace 包以 TS 源码发布，需要 Next 转译
  transpilePackages: ['@aichat/db', '@aichat/contracts'],
  // Next 16 dev 默认拦截跨源 HMR(127.0.0.1 被视作跨源),ws 握手全挂会卡死浏览器 hydration
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

export default nextConfig;
