import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Sunucu tarafı paketler bundle'a alınmaz (native/ağır bağımlılıklar)
  serverExternalPackages: ["pg", "@prisma/adapter-pg", "bullmq", "ioredis", "unpdf"],
  experimental: {
    serverActions: { bodySizeLimit: "25mb" },
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
