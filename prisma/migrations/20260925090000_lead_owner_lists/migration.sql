-- CreateEnum
CREATE TYPE "LeadListKind" AS ENUM ('SEARCH', 'IMPORT', 'MANUAL');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "ownerId" TEXT;

-- CreateTable
CREATE TABLE "LeadList" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "LeadListKind" NOT NULL DEFAULT 'MANUAL',
    "createdById" TEXT,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadListItem" (
    "listId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadListItem_pkey" PRIMARY KEY ("listId","leadId")
);

-- CreateIndex
CREATE INDEX "LeadList_companyId_createdAt_idx" ON "LeadList"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LeadList_companyId_jobId_key" ON "LeadList"("companyId", "jobId");

-- CreateIndex
CREATE INDEX "LeadListItem_companyId_leadId_idx" ON "LeadListItem"("companyId", "leadId");

-- CreateIndex
CREATE INDEX "Lead_companyId_ownerId_idx" ON "Lead"("companyId", "ownerId");

-- AddForeignKey
ALTER TABLE "LeadList" ADD CONSTRAINT "LeadList_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadListItem" ADD CONSTRAINT "LeadListItem_listId_fkey" FOREIGN KEY ("listId") REFERENCES "LeadList"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadListItem" ADD CONSTRAINT "LeadListItem_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

