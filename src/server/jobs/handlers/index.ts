import type { JobHandler, JobPayloads, JobType } from "../types";
import { analyzeWebsiteJob, onWebsiteAnalyzeFailure } from "./website-analyze";
import { ingestDocumentJob, onDocumentIngestFailure } from "./document-ingest";
import { searchLeadsJob, onLeadSearchFailure } from "./lead-search";
import { enrichLeadJob, onLeadEnrichFailure } from "./lead-enrich";
import { scoreLeadsJob, onLeadScoreFailure } from "./lead-score";
import { findEmailsJob } from "./lead-find-email";
import { findWebsitesJob, onFindWebsiteFailure } from "./lead-find-website";
import { prepareLeadsJob, onPrepareFailure } from "./lead-prepare";
import { listImportJob, onListImportFailure } from "./lead-list-import";
import {
  campaignMessagesJob,
  campaignSendJob,
  campaignStrategyJob,
  onCampaignMessagesFailure,
  onCampaignStrategyFailure,
} from "./campaign";
import {
  classifyReplyJob,
  competitorScanJob,
  followUpRunJob,
  onProposalDraftFailure,
  proposalDraftJob,
  sendMessageJob,
  webhookDeliverJob,
} from "./conversation";

type Registry = {
  [K in JobType]: {
    run: JobHandler<K>;
    /** Son deneme de başarısız olduğunda çağrılır (ör. kredi iadesi, durum güncelleme). */
    onFailure?: (payload: JobPayloads[K], error: string) => Promise<void>;
  };
};

export const handlers: Registry = {
  "website.analyze": { run: analyzeWebsiteJob, onFailure: onWebsiteAnalyzeFailure },
  "document.ingest": { run: ingestDocumentJob, onFailure: onDocumentIngestFailure },
  "lead.search": { run: searchLeadsJob, onFailure: onLeadSearchFailure },
  "lead.enrich": { run: enrichLeadJob, onFailure: onLeadEnrichFailure },
  "lead.score": { run: scoreLeadsJob, onFailure: onLeadScoreFailure },
  "lead.find_email": { run: findEmailsJob },
  "lead.find_website": { run: findWebsitesJob, onFailure: onFindWebsiteFailure },
  "lead.prepare": { run: prepareLeadsJob, onFailure: onPrepareFailure },
  "lead.list_import": { run: listImportJob, onFailure: onListImportFailure },
  "campaign.strategy": { run: campaignStrategyJob, onFailure: onCampaignStrategyFailure },
  "campaign.generate_messages": { run: campaignMessagesJob, onFailure: onCampaignMessagesFailure },
  "campaign.send": { run: campaignSendJob },
  "conversation.classify": { run: classifyReplyJob },
  "message.send": { run: sendMessageJob },
  "followup.run": { run: followUpRunJob },
  "proposal.draft": { run: proposalDraftJob, onFailure: onProposalDraftFailure },
  "competitor.scan": { run: competitorScanJob },
  "webhook.deliver": { run: webhookDeliverJob },
};
