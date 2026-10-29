// Response shapes, matched to the real backend routes in
// src/api/routes.js. Kept loose (optional fields, index signatures) where
// the backend itself is loose (JSONB columns, provider-shaped objects) —
// a stricter type here would just be a guess this file can't verify.

export type HealthResponse = {
  status: 'operational' | 'degraded';
  timestamp: string;
  database: { configured: boolean; connected: boolean; error: string | null };
  queue: Record<string, number> | null;
  imageQueue: Record<string, number> | null;
  ai: {
    provider: string;
    model: string | null;
    keyConfigured: boolean | null;
    isMock: boolean;
    verification: AiVerification | null;
  };
  crawler: { configured: boolean; headless: boolean; timeoutMs: number };
  imageStorage: { configured: boolean; root: string; writable: boolean; error?: string };
  proxy: { configured: boolean; poolSize: number };
};

export type AiVerification =
  | { status: 'MOCK'; provider: string; checkedAt: string }
  | { status: 'NOT_CONFIGURED'; checkedAt: string }
  | { status: 'CONNECTED'; provider: string; model: string; latencyMs: number; checkedAt: string }
  | { status: 'ERROR'; errorType: string; errorMessage: string; latencyMs: number; checkedAt: string };

export type DashboardResponse = {
  totalProducts: number;
  crawlQueue: Record<string, number>;
  imageQueue: Record<string, number>;
  aiReview: { pendingExceptions: number; pendingStaging: number };
  sources: { total: number; blocked: number; blockedSources: string[] };
};

export type ProductListItem = Record<string, any>;

export type ProductListResponse = {
  products: ProductListItem[];
  total: number;
  limit: number;
  offset: number;
};

export type ProductDetailResponse = {
  product: Record<string, any>;
  images: ImageReference[];
  aiExceptions: ValidationException[];
};

export type ImageReference = {
  id: number;
  imageId: number;
  itemNumber: string;
  sourceName: string;
  sourceUrl: string;
  role: string;
  isPrimary: boolean;
  fetchedAt: string;
  image?: ImageRecord;
};

export type ImageRecord = {
  id: number;
  contentHash: string;
  perceptualHash: string | null;
  format: string;
  width: number;
  height: number;
  byteSize: number;
  storagePath: string;
  firstSeenSourceUrl: string;
};

export type ValidationException = {
  id: number;
  itemNumber: string;
  fieldName: string;
  currentValue: string | null;
  suggestedValue: string | null;
  confidence: number;
  reason: string;
  provider: string;
  status: 'pending_review' | 'approved' | 'rejected';
  reviewer: string | null;
  reviewedAt: string | null;
  createdAt: string;
};

// Matches staging-repository.js's fromRow() exactly — camelCase, not the
// raw DB column names. Getting this wrong silently renders blank fields
// instead of throwing, which is exactly what happened here once already.
export type StagingRecord = {
  id: number;
  itemNumber: string;
  runId: string;
  sourceSite: string;
  sourceUrl: string;
  rawExtracted: Record<string, any>;
  normalized: Record<string, any>;
  aiMetadata: Record<string, any>;
  status: 'pending_review' | 'approved' | 'rejected';
  reviewer: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  promotedAt: string | null;
  createdAt: string;
};

export type QueueResponse = {
  crawlQueue: Record<string, number>;
  imageQueue: Record<string, number>;
  recentDeadLetter: Array<Record<string, any>>;
};

export type CrawlJob = Record<string, any>;

export type ProxyStatusResponse = {
  configured: boolean;
  message: string | null;
  poolSize: number;
  proxies: Array<{
    id: string;
    tier?: string;
    status: 'active' | 'cooling_down' | 'ejected';
    successCount: number;
    failureCount: number;
    successRate: number | null;
    avgLatencyMs: number | null;
    blockCount: number;
    consecutiveFailures: number;
    cooldownUntil: string | null;
  }>;
};

export type SourceStatus = {
  sourceName: string;
  compliance: Record<string, any> | null;
  lastAttempted: { status: string; errorType: string | null; errorMessage: string | null; at: string } | null;
};

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'blocked';

export type StageEntry = {
  status: StageStatus;
  startedAt: string | null;
  completedAt: string | null;
  detail: Record<string, any> | null;
};

export type PipelineRun = {
  id: string;
  itemNumber: string;
  sourceUrl: string;
  mode: 'demo' | 'live';
  status: 'running' | 'awaiting_approval' | 'processing' | 'completed' | 'failed' | 'rejected';
  stageOrder: string[];
  stages: Record<string, StageEntry>;
  stagingId: number | null;
  createdAt: string;
  updatedAt: string;
  result: Record<string, any> | null;
};

export type PipelineLogEntry = {
  ts: string;
  level: 'info' | 'error';
  stage: string;
  message: string;
};

export type PipelineListItem = {
  id: string;
  itemNumber: string;
  sourceUrl: string;
  mode: 'demo' | 'live';
  status: string;
  createdAt: string;
  updatedAt: string;
};
