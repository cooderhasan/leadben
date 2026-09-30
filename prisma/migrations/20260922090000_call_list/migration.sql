-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'CALL_BACK', 'NOT_INTERESTED', 'INTERESTED', 'CATALOG_REQUESTED', 'MEETING_SET', 'WHATSAPP_CONSENT', 'EMAIL_OBTAINED', 'DO_NOT_CALL');

-- AlterTable
ALTER TABLE "Lead" ADD COLUMN     "callAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lastCallAt" TIMESTAMP(3),
ADD COLUMN     "lastCallOutcome" "CallOutcome",
ADD COLUMN     "nextCallAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "CallLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "userId" TEXT,
    "outcome" "CallOutcome" NOT NULL,
    "note" TEXT,
    "phone" TEXT,
    "nextCallAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CallLog_companyId_leadId_createdAt_idx" ON "CallLog"("companyId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "CallLog_companyId_createdAt_idx" ON "CallLog"("companyId", "createdAt");

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

