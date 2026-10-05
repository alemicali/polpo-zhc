export type AppServiceKind = "frontend" | "backend" | "worker" | "database";
export type AppEnvironment = "development" | "preview" | "staging" | "production";
export type AppDomainRecordType = "A" | "AAAA" | "CNAME" | "TXT";

export function normalizeAppTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ");
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

export interface AppService {
  id: string;
  name: string;
  kind: AppServiceKind;
  command: string;
  cwd?: string;
  port?: number;
  healthPath?: string;
  publicUrl?: string;
  autoStart?: boolean;
}

export interface AppDeploymentRun {
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
}

export interface AppDeployment {
  id: string;
  name: string;
  environment: AppEnvironment;
  command: string;
  cwd?: string;
  provider?: string;
  url?: string;
  branch?: string;
  lastRun?: AppDeploymentRun;
}

export interface AppDomainRecord {
  type: AppDomainRecordType;
  name: string;
  value: string;
}

export interface AppDomainVerification {
  status: "unchecked" | "valid" | "invalid";
  checkedAt?: string;
  details?: string[];
  httpOk?: boolean;
}

export interface AppDomain {
  id: string;
  hostname: string;
  environment: AppEnvironment;
  deploymentId?: string;
  expectedRecords: AppDomainRecord[];
  verification: AppDomainVerification;
}

export interface RegisteredApp {
  id: string;
  name: string;
  slug: string;
  description?: string;
  localPath: string;
  repository?: {
    url: string;
    branch?: string;
  };
  framework?: string;
  screenshotUpdatedAt?: string;
  tags: string[];
  services: AppService[];
  deployments: AppDeployment[];
  domains: AppDomain[];
  createdAt: string;
  updatedAt: string;
}

export type CreateRegisteredApp = Omit<RegisteredApp, "id" | "createdAt" | "updatedAt"> & { id?: string };

export interface AppRegistryStore {
  list(): Promise<RegisteredApp[]>;
  get(id: string): Promise<RegisteredApp | null>;
  create(input: CreateRegisteredApp): Promise<RegisteredApp>;
  update(id: string, input: Partial<Omit<RegisteredApp, "id" | "createdAt">>): Promise<RegisteredApp | null>;
  delete(id: string): Promise<boolean>;
}

export interface AppRuntimeStatus {
  key: string;
  kind: "service" | "deployment";
  appId: string;
  resourceId: string;
  status: "stopped" | "starting" | "running" | "succeeded" | "failed" | "cancelled";
  pid?: number;
  startedAt?: string;
  finishedAt?: string;
  exitCode?: number;
  error?: string;
  logs: AppRuntimeLog[];
}

export interface AppRuntimeLog {
  seq: number;
  at: string;
  stream: "stdout" | "stderr" | "system";
  text: string;
}
