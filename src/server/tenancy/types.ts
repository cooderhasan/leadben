import type { MemberRole } from "@prisma/client";

export interface TenantContext {
  userId: string;
  companyId: string;
  role: MemberRole;
  isPlatformAdmin: boolean;
}

export interface UserContext {
  userId: string;
  email: string;
  name: string;
  isPlatformAdmin: boolean;
  sessionId: string;
  activeCompanyId: string | null;
}
