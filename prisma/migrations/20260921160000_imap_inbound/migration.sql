-- AlterTable
ALTER TABLE "ConversationMessage" ADD COLUMN "externalId" TEXT;

-- CreateTable
CREATE TABLE "MailboxCursor" (
    "id" TEXT NOT NULL,
    "uidValidity" BIGINT NOT NULL,
    "lastUid" INTEGER NOT NULL,
    "lastPollAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MailboxCursor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ConversationMessage_companyId_externalId_key" ON "ConversationMessage"("companyId", "externalId");
