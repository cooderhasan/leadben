-- E-ticaret fırsatı modu: lead'in çevrim içi satış durumu (AI'sız tespit)
CREATE TYPE "EcommerceStatus" AS ENUM ('NO_WEBSITE', 'SOCIAL_ONLY', 'SITE_DOWN', 'INFO_SITE', 'MARKETPLACE_ONLY', 'OUTDATED_ECOMMERCE', 'HAS_ECOMMERCE');

ALTER TABLE "Company" ADD COLUMN "ecommerceProspecting" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "Lead" ADD COLUMN "ecommerceStatus" "EcommerceStatus",
ADD COLUMN "ecommercePlatform" TEXT,
ADD COLUMN "marketplaces" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "siteIssues" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "ecommerceCheckedAt" TIMESTAMP(3);

CREATE INDEX "Lead_companyId_ecommerceStatus_idx" ON "Lead"("companyId", "ecommerceStatus");
