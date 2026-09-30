-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "MemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "FactSource" AS ENUM ('WEBSITE', 'DOCUMENT', 'USER', 'SEED', 'AI_INFERRED');

-- CreateEnum
CREATE TYPE "FactStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('CATALOG', 'PRODUCT_LIST', 'PRICE_LIST', 'TECHNICAL', 'CERTIFICATE', 'FAQ', 'SALES_RULES', 'CASE_STUDY', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentOrigin" AS ENUM ('UPLOAD', 'WEBSITE', 'MANUAL');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "MemoryType" AS ENUM ('RULE', 'PREFERENCE', 'FACT');

-- CreateEnum
CREATE TYPE "MemoryStatus" AS ENUM ('ACTIVE', 'PENDING', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AnalysisStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "AnalysisTarget" AS ENUM ('OWN_COMPANY', 'LEAD', 'COMPETITOR');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'RESEARCHING', 'QUALIFIED', 'CONTACT_READY', 'CONTACTED', 'REPLIED', 'INTERESTED', 'QUALIFIED_OPPORTUNITY', 'QUOTE_REQUESTED', 'PROPOSAL_SENT', 'NEGOTIATION', 'WON', 'LOST', 'NURTURE', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "LeadSourceType" AS ENUM ('GOOGLE_MAPS', 'COMPANY_WEBSITE', 'INSTAGRAM', 'WEB_SEARCH', 'DIRECTORY', 'PUBLIC_REGISTRY', 'THIRD_PARTY_DATA', 'CSV_IMPORT', 'MANUAL');

-- CreateEnum
CREATE TYPE "ContactType" AS ENUM ('COMPANY_GENERIC', 'PERSONAL');

-- CreateEnum
CREATE TYPE "CommunicationBasis" AS ENUM ('NONE', 'B2B_TRADER_ADDRESS', 'EXPLICIT_CONSENT', 'EXISTING_RELATIONSHIP', 'INBOUND_REQUEST');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('UNKNOWN', 'GRANTED', 'DENIED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "ComplianceStatus" AS ENUM ('SENDABLE', 'REVIEW_REQUIRED', 'DO_NOT_SEND');

-- CreateEnum
CREATE TYPE "SuppressionType" AS ENUM ('EMAIL', 'DOMAIN', 'PHONE', 'LEAD');

-- CreateEnum
CREATE TYPE "SuppressionSource" AS ENUM ('UNSUBSCRIBE_LINK', 'REPLY', 'MANUAL', 'BOUNCE', 'COMPLAINT');

-- CreateEnum
CREATE TYPE "SignalType" AS ENUM ('NEW_FACILITY', 'NEW_PRODUCTION_LINE', 'CAPACITY_EXPANSION', 'NEW_PRODUCT', 'HIRING', 'INVESTMENT', 'NEW_CUSTOMER', 'EXPORT_EXPANSION', 'MACHINE_INVESTMENT', 'LINE_CHANGE', 'SUPPLIER_SEARCH', 'TENDER', 'SOCIAL_ANNOUNCEMENT', 'WEBSITE_CHANGE', 'OTHER');

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DRAFT', 'STRATEGY_REVIEW', 'READY', 'RUNNING', 'PAUSED', 'COMPLETED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('EMAIL', 'WHATSAPP', 'PHONE', 'LINKEDIN_MANUAL', 'INSTAGRAM_MANUAL');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SCHEDULED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReplyCategory" AS ENUM ('INTERESTED', 'NOT_INTERESTED', 'PRICING', 'CATALOG_REQUEST', 'TECHNICAL_QUESTION', 'REQUEST_FOR_CALL', 'REQUEST_FOR_QUOTE', 'LATER', 'WRONG_CONTACT', 'UNSUBSCRIBE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "OpportunityStage" AS ENUM ('NEW', 'QUALIFIED', 'CONTACTED', 'INTERESTED', 'QUOTE', 'NEGOTIATION', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "LostReason" AS ENUM ('PRICE', 'DELIVERY', 'PRODUCT_MISMATCH', 'COMPETITOR', 'TIMING', 'NO_RESPONSE', 'WRONG_CONTACT', 'OTHER');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "Priority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "FollowUpStatus" AS ENUM ('SCHEDULED', 'SENT', 'SKIPPED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProposalStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InsightStatus" AS ENUM ('NEW', 'DISMISSED', 'ACTED');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'AI', 'SYSTEM');

-- CreateEnum
CREATE TYPE "Plan" AS ENUM ('STARTER', 'GROWTH', 'PRO');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('EMAIL_PROVIDER', 'LEAD_SOURCE', 'AI_PROVIDER', 'WHATSAPP_BUSINESS', 'STORAGE', 'PAYMENT');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('NOT_CONFIGURED', 'ACTIVE', 'ERROR', 'DISABLED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT,
    "isPlatformAdmin" BOOLEAN NOT NULL DEFAULT false,
    "emailVerifiedAt" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "activeCompanyId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "website" TEXT,
    "country" TEXT,
    "city" TEXT,
    "creditBalance" INTEGER NOT NULL DEFAULT 0,
    "onboardingStep" INTEGER NOT NULL DEFAULT 0,
    "onboardingCompletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyMember" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "MemberRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyProfile" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sector" TEXT,
    "subSector" TEXT,
    "serviceRegions" TEXT[],
    "sizeBand" TEXT,
    "employeeCount" INTEGER,
    "description" TEXT,
    "aiSummary" TEXT,
    "aiSummaryStatus" "FactStatus" NOT NULL DEFAULT 'PENDING',
    "minOrder" TEXT,
    "priceRangeNote" TEXT,
    "avgOrderValue" DECIMAL(14,2),
    "productionCapacity" TEXT,
    "deliveryTime" TEXT,
    "customManufacturing" BOOLEAN,
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "avgSaleValue" DECIMAL(14,2),
    "salesCycleDays" INTEGER,
    "monthlySalesTarget" DECIMAL(14,2),
    "existingCustomerTypes" TEXT[],
    "existingCustomerExamples" TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyFact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" "FactSource" NOT NULL,
    "sourceRef" TEXT,
    "status" "FactStatus" NOT NULL DEFAULT 'PENDING',
    "confidence" DOUBLE PRECISION,
    "analysisId" TEXT,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyMemory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "MemoryType" NOT NULL,
    "content" TEXT NOT NULL,
    "structured" JSONB,
    "status" "MemoryStatus" NOT NULL DEFAULT 'ACTIVE',
    "source" "FactSource" NOT NULL DEFAULT 'USER',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompanyMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TargetMarket" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isExcluded" BOOLEAN NOT NULL DEFAULT false,
    "businessModel" TEXT,
    "industries" TEXT[],
    "subIndustries" TEXT[],
    "countries" TEXT[],
    "cities" TEXT[],
    "minEmployees" INTEGER,
    "maxEmployees" INTEGER,
    "minRevenue" DECIMAL(16,2),
    "customerTypes" TEXT[],
    "decisionMakerRoles" TEXT[],
    "priority" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TargetMarket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCategory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "categoryId" TEXT,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "description" TEXT,
    "technicalSpecs" JSONB,
    "materials" TEXT[],
    "dimensions" TEXT,
    "applications" TEXT[],
    "industries" TEXT[],
    "minOrder" TEXT,
    "priceRange" TEXT,
    "deliveryTime" TEXT,
    "certifications" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "status" "FactStatus" NOT NULL DEFAULT 'VERIFIED',
    "source" "FactSource" NOT NULL DEFAULT 'USER',
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL DEFAULT 'OTHER',
    "origin" "DocumentOrigin" NOT NULL DEFAULT 'UPLOAD',
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "storageKey" TEXT,
    "url" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "pageCount" INTEGER,
    "charCount" INTEGER,
    "error" TEXT,
    "uploadedById" TEXT,
    "jobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "tokenCount" INTEGER NOT NULL,
    "embedding" vector,
    "embeddingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteAnalysis" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "target" "AnalysisTarget" NOT NULL DEFAULT 'OWN_COMPANY',
    "targetId" TEXT,
    "url" TEXT NOT NULL,
    "status" "AnalysisStatus" NOT NULL DEFAULT 'QUEUED',
    "pages" JSONB,
    "result" JSONB,
    "summary" TEXT,
    "error" TEXT,
    "jobId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WebsiteAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Industry" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "nameTr" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "parentId" TEXT,

    CONSTRAINT "Industry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "domain" TEXT,
    "website" TEXT,
    "industry" TEXT,
    "subIndustry" TEXT,
    "industryId" TEXT,
    "country" TEXT,
    "city" TEXT,
    "district" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "normalizedPhone" TEXT,
    "genericEmail" TEXT,
    "instagram" TEXT,
    "linkedin" TEXT,
    "facebook" TEXT,
    "socialProfiles" JSONB,
    "employeeCountMin" INTEGER,
    "employeeCountMax" INTEGER,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "fitScore" INTEGER,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "aiSummary" TEXT,
    "enrichment" JSONB,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVerifiedAt" TIMESTAMP(3),
    "nextRefreshAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadContact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "ContactType" NOT NULL DEFAULT 'PERSONAL',
    "fullName" TEXT,
    "title" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "linkedinUrl" TEXT,
    "source" "LeadSourceType" NOT NULL,
    "sourceUrl" TEXT,
    "sourceDate" TIMESTAMP(3),
    "communicationBasis" "CommunicationBasis" NOT NULL DEFAULT 'NONE',
    "consentStatus" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "optOut" BOOLEAN NOT NULL DEFAULT false,
    "lastContactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSource" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "LeadSourceType" NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT,
    "sourceUrl" TEXT,
    "rawData" JSONB,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSignal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "type" "SignalType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceUrl" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "confidence" DOUBLE PRECISION,
    "aiInterpretation" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "LeadSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadScore" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT,
    "total" INTEGER NOT NULL,
    "productFit" INTEGER NOT NULL,
    "industryFit" INTEGER NOT NULL,
    "sizeFit" INTEGER NOT NULL,
    "buyingSignal" INTEGER NOT NULL,
    "reachability" INTEGER NOT NULL,
    "explanation" TEXT NOT NULL,
    "verifiedFacts" JSONB,
    "assumptions" JSONB,
    "model" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "targetDescription" TEXT NOT NULL,
    "targetMarketId" TEXT,
    "filters" JSONB,
    "strategy" JSONB,
    "strategyStatus" "FactStatus" NOT NULL DEFAULT 'PENDING',
    "createdById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignLead" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "complianceStatus" "ComplianceStatus",
    "score" INTEGER,
    "variant" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CampaignStep" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "dayOffset" INTEGER NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'EMAIL',
    "name" TEXT NOT NULL,
    "variant" TEXT,
    "instruction" TEXT,
    "stopOnReply" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CampaignStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT,
    "campaignStepId" TEXT,
    "leadId" TEXT NOT NULL,
    "contactId" TEXT,
    "conversationId" TEXT,
    "channel" "Channel" NOT NULL,
    "direction" "MessageDirection" NOT NULL DEFAULT 'OUTBOUND',
    "toAddress" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "variant" TEXT,
    "status" "MessageStatus" NOT NULL DEFAULT 'DRAFT',
    "qualityScore" INTEGER,
    "qualityNotes" JSONB,
    "complianceStatus" "ComplianceStatus",
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "openedAt" TIMESTAMP(3),
    "bouncedAt" TIMESTAMP(3),
    "provider" TEXT,
    "providerMessageId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "contactId" TEXT,
    "channel" "Channel" NOT NULL,
    "subject" TEXT,
    "category" "ReplyCategory",
    "lastMessageAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "category" "ReplyCategory",
    "categoryConfidence" DOUBLE PRECISION,
    "aiSummary" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT,
    "title" TEXT NOT NULL,
    "stage" "OpportunityStage" NOT NULL DEFAULT 'NEW',
    "value" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "probability" INTEGER,
    "expectedCloseAt" TIMESTAMP(3),
    "lostReason" "LostReason",
    "lostNote" TEXT,
    "ownerId" TEXT,
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT,
    "opportunityId" TEXT,
    "campaignId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "Priority" NOT NULL DEFAULT 'MEDIUM',
    "dueAt" TIMESTAMP(3),
    "assigneeId" TEXT,
    "createdByAI" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FollowUp" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "campaignId" TEXT,
    "campaignStepId" TEXT,
    "messageId" TEXT,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" "FollowUpStatus" NOT NULL DEFAULT 'SCHEDULED',
    "skipReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FollowUp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Proposal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "opportunityId" TEXT,
    "number" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'DRAFT',
    "currency" TEXT NOT NULL DEFAULT 'TRY',
    "items" JSONB NOT NULL,
    "totalAmount" DECIMAL(14,2),
    "validUntil" TIMESTAMP(3),
    "deliveryTerms" TEXT,
    "terms" TEXT,
    "missingInfo" TEXT[],
    "pdfStorageKey" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Proposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Competitor" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT,
    "strengths" TEXT[],
    "weaknesses" TEXT[],
    "notes" TEXT,
    "monitoring" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetitorSignal" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "competitorId" TEXT NOT NULL,
    "type" "SignalType" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "sourceUrl" TEXT,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIInsight" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "scopeId" TEXT,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "dataBasis" JSONB NOT NULL,
    "status" "InsightStatus" NOT NULL DEFAULT 'NEW',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ComplianceRecord" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "contactId" TEXT,
    "channel" "Channel" NOT NULL,
    "address" TEXT NOT NULL,
    "contactType" "ContactType" NOT NULL,
    "source" "LeadSourceType" NOT NULL,
    "sourceDate" TIMESTAMP(3),
    "communicationBasis" "CommunicationBasis" NOT NULL DEFAULT 'NONE',
    "consentStatus" "ConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "optOut" BOOLEAN NOT NULL DEFAULT false,
    "suppressed" BOOLEAN NOT NULL DEFAULT false,
    "status" "ComplianceStatus" NOT NULL DEFAULT 'REVIEW_REQUIRED',
    "reasons" TEXT[],
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "lastContactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ComplianceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SuppressionRecord" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "type" "SuppressionType" NOT NULL,
    "value" TEXT NOT NULL,
    "source" "SuppressionSource" NOT NULL,
    "reason" TEXT,
    "leadId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SuppressionRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageRecord" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "credits" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "refType" TEXT,
    "refId" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIUsageLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "estimatedCostUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "durationMs" INTEGER,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIUsageLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "userId" TEXT,
    "actorType" "ActorType" NOT NULL DEFAULT 'USER',
    "action" TEXT NOT NULL,
    "entityType" TEXT,
    "entityId" TEXT,
    "metadata" JSONB,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "plan" "Plan" NOT NULL DEFAULT 'STARTER',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'TRIALING',
    "provider" TEXT NOT NULL DEFAULT 'manual',
    "externalId" TEXT,
    "monthlyCredits" INTEGER NOT NULL DEFAULT 500,
    "leadLimit" INTEGER NOT NULL DEFAULT 500,
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "type" "IntegrationType" NOT NULL,
    "provider" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB,
    "secretsEncrypted" TEXT,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "type" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
    "payload" JSONB NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "progress" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "createdById" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "_CampaignToProduct" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_CampaignToProduct_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Company_slug_key" ON "Company"("slug");

-- CreateIndex
CREATE INDEX "CompanyMember_userId_idx" ON "CompanyMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyMember_companyId_userId_key" ON "CompanyMember"("companyId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "CompanyProfile_companyId_key" ON "CompanyProfile"("companyId");

-- CreateIndex
CREATE INDEX "CompanyFact_companyId_status_idx" ON "CompanyFact"("companyId", "status");

-- CreateIndex
CREATE INDEX "CompanyFact_companyId_key_idx" ON "CompanyFact"("companyId", "key");

-- CreateIndex
CREATE INDEX "CompanyMemory_companyId_status_idx" ON "CompanyMemory"("companyId", "status");

-- CreateIndex
CREATE INDEX "TargetMarket_companyId_isExcluded_idx" ON "TargetMarket"("companyId", "isExcluded");

-- CreateIndex
CREATE UNIQUE INDEX "ProductCategory_companyId_name_key" ON "ProductCategory"("companyId", "name");

-- CreateIndex
CREATE INDEX "Product_companyId_active_idx" ON "Product"("companyId", "active");

-- CreateIndex
CREATE INDEX "Product_companyId_status_idx" ON "Product"("companyId", "status");

-- CreateIndex
CREATE INDEX "Product_companyId_categoryId_idx" ON "Product"("companyId", "categoryId");

-- CreateIndex
CREATE INDEX "ProductDocument_companyId_idx" ON "ProductDocument"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductDocument_productId_documentId_key" ON "ProductDocument"("productId", "documentId");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_companyId_status_idx" ON "KnowledgeDocument"("companyId", "status");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_companyId_kind_idx" ON "KnowledgeDocument"("companyId", "kind");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_companyId_idx" ON "KnowledgeChunk"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_documentId_index_key" ON "KnowledgeChunk"("documentId", "index");

-- CreateIndex
CREATE INDEX "WebsiteAnalysis_companyId_target_createdAt_idx" ON "WebsiteAnalysis"("companyId", "target", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Industry_key_key" ON "Industry"("key");

-- CreateIndex
CREATE INDEX "Lead_companyId_status_idx" ON "Lead"("companyId", "status");

-- CreateIndex
CREATE INDEX "Lead_companyId_fitScore_idx" ON "Lead"("companyId", "fitScore");

-- CreateIndex
CREATE INDEX "Lead_companyId_domain_idx" ON "Lead"("companyId", "domain");

-- CreateIndex
CREATE INDEX "Lead_companyId_normalizedPhone_idx" ON "Lead"("companyId", "normalizedPhone");

-- CreateIndex
CREATE INDEX "Lead_companyId_normalizedName_idx" ON "Lead"("companyId", "normalizedName");

-- CreateIndex
CREATE INDEX "Lead_companyId_city_idx" ON "Lead"("companyId", "city");

-- CreateIndex
CREATE INDEX "Lead_companyId_nextRefreshAt_idx" ON "Lead"("companyId", "nextRefreshAt");

-- CreateIndex
CREATE INDEX "LeadContact_companyId_leadId_idx" ON "LeadContact"("companyId", "leadId");

-- CreateIndex
CREATE INDEX "LeadContact_companyId_email_idx" ON "LeadContact"("companyId", "email");

-- CreateIndex
CREATE INDEX "LeadSource_companyId_leadId_idx" ON "LeadSource"("companyId", "leadId");

-- CreateIndex
CREATE INDEX "LeadSource_companyId_provider_externalId_idx" ON "LeadSource"("companyId", "provider", "externalId");

-- CreateIndex
CREATE INDEX "LeadSignal_companyId_leadId_idx" ON "LeadSignal"("companyId", "leadId");

-- CreateIndex
CREATE INDEX "LeadSignal_companyId_detectedAt_idx" ON "LeadSignal"("companyId", "detectedAt");

-- CreateIndex
CREATE INDEX "LeadScore_companyId_leadId_createdAt_idx" ON "LeadScore"("companyId", "leadId", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_companyId_status_idx" ON "Campaign"("companyId", "status");

-- CreateIndex
CREATE INDEX "CampaignLead_companyId_campaignId_status_idx" ON "CampaignLead"("companyId", "campaignId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignLead_campaignId_leadId_key" ON "CampaignLead"("campaignId", "leadId");

-- CreateIndex
CREATE INDEX "CampaignStep_companyId_idx" ON "CampaignStep"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "CampaignStep_campaignId_order_variant_key" ON "CampaignStep"("campaignId", "order", "variant");

-- CreateIndex
CREATE INDEX "Message_companyId_status_idx" ON "Message"("companyId", "status");

-- CreateIndex
CREATE INDEX "Message_companyId_campaignId_idx" ON "Message"("companyId", "campaignId");

-- CreateIndex
CREATE INDEX "Message_companyId_leadId_idx" ON "Message"("companyId", "leadId");

-- CreateIndex
CREATE INDEX "Message_providerMessageId_idx" ON "Message"("providerMessageId");

-- CreateIndex
CREATE INDEX "Conversation_companyId_leadId_idx" ON "Conversation"("companyId", "leadId");

-- CreateIndex
CREATE INDEX "Conversation_companyId_lastMessageAt_idx" ON "Conversation"("companyId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "ConversationMessage_companyId_conversationId_receivedAt_idx" ON "ConversationMessage"("companyId", "conversationId", "receivedAt");

-- CreateIndex
CREATE INDEX "Opportunity_companyId_stage_idx" ON "Opportunity"("companyId", "stage");

-- CreateIndex
CREATE INDEX "Opportunity_companyId_leadId_idx" ON "Opportunity"("companyId", "leadId");

-- CreateIndex
CREATE INDEX "Task_companyId_status_dueAt_idx" ON "Task"("companyId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "Task_companyId_assigneeId_idx" ON "Task"("companyId", "assigneeId");

-- CreateIndex
CREATE INDEX "FollowUp_status_scheduledAt_idx" ON "FollowUp"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "FollowUp_companyId_leadId_idx" ON "FollowUp"("companyId", "leadId");

-- CreateIndex
CREATE INDEX "Proposal_companyId_status_idx" ON "Proposal"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Proposal_companyId_number_key" ON "Proposal"("companyId", "number");

-- CreateIndex
CREATE INDEX "Competitor_companyId_idx" ON "Competitor"("companyId");

-- CreateIndex
CREATE INDEX "CompetitorSignal_companyId_detectedAt_idx" ON "CompetitorSignal"("companyId", "detectedAt");

-- CreateIndex
CREATE INDEX "AIInsight_companyId_scope_status_idx" ON "AIInsight"("companyId", "scope", "status");

-- CreateIndex
CREATE INDEX "ComplianceRecord_companyId_status_idx" ON "ComplianceRecord"("companyId", "status");

-- CreateIndex
CREATE INDEX "ComplianceRecord_companyId_leadId_idx" ON "ComplianceRecord"("companyId", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX "ComplianceRecord_companyId_channel_address_key" ON "ComplianceRecord"("companyId", "channel", "address");

-- CreateIndex
CREATE INDEX "SuppressionRecord_type_value_idx" ON "SuppressionRecord"("type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "SuppressionRecord_companyId_type_value_key" ON "SuppressionRecord"("companyId", "type", "value");

-- CreateIndex
CREATE INDEX "UsageRecord_companyId_createdAt_idx" ON "UsageRecord"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageRecord_companyId_operation_idx" ON "UsageRecord"("companyId", "operation");

-- CreateIndex
CREATE INDEX "AIUsageLog_companyId_createdAt_idx" ON "AIUsageLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AIUsageLog_createdAt_idx" ON "AIUsageLog"("createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_createdAt_idx" ON "AuditLog"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_companyId_key" ON "Subscription"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Integration_companyId_type_provider_key" ON "Integration"("companyId", "type", "provider");

-- CreateIndex
CREATE INDEX "Job_companyId_type_createdAt_idx" ON "Job"("companyId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "Job_status_createdAt_idx" ON "Job"("status", "createdAt");

-- CreateIndex
CREATE INDEX "_CampaignToProduct_B_index" ON "_CampaignToProduct"("B");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMember" ADD CONSTRAINT "CompanyMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyProfile" ADD CONSTRAINT "CompanyProfile_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyFact" ADD CONSTRAINT "CompanyFact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyFact" ADD CONSTRAINT "CompanyFact_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "WebsiteAnalysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyMemory" ADD CONSTRAINT "CompanyMemory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TargetMarket" ADD CONSTRAINT "TargetMarket_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ProductCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductDocument" ADD CONSTRAINT "ProductDocument_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductDocument" ADD CONSTRAINT "ProductDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAnalysis" ADD CONSTRAINT "WebsiteAnalysis_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Industry" ADD CONSTRAINT "Industry_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_industryId_fkey" FOREIGN KEY ("industryId") REFERENCES "Industry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadContact" ADD CONSTRAINT "LeadContact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadContact" ADD CONSTRAINT "LeadContact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSource" ADD CONSTRAINT "LeadSource_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSource" ADD CONSTRAINT "LeadSource_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSignal" ADD CONSTRAINT "LeadSignal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSignal" ADD CONSTRAINT "LeadSignal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadScore" ADD CONSTRAINT "LeadScore_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadScore" ADD CONSTRAINT "LeadScore_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadScore" ADD CONSTRAINT "LeadScore_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_targetMarketId_fkey" FOREIGN KEY ("targetMarketId") REFERENCES "TargetMarket"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignLead" ADD CONSTRAINT "CampaignLead_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignStep" ADD CONSTRAINT "CampaignStep_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CampaignStep" ADD CONSTRAINT "CampaignStep_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_campaignStepId_fkey" FOREIGN KEY ("campaignStepId") REFERENCES "CampaignStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "LeadContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "LeadContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_campaignStepId_fkey" FOREIGN KEY ("campaignStepId") REFERENCES "CampaignStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FollowUp" ADD CONSTRAINT "FollowUp_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Proposal" ADD CONSTRAINT "Proposal_opportunityId_fkey" FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Competitor" ADD CONSTRAINT "Competitor_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorSignal" ADD CONSTRAINT "CompetitorSignal_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetitorSignal" ADD CONSTRAINT "CompetitorSignal_competitorId_fkey" FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIInsight" ADD CONSTRAINT "AIInsight_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ComplianceRecord" ADD CONSTRAINT "ComplianceRecord_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "LeadContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SuppressionRecord" ADD CONSTRAINT "SuppressionRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UsageRecord" ADD CONSTRAINT "UsageRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIUsageLog" ADD CONSTRAINT "AIUsageLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CampaignToProduct" ADD CONSTRAINT "_CampaignToProduct_A_fkey" FOREIGN KEY ("A") REFERENCES "Campaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "_CampaignToProduct" ADD CONSTRAINT "_CampaignToProduct_B_fkey" FOREIGN KEY ("B") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────
-- El ile eklenen: bilgi bankası tam metin arama indeksi (Prisma ifade indekslerini temsil edemez)
-- Sorgu tarafı src/server/knowledge/search.ts içinde aynı ifadeyi kullanır.
CREATE INDEX "KnowledgeChunk_content_fts_idx" ON "KnowledgeChunk" USING GIN (to_tsvector('simple', "content"));
