import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts", "storage/**", "prisma/migrations/**"] },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Döngüsel import production bundle'da "Cannot access before initialization" ile sayfaları çökertir
      "import/no-cycle": ["error", { ignoreExternal: true, allowUnsafeDynamicCyclicDependency: true }],
      // UI ve servisler Prisma'yı doğrudan import etmez; tenantDb() kullanılır.
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/server/db",
              importNames: ["rawDb"],
              message: "rawDb yalnızca auth, tenancy, jobs, admin ve seed katmanında kullanılabilir. Servislerde tenantDb(ctx) kullanın.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/server/db.ts",
      "src/server/auth/**",
      "src/server/tenancy/**",
      "src/server/jobs/**",
      "src/server/audit/**",
      "src/server/usage/**",
      "src/server/admin/**",
      "src/server/ai/usage-log.ts",
      "src/server/knowledge/search.ts",
      "src/app/api/health/**",
      "src/worker/**",
      "prisma/**",
      "tests/**",
    ],
    rules: { "no-restricted-imports": "off" },
  },
];

export default config;
