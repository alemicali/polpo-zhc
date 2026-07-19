import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import {
  Activity, AppWindow, ArrowLeft, ChevronRight, Code2, ExternalLink, Globe2, Loader2,
  LayoutGrid, LayoutList, MoreHorizontal, Play, Plus, RefreshCw, RotateCw, Save, Search, Server, Settings2, Square, Tag, Trash2, UploadCloud,
  X, XCircle, FolderOpen, GitBranch, ImagePlus, Power, PowerOff,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { apiUrl, config } from "@/lib/config";
import { useApps, type AppDeployment, type AppDomain, type AppEnvironment, type AppInput, type AppRuntime, type AppService, type RegisteredApp } from "@/hooks/use-apps";

const emptyApp = (): AppInput => ({ name: "", slug: "", description: "", localPath: "", tags: [], services: [], deployments: [], domains: [] });
const makeId = (prefix: string) => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
type AppResourceSelection = { kind: "service" | "deployment" | "domain"; id: string };
type AppCoverTarget = { url: string; service?: AppService; status?: AppRuntime["status"] };
type AppRegistryView = "cards" | "list";
const APP_REGISTRY_VIEW_KEY = "polpo:apps:view";

export function AppsPage() {
  const { appId } = useParams();
  const api = useApps(appId);
  if (appId) return <AppDetail appId={appId} api={api} />;
  return <AppRegistry api={api} />;
}

function AppRegistry({ api }: { api: ReturnType<typeof useApps> }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [selectedTags, setSelectedTags] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<AppRegistryView>(() => {
    if (typeof window === "undefined") return "cards";
    return localStorage.getItem(APP_REGISTRY_VIEW_KEY) === "list" ? "list" : "cards";
  });
  useEffect(() => { localStorage.setItem(APP_REGISTRY_VIEW_KEY, view); }, [view]);
  const allTags = useMemo(() => {
    const tags = new Map<string, string>();
    for (const tag of api.apps.flatMap((app) => app.tags)) {
      const trimmed = tag.trim();
      if (trimmed) tags.set(trimmed.toLocaleLowerCase(), tags.get(trimmed.toLocaleLowerCase()) ?? trimmed);
    }
    return [...tags.values()].sort((left, right) => left.localeCompare(right));
  }, [api.apps]);
  const filtered = useMemo(() => {
    const value = search.trim().toLowerCase();
    return api.apps.filter((app) => {
      if (value && ![app.name, app.slug, app.description, app.framework, app.localPath, ...app.tags].some((part) => part?.toLowerCase().includes(value))) return false;
      if (selectedTags.size > 0) {
        const appTags = new Set(app.tags.map((tag) => tag.toLocaleLowerCase()));
        if (![...selectedTags].some((tag) => appTags.has(tag.toLocaleLowerCase()))) return false;
      }
      return true;
    });
  }, [api.apps, search, selectedTags]);
  const toggleTag = (tag: string) => setSelectedTags((current) => {
    const next = new Set(current);
    if (next.has(tag)) next.delete(tag); else next.add(tag);
    return next;
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="shrink-0 border-b border-border/70 px-5 py-4 lg:px-6">
        <div className="flex items-start justify-between gap-4">
          <div><h1 className="text-lg font-semibold">Apps</h1><p className="mt-0.5 text-xs text-muted-foreground">Build, preview and ship your projects.</p></div>
          <AppEditor mode="create" onSave={async (input) => { const app = await api.create(input); navigate(`/apps/${app.id}`); }} />
        </div>
        <div className="mt-4 flex items-center gap-2">
          <div className="relative min-w-0 flex-1 sm:max-w-sm">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects" className="h-8 bg-muted/20 pl-8 shadow-none" />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="outline" size="sm" className={cn("h-8", selectedTags.size > 0 && "border-primary/40 bg-primary/10 text-primary")} disabled={allTags.length === 0}>
                <Tag className="h-3.5 w-3.5" />Categories{selectedTags.size > 0 && <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9px] text-primary-foreground">{selectedTags.size}</span>}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel className="text-xs">Filter by category</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {allTags.map((tag) => <DropdownMenuCheckboxItem key={tag} checked={selectedTags.has(tag)} onCheckedChange={() => toggleTag(tag)} onSelect={(event) => event.preventDefault()} className="text-xs">{tag}</DropdownMenuCheckboxItem>)}
              {selectedTags.size > 0 && <><DropdownMenuSeparator /><DropdownMenuItem className="text-xs" onSelect={() => setSelectedTags(new Set())}>Clear category filters</DropdownMenuItem></>}
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="flex shrink-0 items-center rounded-md border border-border/70 bg-muted/20 p-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant={view === "cards" ? "secondary" : "ghost"} size="icon" className="h-7 w-7 rounded-r-none" aria-label="Card view" aria-pressed={view === "cards"} onClick={() => setView("cards")}>
                  <LayoutGrid className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Card view</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant={view === "list" ? "secondary" : "ghost"} size="icon" className="h-7 w-7 rounded-l-none" aria-label="List view" aria-pressed={view === "list"} onClick={() => setView("list")}>
                  <LayoutList className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>List view</TooltipContent>
            </Tooltip>
          </div>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void api.refetch()} aria-label="Refresh apps"><RefreshCw className="h-3.5 w-3.5" /></Button>
        </div>
        {selectedTags.size > 0 && <div className="mt-2 flex flex-wrap items-center gap-1.5"><span className="mr-1 text-[10px] text-muted-foreground">{filtered.length} of {api.apps.length}</span>{[...selectedTags].map((tag) => <button key={tag} type="button" onClick={() => toggleTag(tag)} className="inline-flex h-6 items-center gap-1 rounded-md border border-border/70 bg-muted/30 px-2 text-[10px] text-foreground hover:bg-muted"><Tag className="h-3 w-3 text-muted-foreground" />{tag}<X className="h-3 w-3 text-muted-foreground" /></button>)}</div>}
      </div>
      {api.isLoading ? <CenteredLoader /> : api.error ? <Empty icon={XCircle} title="Apps unavailable" detail={api.error} /> : filtered.length === 0 ? (
        <Empty icon={AppWindow} title={api.apps.length ? "No matching apps" : "No apps yet"} detail="Add a local project to manage development, previews and delivery." />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-5 lg:p-6">
          {view === "cards"
            ? <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-4">
                {filtered.map((app) => <AppProjectCard key={app.id} app={app} api={api} onOpen={() => navigate(`/apps/${app.id}`)} />)}
              </div>
            : <div className="overflow-hidden rounded-md border border-border/70 bg-background divide-y divide-border/60">
                {filtered.map((app) => <AppProjectListRow key={app.id} app={app} api={api} onOpen={() => navigate(`/apps/${app.id}`)} />)}
              </div>}
        </div>
      )}
    </div>
  );
}

function AppProjectListRow({ app, api, onOpen }: { app: RegisteredApp; api: ReturnType<typeof useApps>; onOpen: () => void }) {
  const navigate = useNavigate();
  const screenshot = useAppScreenshot(app);
  const running = app.runtime.filter((item) => item.kind === "service" && (item.status === "running" || item.status === "starting")).length;
  const failed = app.runtime.some((item) => item.kind === "service" && item.status === "failed");
  const [busy, setBusy] = useState(false);
  const devPreviewUrl = localDevPreviewUrl(app);
  const publishedUrl = publishedAppUrl(app);
  const runLifecycle = async (action: "start" | "stop") => {
    setBusy(true);
    try {
      await api.appAction(app.id, action);
      toast.success(`${app.name} ${action === "start" ? "started" : "stopped"}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <article className="group flex min-w-0 flex-col transition-colors hover:bg-muted/25 sm:flex-row">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left sm:px-4">
        <div className="h-12 w-20 shrink-0 overflow-hidden rounded-md border border-border/70 bg-muted/25">
          {screenshot
            ? <img src={screenshot} alt="" className="h-full w-full object-cover object-top" />
            : <div className="flex h-full items-center justify-center"><AppWindow className="h-4 w-4 text-muted-foreground/40" /></div>}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-semibold">{app.name}</h2>
            {app.tags.slice(0, 2).map((tag) => <Badge key={tag} variant="outline" className="hidden h-5 max-w-24 shrink-0 px-1.5 text-[9px] font-normal md:inline-flex"><span className="truncate">{tag}</span></Badge>)}
            {app.tags.length > 2 && <span className="hidden shrink-0 text-[10px] text-muted-foreground md:inline">+{app.tags.length - 2}</span>}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{app.description || app.localPath}</p>
          <div className="mt-1.5 flex min-w-0 items-center gap-2 text-[10px] text-muted-foreground">
            <span className="flex shrink-0 items-center gap-1.5"><span className={cn("h-1.5 w-1.5 rounded-full", failed ? "bg-destructive" : running ? "bg-emerald-500" : "bg-muted-foreground/40")} />{failed ? "Needs attention" : running ? "Active" : "Stopped"}</span>
            <span className="text-border">/</span>
            <span className="shrink-0">{publishedUrl ? "Published" : "Not published"}</span>
            {app.framework && <><span className="hidden text-border lg:inline">/</span><span className="hidden truncate lg:inline">{app.framework}</span></>}
          </div>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" />
      </button>
      <div className="flex min-h-11 shrink-0 items-center gap-1 border-t border-border/60 px-2.5 py-1.5 sm:border-l sm:border-t-0">
        {running > 0
          ? <CardAction label="Stop development app" text="Stop" icon={PowerOff} disabled={busy} onClick={() => void runLifecycle("stop")} />
          : app.services.length > 0
            ? <CardAction label="Start development app" text="Start" icon={Power} disabled={busy} onClick={() => void runLifecycle("start")} />
            : null}
        {devPreviewUrl && <CardAction label="Open active dev preview" text="Preview" icon={AppWindow} onClick={() => navigate(`/browser?url=${encodeURIComponent(devPreviewUrl)}`)} />}
        <CardAction label="Open code" text="Code" icon={Code2} onClick={() => navigate(`/browser?surface=code&cwd=${encodeURIComponent(app.localPath)}${devPreviewUrl ? `&url=${encodeURIComponent(devPreviewUrl)}` : ""}`)} />
        <div className="ml-auto flex items-center gap-0.5 sm:ml-1">
          {publishedUrl && <CardLink label="Open published app" icon={ExternalLink} href={publishedUrl.startsWith("http") ? publishedUrl : `https://${publishedUrl}`} />}
          {app.repository?.url && <CardLink label="Open repository" icon={GitBranch} href={app.repository.url} />}
        </div>
      </div>
    </article>
  );
}

function AppProjectCard({ app, api, onOpen }: { app: RegisteredApp; api: ReturnType<typeof useApps>; onOpen: () => void }) {
  const navigate = useNavigate();
  const screenshot = useAppScreenshot(app);
  const running = app.runtime.filter((item) => item.kind === "service" && (item.status === "running" || item.status === "starting")).length;
  const failed = app.runtime.some((item) => item.kind === "service" && item.status === "failed");
  const [busy, setBusy] = useState(false);
  const devPreviewUrl = localDevPreviewUrl(app);
  const publishedUrl = publishedAppUrl(app);
  const status = failed ? "Error" : running > 0 ? "Active" : "Stopped";
  return (
    <article className="group min-w-0 overflow-hidden rounded-md border border-border/70 bg-background transition-[border-color,box-shadow] hover:border-foreground/25 hover:shadow-sm">
      <button type="button" onClick={onOpen} className="block w-full text-left">
        <div className="relative aspect-[16/9] overflow-hidden border-b border-border/60 bg-muted/25">
          {screenshot ? <img src={screenshot} alt={`${app.name} preview`} className="h-full w-full object-cover object-top transition-transform duration-300 group-hover:scale-[1.015]" /> : <div className="flex h-full flex-col items-center justify-center text-muted-foreground"><AppWindow className="h-7 w-7 opacity-30" /><span className="mt-2 text-[11px]">No preview yet</span></div>}
        </div>
        <div className="p-4">
          <div className="flex min-w-0 items-center gap-3"><h2 className="truncate text-sm font-semibold">{app.name}</h2><ArrowLeft className="ml-auto h-3.5 w-3.5 shrink-0 rotate-180 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" /></div>
          <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">{app.description || "No description"}</p>
          {app.tags.length > 0 && <div className="mt-2 flex min-w-0 items-center gap-1 overflow-hidden">{app.tags.slice(0, 3).map((tag) => <Badge key={tag} variant="outline" className="h-5 max-w-28 shrink-0 px-1.5 text-[9px] font-normal"><span className="truncate">{tag}</span></Badge>)}{app.tags.length > 3 && <span className="shrink-0 text-[10px] text-muted-foreground">+{app.tags.length - 3}</span>}</div>}
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className={cn("h-1.5 w-1.5 rounded-full", failed ? "bg-destructive" : running ? "bg-emerald-500" : "bg-muted-foreground/40")} />{failed ? "Needs attention" : `Development ${status.toLowerCase()}`}</span>
            <span className="text-border">/</span>
            <span>{publishedUrl ? "Published" : "Not published"}</span>
            {app.framework && <><span className="text-border">/</span><span>{app.framework}</span></>}
          </div>
        </div>
      </button>
      <div className="flex min-h-11 items-center gap-1 border-t border-border/60 px-2.5 py-1.5">
        {running > 0
          ? <CardAction label="Stop development app" text="Stop" icon={PowerOff} disabled={busy} onClick={async () => { setBusy(true); try { await api.appAction(app.id, "stop"); toast.success(`${app.name} stopped`); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }} />
          : app.services.length > 0
            ? <CardAction label="Start development app" text="Start" icon={Power} disabled={busy} onClick={async () => { setBusy(true); try { await api.appAction(app.id, "start"); toast.success(`${app.name} started`); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }} />
            : null}
        {devPreviewUrl && <CardAction label="Open active dev preview" text="Preview" icon={AppWindow} onClick={() => navigate(`/browser?url=${encodeURIComponent(devPreviewUrl)}`)} />}
        <CardAction label="Open code" text="Code" icon={Code2} onClick={() => navigate(`/browser?surface=code&cwd=${encodeURIComponent(app.localPath)}${devPreviewUrl ? `&url=${encodeURIComponent(devPreviewUrl)}` : ""}`)} />
        <div className="ml-auto flex items-center gap-0.5">
          {publishedUrl && <CardLink label="Open published app" icon={ExternalLink} href={publishedUrl.startsWith("http") ? publishedUrl : `https://${publishedUrl}`} />}
          {app.repository?.url && <CardLink label="Open repository" icon={GitBranch} href={app.repository.url} />}
        </div>
      </div>
    </article>
  );
}

function AppDetail({ appId, api }: { appId: string; api: ReturnType<typeof useApps> }) {
  const navigate = useNavigate();
  const app = api.app;
  const [busy, setBusy] = useState<string | null>(null);
  const [section, setSection] = useState("overview");
  const [selection, setSelection] = useState<AppResourceSelection | null>(null);
  const run = async (key: string, action: () => Promise<unknown>, message?: string) => {
    setBusy(key);
    try { await action(); if (message) toast.success(message); }
    catch (error) { toast.error(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };
  if (api.isLoading && !app) return <CenteredLoader />;
  if (!app) return <Empty icon={XCircle} title="App not found" detail={api.error ?? `No app matches ${appId}`} action={<Button onClick={() => navigate("/apps")}>Back to apps</Button>} />;
  const save = (next: AppInput) => api.update(app.id, next);
  const previewUrl = localDevPreviewUrl(app);
  const coverTarget = appCoverTarget(app);
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <div className="grid shrink-0 grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-border/70 px-5 py-4 sm:flex lg:px-6">
        <Button variant="ghost" size="icon" onClick={() => navigate("/apps")} aria-label="Back to apps"><ArrowLeft className="h-4 w-4" /></Button>
        <div className="min-w-0 flex-1 sm:basis-auto"><p className="text-[10px] font-medium text-muted-foreground">Apps / {app.slug}</p><h1 className="mt-0.5 truncate text-base font-semibold">{app.name}</h1></div>
        <div className="col-start-3 flex items-center gap-2 sm:ml-0">
          <AppEditor mode="edit" app={app} onSave={save} />
        </div>
      </div>
      <Tabs value={section} onValueChange={(value) => { setSection(value); setSelection(null); }} className="flex min-h-0 flex-1 flex-col gap-0">
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border/70 px-4">
          <div className="min-w-0 flex-1 overflow-x-auto scrollbar-none">
            <TabsList className="h-8 w-max shrink-0 justify-start">
              <TabsTrigger className="h-6 flex-none px-2 text-[11px]" value="overview">Overview</TabsTrigger>
              <TabsTrigger className="h-6 flex-none px-2 text-[11px]" value="services">Services <Count value={app.services.length} /></TabsTrigger>
              <TabsTrigger className="h-6 flex-none px-2 text-[11px]" value="deployments">Deployments <Count value={app.deployments.length} /></TabsTrigger>
              <TabsTrigger className="h-6 flex-none px-2 text-[11px]" value="domains">Domains <Count value={app.domains.length} /></TabsTrigger>
              <TabsTrigger className="h-6 flex-none px-2 text-[11px]" value="settings">Settings</TabsTrigger>
            </TabsList>
          </div>
        </div>
        <TabsContent value="overview" className="mt-0 min-h-0 flex-1 overflow-auto">
          <AppOverview app={app} previewUrl={previewUrl} coverTarget={coverTarget} busy={busy} run={run} api={api} />
        </TabsContent>
        <TabsContent value="services" className="mt-0 min-h-0 flex-1">
          {selection?.kind === "service" && app.services.some((item) => item.id === selection.id)
            ? <ServiceDetail app={app} service={app.services.find((item) => item.id === selection.id)!} runtime={app.runtime.find((item) => item.kind === "service" && item.resourceId === selection.id)} busy={busy} run={run} save={save} api={api} onBack={() => setSelection(null)} />
            : <ResourcePanel title="Services" description="Development processes managed for this app." action={<ServiceEditor onSave={(service) => save(toInput({ ...app, services: [...app.services, service] }))} />}>
                {app.services.length ? app.services.map((service) => {
                  const runtime = app.runtime.find((item) => item.kind === "service" && item.resourceId === service.id);
                  return <ServiceRow key={service.id} app={app} service={service} runtime={runtime} busy={busy} run={run} api={api} onOpen={() => setSelection({ kind: "service", id: service.id })} />;
                }) : <EmptyRows text="No services configured" />}
              </ResourcePanel>}
        </TabsContent>
        <TabsContent value="deployments" className="mt-0 min-h-0 flex-1">
          {selection?.kind === "deployment" && app.deployments.some((item) => item.id === selection.id)
            ? <DeploymentDetail app={app} deployment={app.deployments.find((item) => item.id === selection.id)!} runtime={app.runtime.find((item) => item.kind === "deployment" && item.resourceId === selection.id)} busy={busy} run={run} save={save} api={api} onBack={() => setSelection(null)} />
            : <ResourcePanel title="Deployments" description="Repeatable commands for preview, staging and production." action={<DeploymentEditor onSave={(deployment) => save(toInput({ ...app, deployments: [...app.deployments, deployment] }))} />}>
                {app.deployments.length ? app.deployments.map((deployment) => {
                  const runtime = app.runtime.find((item) => item.kind === "deployment" && item.resourceId === deployment.id);
                  const active = runtime?.status === "running" || runtime?.status === "starting";
                  return <ResourceRow key={deployment.id} icon={UploadCloud} title={deployment.name} subtitle={`${deployment.environment}${deployment.provider ? ` · ${deployment.provider}` : ""}`} status={runtime?.status ?? deployment.lastRun?.status} logs={runtime?.logs} onOpen={() => setSelection({ kind: "deployment", id: deployment.id })} actions={<>
                    <IconAction label={active ? "Stop deployment" : "Deploy"} text={active ? "Stop" : "Deploy"} disabled={busy === `deploy:${deployment.id}`} onClick={() => run(`deploy:${deployment.id}`, () => api.deploymentAction(app.id, deployment.id, active ? "stop" : "run"), active ? "Deployment stopped" : "Deployment started")} icon={active ? Square : Play} />
                    {deployment.url && <IconLink href={deployment.url} label="Open deployment" />}
                  </>} />;
                }) : <EmptyRows text="No deployment commands configured" />}
              </ResourcePanel>}
        </TabsContent>
        <TabsContent value="domains" className="mt-0 min-h-0 flex-1">
          {selection?.kind === "domain" && app.domains.some((item) => item.id === selection.id)
            ? <DomainDetail app={app} domain={app.domains.find((item) => item.id === selection.id)!} busy={busy} run={run} save={save} api={api} onBack={() => setSelection(null)} />
            : <ResourcePanel title="Domains" description="Public hostnames, DNS expectations and HTTPS checks." action={<DomainEditor onSave={(domain) => save(toInput({ ...app, domains: [...app.domains, domain] }))} />}>
                {app.domains.length ? app.domains.map((domain) => <ResourceRow key={domain.id} icon={Globe2} title={domain.hostname} subtitle={`${domain.environment} · ${domain.expectedRecords.length} expected DNS records`} status={domain.verification.status} detail={domain.verification.details?.join("\n")} onOpen={() => setSelection({ kind: "domain", id: domain.id })} actions={<>
                  <IconAction label="Verify DNS and HTTPS" text="Verify" disabled={busy === `domain:${domain.id}`} onClick={() => run(`domain:${domain.id}`, () => api.verifyDomain(app.id, domain.id), "Domain verification complete")} icon={RefreshCw} />
                  <IconLink href={`https://${domain.hostname}`} label="Open domain" />
                </>} />) : <EmptyRows text="No domains configured" />}
              </ResourcePanel>}
        </TabsContent>
        <TabsContent value="settings" className="mt-0 min-h-0 flex-1 overflow-auto">
          <AppSettingsPanel
            app={app}
            onSave={save}
            onDelete={async () => { await run("delete", () => api.remove(app.id)); navigate("/apps"); }}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function AppOverview({ app, previewUrl, coverTarget, busy, run, api }: { app: RegisteredApp; previewUrl?: string; coverTarget?: AppCoverTarget; busy: string | null; run: (key: string, action: () => Promise<unknown>, message?: string) => Promise<void>; api: ReturnType<typeof useApps> }) {
  const navigate = useNavigate();
  const live = app.runtime.filter((item) => item.kind === "service" && (item.status === "running" || item.status === "starting"));
  const failed = app.runtime.some((item) => item.kind === "service" && item.status === "failed");
  const active = live.length > 0;
  const screenshot = useAppScreenshot(app);
  const publishedUrl = publishedAppUrl(app);
  const developmentLabel = failed ? "Development error" : active ? "Development running" : "Development stopped";
  return (
    <section className="px-5 py-5 lg:px-6 lg:py-6">
      <div className="grid items-stretch gap-6 lg:grid-cols-[minmax(320px,.9fr)_minmax(340px,1.1fr)] lg:gap-8">
        <div className="group relative aspect-video min-h-48 overflow-hidden rounded-md border border-border/70 bg-muted/20">
          {screenshot ? <img src={screenshot} alt={`${app.name} cover`} className="h-full w-full object-cover object-top" /> : <div className="flex h-full flex-col items-center justify-center px-6 text-center text-muted-foreground"><AppWindow className="h-8 w-8 opacity-30" /><p className="mt-3 text-xs font-medium">No preview captured</p><p className="mt-1 text-[11px]">Start the app or connect a production URL.</p></div>}
        </div>
        <div className="flex min-w-0 flex-col justify-center py-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><span className={cn("h-2 w-2 rounded-full", failed ? "bg-destructive" : active ? "bg-emerald-500" : "bg-muted-foreground/40")} />{developmentLabel}</span>
            <span className="text-border">/</span>
            <span>{publishedUrl ? "Published" : "Not published"}</span>
            {app.framework && <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">{app.framework}</Badge>}
          </div>
          <p className="mt-4 max-w-2xl text-sm leading-6 text-foreground/85">{app.description || "No description yet."}</p>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <Button size="sm" disabled={busy === "app:lifecycle" || app.services.length === 0} onClick={() => run("app:lifecycle", () => api.appAction(app.id, active ? "stop" : "start"), active ? "App stopped" : "App started")}>
              {active ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}{active ? "Stop" : "Start"}
            </Button>
            {previewUrl && <Button size="sm" variant="outline" onClick={() => navigate(`/browser?url=${encodeURIComponent(previewUrl)}`)}><AppWindow className="h-4 w-4" />Preview</Button>}
            <Button size="sm" variant="outline" onClick={() => navigate(`/browser?surface=code&cwd=${encodeURIComponent(app.localPath)}${previewUrl ? `&url=${encodeURIComponent(previewUrl)}` : ""}`)}><Code2 className="h-4 w-4" />Code</Button>
            <CoverCaptureButton app={app} target={coverTarget} hasCover={Boolean(screenshot)} busy={busy === "app:screenshot"} run={run} api={api} />
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-8 w-8" aria-label="More app actions"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {active && <DropdownMenuItem disabled={busy === "app:lifecycle"} onSelect={() => void run("app:lifecycle", () => api.appAction(app.id, "restart"), "App restarted")}><RotateCw className="h-3.5 w-3.5" />Restart</DropdownMenuItem>}
                <DropdownMenuItem onSelect={() => navigate(`/files?path=${encodeURIComponent(app.localPath)}`)}><FolderOpen className="h-3.5 w-3.5" />Open files</DropdownMenuItem>
                {publishedUrl && <DropdownMenuItem asChild><a href={publishedUrl} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5" />Open live app</a></DropdownMenuItem>}
                {app.repository?.url && <DropdownMenuItem asChild><a href={app.repository.url} target="_blank" rel="noreferrer"><GitBranch className="h-3.5 w-3.5" />Open repository</a></DropdownMenuItem>}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </section>
  );
}

function CoverCaptureButton({ app, target, hasCover, busy, run, api }: { app: RegisteredApp; target?: AppCoverTarget; hasCover: boolean; busy: boolean; run: (key: string, action: () => Promise<unknown>, message?: string) => Promise<void>; api: ReturnType<typeof useApps> }) {
  const [promptOpen, setPromptOpen] = useState(false);
  const serviceStopped = Boolean(target?.service && target.status !== "running" && target.status !== "starting");

  const capture = async (keepRunning: boolean) => {
    if (!target) return;
    setPromptOpen(false);
    const service = target.service;
    const wasStopped = Boolean(service && target.status !== "running" && target.status !== "starting");
    await run("app:screenshot", async () => {
      let startedForCapture = false;
      let captured = false;
      try {
        if (service && wasStopped) {
          await api.serviceAction(app.id, service.id, "start");
          startedForCapture = true;
        }
        if (service && target.status !== "running") await waitForAppService(api, app.id, service.id);
        await api.captureScreenshot(app.id, target.url);
        captured = true;
      } finally {
        if (service && startedForCapture && (!keepRunning || !captured)) {
          await api.serviceAction(app.id, service.id, "stop").catch(() => undefined);
        }
      }
    }, wasStopped ? keepRunning ? "App cover updated; service left running" : "App cover updated; service stopped again" : "App cover updated");
  };

  return <>
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={!target || busy}
      title={!target ? "Configure a service URL, port, deployment URL or verified domain first" : undefined}
      onClick={() => serviceStopped ? setPromptOpen(true) : void capture(true)}
    >
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
      {hasCover ? "Update cover" : "Capture cover"}
    </Button>
    <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-xl overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Start {target?.service?.name} to capture the cover?</DialogTitle>
          <DialogDescription>Polpo will start the stopped service, wait until it is reachable, and capture the app cover automatically. Choose what should happen to the service afterward.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 border-y border-border/70 py-3 text-xs text-muted-foreground">
          <div className="min-w-0">
            <span className="block text-[11px] font-medium text-muted-foreground">Command</span>
            <code className="mt-1.5 block max-h-28 min-w-0 overflow-auto whitespace-pre-wrap break-all border border-border/60 bg-muted/30 px-3 py-2 font-mono text-[11px] leading-5 text-foreground">{target?.service?.command}</code>
          </div>
          {target?.service?.port && <div className="mt-3 grid min-w-0 grid-cols-[80px_minmax(0,1fr)] items-center gap-3"><span>Port</span><span className="min-w-0 break-all font-mono text-[11px] text-foreground">:{target.service.port}</span></div>}
        </div>
        <DialogFooter className="min-w-0 gap-2 sm:flex-row sm:flex-wrap sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => setPromptOpen(false)}>Cancel</Button>
          <div className="flex min-w-0 flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
            <Button type="button" variant="outline" className="whitespace-normal" onClick={() => void capture(false)}>Capture and stop</Button>
            <Button type="button" className="whitespace-normal" onClick={() => void capture(true)}>Capture and keep running</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}

async function waitForAppService(api: ReturnType<typeof useApps>, appId: string, serviceId: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastError = "Service did not become reachable";
  while (Date.now() < deadline) {
    try {
      const result = await api.probeService(appId, serviceId);
      if (result.ok) return;
      lastError = result.error || (result.status ? `HTTP ${result.status}` : lastError);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 750));
  }
  throw new Error(`Service did not become ready within 30 seconds: ${lastError}`);
}

function AppSettingsPanel({ app, onSave, onDelete }: { app: RegisteredApp; onSave: (input: AppInput) => Promise<RegisteredApp>; onDelete: () => Promise<void> }) {
  const [value, setValue] = useState<AppInput>(() => toInput(app));
  const [saving, setSaving] = useState(false);
  const original = useMemo(() => JSON.stringify(toInput(app)), [app]);
  const dirty = JSON.stringify(value) !== original;

  useEffect(() => {
    if (!dirty) setValue(toInput(app));
  }, [app.updatedAt, dirty]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const updated = await onSave(value);
      setValue(toInput(updated));
      toast.success("App settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="mx-auto w-full max-w-5xl px-5 py-2 lg:px-6">
      <SettingsSection title="General" description="Name and presentation across the workspace.">
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsField label="Name">
            <Input required value={value.name} onChange={(event) => setValue({ ...value, name: event.target.value })} />
          </SettingsField>
          <SettingsField label="Slug" hint="Used as the stable registry handle.">
            <Input required value={value.slug} onChange={(event) => setValue({ ...value, slug: slugify(event.target.value) })} />
          </SettingsField>
          <SettingsField label="Description" className="sm:col-span-2">
            <Textarea rows={3} value={value.description ?? ""} onChange={(event) => setValue({ ...value, description: event.target.value })} />
          </SettingsField>
          <SettingsField label="Framework">
            <Input placeholder="Next.js" value={value.framework ?? ""} onChange={(event) => setValue({ ...value, framework: event.target.value || undefined })} />
          </SettingsField>
          <SettingsField label="Categories" hint="Use 1-3 high-level labels such as internal, client or public.">
            <AppTagInput value={value.tags} onChange={(tags) => setValue({ ...value, tags })} />
          </SettingsField>
        </div>
      </SettingsSection>

      <SettingsSection title="Project source" description="Local workspace and its upstream repository.">
        <div className="grid gap-4 sm:grid-cols-2">
          <SettingsField label="Local path" hint="Must resolve to an existing directory." className="sm:col-span-2">
            <Input required className="font-mono text-xs" value={value.localPath} onChange={(event) => setValue({ ...value, localPath: event.target.value })} />
          </SettingsField>
          <SettingsField label="Repository URL">
            <Input
              placeholder="https://github.com/org/repo"
              value={value.repository?.url ?? ""}
              onChange={(event) => setValue({
                ...value,
                repository: event.target.value ? { url: event.target.value, branch: value.repository?.branch } : undefined,
              })}
            />
          </SettingsField>
          <SettingsField label="Default branch">
            <Input
              placeholder="main"
              disabled={!value.repository?.url}
              value={value.repository?.branch ?? ""}
              onChange={(event) => setValue({ ...value, repository: value.repository ? { ...value.repository, branch: event.target.value || undefined } : undefined })}
            />
          </SettingsField>
        </div>
      </SettingsSection>

      <SettingsSection title="Registry details" description="Read-only identity and synchronization data.">
        <dl className="divide-y divide-border/60 border-y border-border/60 text-xs">
          <MetadataRow label="App ID" value={app.id} mono />
          <MetadataRow label="Created" value={new Date(app.createdAt).toLocaleString()} />
          <MetadataRow label="Last updated" value={new Date(app.updatedAt).toLocaleString()} />
          <MetadataRow label="Resources" value={`${app.services.length} services · ${app.deployments.length} deployments · ${app.domains.length} domains`} />
        </dl>
      </SettingsSection>

      <div className="grid gap-5 border-t border-destructive/30 py-7 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)] sm:gap-8">
        <div>
          <h2 className="text-sm font-semibold text-destructive">Danger zone</h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">Destructive registry operations.</p>
        </div>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-xl">
            <h3 className="text-sm font-medium">Remove this app</h3>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">Stops managed processes and removes the registry record and cover. Files in <span className="font-mono text-foreground/80">{app.localPath}</span> remain untouched.</p>
          </div>
          <DeleteAppButton app={app} onDelete={onDelete} />
        </div>
      </div>

      <div className="sticky bottom-0 -mx-5 flex min-h-14 items-center justify-end gap-2 border-t border-border/70 bg-background/95 px-5 py-2 backdrop-blur-sm lg:-mx-6 lg:px-6">
        {dirty && <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={() => setValue(toInput(app))}>Discard</Button>}
        <Button type="submit" size="sm" disabled={!dirty || saving}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save changes
        </Button>
      </div>
    </form>
  );
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-5 border-b border-border/70 py-7 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)] sm:gap-8">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function SettingsField({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={cn("block min-w-0 text-xs font-medium", className)}>
      <span className="mb-1.5 block">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[11px] font-normal leading-4 text-muted-foreground">{hint}</span>}
    </label>
  );
}

function AppTagInput({ value, onChange }: { value: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const addDraft = () => {
    const incoming = draft.split(",").map((tag) => tag.trim()).filter(Boolean);
    if (incoming.length === 0) return;
    const known = new Set(value.map((tag) => tag.toLocaleLowerCase()));
    const next = [...value];
    for (const tag of incoming) {
      const key = tag.toLocaleLowerCase();
      if (!known.has(key)) { known.add(key); next.push(tag); }
    }
    onChange(next.sort((left, right) => left.localeCompare(right)));
    setDraft("");
  };
  return <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
    {value.map((tag) => <span key={tag} className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-muted px-2 text-[10px] font-normal text-foreground"><Tag className="h-3 w-3 shrink-0 text-muted-foreground" /><span className="truncate">{tag}</span><button type="button" aria-label={`Remove ${tag}`} className="shrink-0 text-muted-foreground hover:text-foreground" onClick={() => onChange(value.filter((item) => item !== tag))}><X className="h-3 w-3" /></button></span>)}
    <input value={draft} onChange={(event) => setDraft(event.target.value)} onBlur={addDraft} onKeyDown={(event) => { if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addDraft(); } else if (event.key === "Backspace" && !draft && value.length > 0) onChange(value.slice(0, -1)); }} placeholder={value.length ? "Add category" : "internal, client, public"} className="h-6 min-w-24 flex-1 bg-transparent px-1 text-xs outline-none placeholder:text-muted-foreground" />
  </div>;
}

function MetadataRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[140px_minmax(0,1fr)] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn("min-w-0 break-words text-foreground", mono && "font-mono text-[11px]")}>{value}</dd>
    </div>
  );
}

function ResourceDetailShell({ icon: Icon, title, subtitle, status, onBack, actions, logs, children }: { icon: typeof Server; title: string; subtitle: string; status?: string; onBack: () => void; actions: React.ReactNode; logs?: AppRuntime["logs"]; children: React.ReactNode }) {
  return (
    <div className="h-full min-h-0 overflow-auto">
      <div className="flex min-h-14 items-center gap-3 border-b border-border/70 px-4 py-2">
        <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onBack} aria-label="Back to list"><ArrowLeft className="h-4 w-4" /></Button>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-muted-foreground"><Icon className="h-4 w-4" /></div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2"><h2 className="truncate text-sm font-semibold">{title}</h2>{status && <StatusBadge status={status} />}</div>
          <p className="truncate text-[11px] text-muted-foreground">{subtitle}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">{actions}</div>
      </div>
      <div className="mx-auto w-full max-w-5xl px-5 py-6 lg:px-6">
        {children}
        {logs !== undefined && <section className="mt-8 border-t border-border/70 pt-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div><h3 className="text-sm font-semibold">Runtime output</h3><p className="mt-0.5 text-xs text-muted-foreground">Latest output retained for this process.</p></div>
            <Badge variant="outline" className="font-mono text-[10px] font-normal">{logs?.length ?? 0} lines</Badge>
          </div>
          {logs?.length
            ? <pre className="max-h-96 overflow-auto border border-border/70 bg-code p-4 text-[11px] leading-5 text-[var(--ink-inverse)]">{logs.map((line) => `[${new Date(line.at).toLocaleTimeString()}]${line.stream === "stderr" ? " [stderr]" : ""} ${line.text}`).join("\n")}</pre>
            : <div className="border border-dashed border-border/70 px-4 py-8 text-center text-xs text-muted-foreground">No runtime output yet.</div>}
        </section>}
      </div>
    </div>
  );
}

function DetailFields({ children }: { children: React.ReactNode }) {
  return <dl className="divide-y divide-border/60 border-y border-border/60 text-xs">{children}</dl>;
}

function ServiceDetail({ app, service, runtime, busy, run, save, api, onBack }: { app: RegisteredApp; service: AppService; runtime?: AppRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>, message?: string) => Promise<void>; save: (input: AppInput) => Promise<RegisteredApp>; api: ReturnType<typeof useApps>; onBack: () => void }) {
  const active = runtime?.status === "running" || runtime?.status === "starting";
  return <ResourceDetailShell icon={Server} title={service.name} subtitle={`${service.kind} service`} status={runtime?.status ?? "stopped"} onBack={onBack} logs={runtime?.logs ?? []} actions={<>
    <IconAction label={active ? "Stop service" : "Start service"} text={active ? "Stop" : "Start"} disabled={busy === `service:${service.id}`} onClick={() => run(`service:${service.id}`, () => api.serviceAction(app.id, service.id, active ? "stop" : "start"), active ? "Service stopped" : "Service started")} icon={active ? Square : Play} />
    {active && servicePreviewUrl(service) && <IconLink href={servicePreviewUrl(service)!} label="Open service" />}
    <ServiceEditor item={service} triggerNode={<Button type="button" variant="outline" size="sm" className="h-8"><Settings2 className="h-3.5 w-3.5" />Edit</Button>} onSave={(next) => save(toInput({ ...app, services: app.services.map((item) => item.id === next.id ? next : item) }))} />
  </>}>
    <div className="mb-3 flex items-start justify-between gap-4"><div><h3 className="text-sm font-semibold">Configuration</h3><p className="mt-0.5 text-xs text-muted-foreground">How this process starts and becomes reachable.</p></div><RemoveResourceButton name={service.name} label="Remove service" onDelete={async () => { if (active) await api.serviceAction(app.id, service.id, "stop"); await save(toInput({ ...app, services: app.services.filter((item) => item.id !== service.id) })); onBack(); }} /></div>
    <DetailFields>
      <MetadataRow label="Command" value={service.command} mono />
      <MetadataRow label="Working directory" value={service.cwd || "."} mono />
      <MetadataRow label="Kind" value={service.kind} />
      <MetadataRow label="Port" value={service.port ? String(service.port) : "Not configured"} mono />
      <MetadataRow label="Public URL" value={service.publicUrl || "Not configured"} mono />
      <MetadataRow label="Health path" value={service.healthPath || "/"} mono />
      <MetadataRow label="Start with app" value={service.autoStart ? "Yes" : "No"} />
      <MetadataRow label="Process ID" value={runtime?.pid ? String(runtime.pid) : "Not running"} mono />
    </DetailFields>
  </ResourceDetailShell>;
}

function DeploymentDetail({ app, deployment, runtime, busy, run, save, api, onBack }: { app: RegisteredApp; deployment: AppDeployment; runtime?: AppRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>, message?: string) => Promise<void>; save: (input: AppInput) => Promise<RegisteredApp>; api: ReturnType<typeof useApps>; onBack: () => void }) {
  const active = runtime?.status === "running" || runtime?.status === "starting";
  const status = runtime?.status ?? deployment.lastRun?.status ?? "idle";
  return <ResourceDetailShell icon={UploadCloud} title={deployment.name} subtitle={`${deployment.environment}${deployment.provider ? ` · ${deployment.provider}` : ""}`} status={status} onBack={onBack} logs={runtime?.logs ?? []} actions={<>
    <IconAction label={active ? "Stop deployment" : "Run deployment"} text={active ? "Stop" : "Deploy"} disabled={busy === `deploy:${deployment.id}`} onClick={() => run(`deploy:${deployment.id}`, () => api.deploymentAction(app.id, deployment.id, active ? "stop" : "run"), active ? "Deployment stopped" : "Deployment started")} icon={active ? Square : Play} />
    {deployment.url && <IconLink href={deployment.url} label="Open deployment" />}
    <DeploymentEditor item={deployment} triggerNode={<Button type="button" variant="outline" size="sm" className="h-8"><Settings2 className="h-3.5 w-3.5" />Edit</Button>} onSave={(next) => save(toInput({ ...app, deployments: app.deployments.map((item) => item.id === next.id ? next : item) }))} />
  </>}>
    <div className="mb-3 flex items-start justify-between gap-4"><div><h3 className="text-sm font-semibold">Deployment configuration</h3><p className="mt-0.5 text-xs text-muted-foreground">Command, source and latest persisted result.</p></div><RemoveResourceButton name={deployment.name} label="Remove deployment" onDelete={async () => { if (active) await api.deploymentAction(app.id, deployment.id, "stop"); await save(toInput({ ...app, deployments: app.deployments.filter((item) => item.id !== deployment.id) })); onBack(); }} /></div>
    <DetailFields>
      <MetadataRow label="Command" value={deployment.command} mono />
      <MetadataRow label="Environment" value={deployment.environment} />
      <MetadataRow label="Provider" value={deployment.provider || "Custom command"} />
      <MetadataRow label="Branch" value={deployment.branch || app.repository?.branch || "Not configured"} mono />
      <MetadataRow label="Working directory" value={deployment.cwd || "."} mono />
      <MetadataRow label="Published URL" value={deployment.url || "Not configured"} mono />
      <MetadataRow label="Last started" value={deployment.lastRun?.startedAt ? new Date(deployment.lastRun.startedAt).toLocaleString() : "Never"} />
      <MetadataRow label="Last finished" value={deployment.lastRun?.finishedAt ? new Date(deployment.lastRun.finishedAt).toLocaleString() : "Not available"} />
      <MetadataRow label="Exit code" value={deployment.lastRun?.exitCode === undefined ? "Not available" : String(deployment.lastRun.exitCode)} mono />
    </DetailFields>
  </ResourceDetailShell>;
}

function DomainDetail({ app, domain, busy, run, save, api, onBack }: { app: RegisteredApp; domain: AppDomain; busy: string | null; run: (key: string, action: () => Promise<unknown>, message?: string) => Promise<void>; save: (input: AppInput) => Promise<RegisteredApp>; api: ReturnType<typeof useApps>; onBack: () => void }) {
  return <ResourceDetailShell icon={Globe2} title={domain.hostname} subtitle={`${domain.environment} domain`} status={domain.verification.status} onBack={onBack} actions={<>
    <IconAction label="Verify DNS and HTTPS" text="Verify" disabled={busy === `domain:${domain.id}`} onClick={() => run(`domain:${domain.id}`, () => api.verifyDomain(app.id, domain.id), "Domain verification complete")} icon={RefreshCw} />
    <IconLink href={`https://${domain.hostname}`} label="Open domain" />
    <DomainEditor item={domain} triggerNode={<Button type="button" variant="outline" size="sm" className="h-8"><Settings2 className="h-3.5 w-3.5" />Edit</Button>} onSave={(next) => save(toInput({ ...app, domains: app.domains.map((item) => item.id === next.id ? next : item) }))} />
  </>}>
    <div className="mb-3 flex items-start justify-between gap-4"><div><h3 className="text-sm font-semibold">Domain configuration</h3><p className="mt-0.5 text-xs text-muted-foreground">DNS expectations and the latest reachability check.</p></div><RemoveResourceButton name={domain.hostname} label="Remove domain" onDelete={async () => { await save(toInput({ ...app, domains: app.domains.filter((item) => item.id !== domain.id) })); onBack(); }} /></div>
    <DetailFields>
      <MetadataRow label="Hostname" value={domain.hostname} mono />
      <MetadataRow label="Environment" value={domain.environment} />
      <MetadataRow label="Deployment ID" value={domain.deploymentId || "Not linked"} mono />
      <MetadataRow label="Last checked" value={domain.verification.checkedAt ? new Date(domain.verification.checkedAt).toLocaleString() : "Never"} />
      <MetadataRow label="HTTPS" value={domain.verification.httpOk === undefined ? "Not checked" : domain.verification.httpOk ? "Reachable" : "Unavailable"} />
    </DetailFields>
    <section className="mt-8"><h3 className="text-sm font-semibold">Expected DNS records</h3><p className="mt-0.5 text-xs text-muted-foreground">Records checked when verification runs.</p><div className="mt-3 overflow-hidden border border-border/70">{domain.expectedRecords.length ? domain.expectedRecords.map((record, index) => <div key={`${record.type}:${record.name}:${index}`} className="grid gap-1 border-b border-border/60 px-3 py-2.5 text-xs last:border-b-0 sm:grid-cols-[70px_minmax(120px,.7fr)_minmax(180px,1fr)]"><span className="font-medium">{record.type}</span><span className="truncate font-mono text-[11px]">{record.name}</span><span className="break-all font-mono text-[11px] text-muted-foreground">{record.value}</span></div>) : <div className="px-4 py-8 text-center text-xs text-muted-foreground">No DNS records configured.</div>}</div>{domain.verification.details?.length ? <div className="mt-4 space-y-1 border-l-2 border-border pl-3 text-xs text-muted-foreground">{domain.verification.details.map((detail) => <p key={detail}>{detail}</p>)}</div> : null}</section>
  </ResourceDetailShell>;
}

function ServiceRow({ app, service, runtime, busy, run, api, onOpen }: { app: RegisteredApp; service: AppService; runtime?: AppRuntime; busy: string | null; run: (key: string, action: () => Promise<unknown>, message?: string) => Promise<void>; api: ReturnType<typeof useApps>; onOpen: () => void }) {
  const active = runtime?.status === "running" || runtime?.status === "starting";
  const [health, setHealth] = useState<string>();
  const probeHealth = () => void run(`health:${service.id}`, async () => { const result = await api.probeService(app.id, service.id); setHealth(result.ok ? `Healthy · HTTP ${result.status} · ${result.latencyMs} ms` : result.error ?? "Health check failed"); });
  return <ResourceRow icon={Server} title={service.name} subtitle={`${service.kind} · ${service.command}${service.port ? ` · :${service.port}` : ""}`} status={runtime?.status ?? "stopped"} logs={runtime?.logs} detail={health} onOpen={onOpen} actions={<>
    <IconAction label={active ? "Stop service" : "Start service"} text={active ? "Stop" : "Start"} disabled={busy === `service:${service.id}`} onClick={() => run(`service:${service.id}`, () => api.serviceAction(app.id, service.id, active ? "stop" : "start"), active ? "Service stopped" : "Service started")} icon={active ? Square : Play} />
    {active && servicePreviewUrl(service) && <IconLink href={servicePreviewUrl(service)!} label="Open service" />}
    <ServiceActionsMenu
      active={active}
      hasHealth={Boolean(service.publicUrl || service.port)}
      disabled={busy === `service:${service.id}`}
      onRestart={() => void run(`service:${service.id}`, () => api.serviceAction(app.id, service.id, "restart"), "Service restarted")}
      onHealth={probeHealth}
    />
  </>} />;
}

function ServiceActionsMenu({ active, hasHealth, disabled, onRestart, onHealth }: { active: boolean; hasHealth: boolean; disabled?: boolean; onRestart: () => void; onHealth: () => void }) {
  return <DropdownMenu><DropdownMenuTrigger asChild><Button type="button" variant="ghost" size="icon" className="h-8 w-8" disabled={disabled} aria-label="More service actions"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end" className="min-w-40">
    {active && <DropdownMenuItem onSelect={onRestart}><RotateCw className="h-3.5 w-3.5" />Restart</DropdownMenuItem>}
    {hasHealth && <DropdownMenuItem onSelect={onHealth}><Activity className="h-3.5 w-3.5" />Check health</DropdownMenuItem>}
  </DropdownMenuContent></DropdownMenu>;
}

function ResourcePanel({ title, description, action, children }: { title: string; description: string; action: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="h-full min-h-0 min-w-0 overflow-auto p-4">
      <div className="mb-4 flex min-w-0 items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        </div>
        <div className="shrink-0">{action}</div>
      </div>
      <div className="min-w-0 overflow-hidden rounded-md border border-border/70 bg-background divide-y divide-border/60">
        {children}
      </div>
    </div>
  );
}
function ResourceRow({ icon: Icon, title, subtitle, status, logs, detail, actions, onOpen }: { icon: typeof Server; title: string; subtitle: string; status?: string; logs?: AppRuntime["logs"]; detail?: string; actions: React.ReactNode; onOpen: () => void }) {
  const [expanded, setExpanded] = useState(status === "failed");
  useEffect(() => { if (status === "failed" && logs?.length) setExpanded(true); }, [status, logs?.length]);
  return <div role="button" tabIndex={0} onClick={onOpen} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpen(); } }} className="group min-w-0 max-w-full cursor-pointer overflow-hidden px-4 py-3.5 transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"><div className="flex min-w-0 flex-wrap items-center gap-3"><div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/30 text-muted-foreground"><Icon className="h-4 w-4" /></div><div className="min-w-0 flex-1"><div className="flex min-w-0 flex-wrap items-center gap-2"><span className="truncate text-sm font-medium">{title}</span>{status && <StatusBadge status={status} />}</div><p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{subtitle}</p>{detail && <p className="mt-2 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground">{detail}</p>}</div><div className="ml-12 flex basis-[calc(100%-3rem)] shrink-0 items-center justify-end gap-1 sm:ml-0 sm:basis-auto" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>{logs?.length ? <IconAction label={expanded ? "Hide logs" : "View logs"} text="Logs" onClick={() => setExpanded(!expanded)} icon={Activity} /> : null}{actions}<ChevronRight className="ml-1 h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-muted-foreground" /></div></div>{expanded && logs?.length ? <pre className="mt-3 max-h-64 w-full max-w-full overflow-auto border border-border/70 bg-code p-3 text-[11px] leading-5 text-[var(--ink-inverse)]" onClick={(event) => event.stopPropagation()}>{logs.map((line) => `[${new Date(line.at).toLocaleTimeString()}]${line.stream === "stderr" ? " [stderr]" : ""} ${line.text}`).join("\n")}</pre> : null}</div>;
}

function AppEditor({ mode, app, onSave, trigger }: { mode: "create" | "edit"; app?: RegisteredApp; onSave: (input: AppInput) => Promise<unknown>; trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false); const [value, setValue] = useState<AppInput>(app ? toInput(app) : emptyApp()); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); try { await onSave(value); setOpen(false); toast.success(mode === "create" ? "App added" : "App updated"); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } };
  return <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) setValue(app ? toInput(app) : emptyApp()); }}><DialogTrigger asChild>{trigger ?? <Button size="sm">{mode === "create" ? <><Plus className="h-4 w-4" />New app</> : <><Settings2 className="h-4 w-4" />Edit</>}</Button>}</DialogTrigger><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl"><form onSubmit={submit}><DialogHeader><DialogTitle>{mode === "create" ? "New app" : "Edit app"}</DialogTitle><DialogDescription>{mode === "create" ? "Connect a local project to its development and delivery workflow." : "Update the project information shown across the workspace."}</DialogDescription></DialogHeader><div className="grid gap-3 py-4 sm:grid-cols-2"><Field label="Name"><Input required value={value.name} onChange={(e) => setValue({ ...value, name: e.target.value, slug: mode === "create" ? slugify(e.target.value) : value.slug })} /></Field><Field label="Slug"><Input required value={value.slug} onChange={(e) => setValue({ ...value, slug: slugify(e.target.value) })} /></Field><Field label="Local path" wide><Input required className="font-mono" value={value.localPath} onChange={(e) => setValue({ ...value, localPath: e.target.value })} /></Field><Field label="Description" wide><Textarea value={value.description ?? ""} onChange={(e) => setValue({ ...value, description: e.target.value })} /></Field><Field label="Framework"><Input placeholder="Next.js" value={value.framework ?? ""} onChange={(e) => setValue({ ...value, framework: e.target.value || undefined })} /></Field><Field label="Categories"><AppTagInput value={value.tags} onChange={(tags) => setValue({ ...value, tags })} /></Field><Field label="Repository URL" wide><Input value={value.repository?.url ?? ""} onChange={(e) => setValue({ ...value, repository: e.target.value ? { url: e.target.value, branch: value.repository?.branch } : undefined })} /></Field></div><DialogFooter><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{mode === "create" ? "Add app" : "Save changes"}</Button></DialogFooter></form></DialogContent></Dialog>;
}

function ServiceEditor({ onSave, item: initial, triggerNode }: { onSave: (service: AppService) => Promise<unknown>; item?: AppService; triggerNode?: React.ReactNode }) { const [open, setOpen] = useState(false); const [item, setItem] = useState<AppService>(initial ?? { id: makeId("service"), name: "Web", kind: "frontend", command: "pnpm dev", autoStart: true }); const editing = Boolean(initial); return <ResourceEditor open={open} setOpen={setOpen} title={`${editing ? "Edit" : "Add"} service`} onSubmit={() => onSave(item)} trigger="Add service" triggerNode={triggerNode} submitLabel={editing ? "Save" : "Add"}><Field label="Name"><Input required value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} /></Field><Field label="Kind"><EnumSelect value={item.kind} values={["frontend", "backend", "worker", "database"]} onChange={(kind) => setItem({ ...item, kind: kind as AppService["kind"] })} /></Field><Field label="Command" wide><Input required className="font-mono" value={item.command} onChange={(e) => setItem({ ...item, command: e.target.value })} /></Field><Field label="Working directory"><Input placeholder="." value={item.cwd ?? ""} onChange={(e) => setItem({ ...item, cwd: e.target.value || undefined })} /></Field><Field label="Port"><Input type="number" value={item.port ?? ""} onChange={(e) => setItem({ ...item, port: e.target.value ? Number(e.target.value) : undefined })} /></Field><Field label="Public URL" wide><Input placeholder="https://app.example.com" value={item.publicUrl ?? ""} onChange={(e) => setItem({ ...item, publicUrl: e.target.value || undefined })} /></Field><Field label="Health path"><Input placeholder="/api/health" value={item.healthPath ?? ""} onChange={(e) => setItem({ ...item, healthPath: e.target.value || undefined })} /></Field><label className="flex items-center gap-2 self-end pb-2 text-xs"><input type="checkbox" checked={item.autoStart ?? false} onChange={(e) => setItem({ ...item, autoStart: e.target.checked })} /><span>Include in Start App</span></label></ResourceEditor>; }
function DeploymentEditor({ onSave, item: initial, triggerNode }: { onSave: (item: AppDeployment) => Promise<unknown>; item?: AppDeployment; triggerNode?: React.ReactNode }) { const [open, setOpen] = useState(false); const [item, setItem] = useState<AppDeployment>(initial ?? { id: makeId("deploy"), name: "Production", environment: "production", command: "" }); const editing = Boolean(initial); return <ResourceEditor open={open} setOpen={setOpen} title={`${editing ? "Edit" : "Add"} deployment`} onSubmit={() => onSave(item)} trigger="Add deployment" triggerNode={triggerNode} submitLabel={editing ? "Save" : "Add"}><Field label="Name"><Input required value={item.name} onChange={(e) => setItem({ ...item, name: e.target.value })} /></Field><Field label="Environment"><EnvironmentSelect value={item.environment} onChange={(environment) => setItem({ ...item, environment })} /></Field><Field label="Command" wide><Input required className="font-mono" value={item.command} onChange={(e) => setItem({ ...item, command: e.target.value })} /></Field><Field label="Working directory"><Input value={item.cwd ?? ""} onChange={(e) => setItem({ ...item, cwd: e.target.value || undefined })} /></Field><Field label="Provider"><Input placeholder="Vercel" value={item.provider ?? ""} onChange={(e) => setItem({ ...item, provider: e.target.value || undefined })} /></Field><Field label="URL"><Input value={item.url ?? ""} onChange={(e) => setItem({ ...item, url: e.target.value || undefined })} /></Field><Field label="Branch"><Input value={item.branch ?? ""} onChange={(e) => setItem({ ...item, branch: e.target.value || undefined })} /></Field></ResourceEditor>; }
function DomainEditor({ onSave, item: initial, triggerNode }: { onSave: (item: AppDomain) => Promise<unknown>; item?: AppDomain; triggerNode?: React.ReactNode }) { const [open, setOpen] = useState(false); const [item, setItem] = useState<AppDomain>(initial ?? { id: makeId("domain"), hostname: "", environment: "production", expectedRecords: [], verification: { status: "unchecked" } }); const [record, setRecord] = useState(initial?.expectedRecords.map((entry) => `${entry.type} ${entry.name} ${entry.value}`).join("\n") ?? ""); const editing = Boolean(initial); return <ResourceEditor open={open} setOpen={setOpen} title={`${editing ? "Edit" : "Add"} domain`} onSubmit={() => onSave({ ...item, expectedRecords: parseRecords(record), verification: editing ? item.verification : { status: "unchecked" } })} trigger="Add domain" triggerNode={triggerNode} submitLabel={editing ? "Save" : "Add"}><Field label="Hostname"><Input required placeholder="app.example.com" value={item.hostname} onChange={(e) => setItem({ ...item, hostname: e.target.value })} /></Field><Field label="Environment"><EnvironmentSelect value={item.environment} onChange={(environment) => setItem({ ...item, environment })} /></Field><Field label="Deployment ID"><Input value={item.deploymentId ?? ""} onChange={(e) => setItem({ ...item, deploymentId: e.target.value || undefined })} /></Field><Field label="Expected DNS records" wide><Textarea className="font-mono text-xs" placeholder={"CNAME app.example.com target.example.net\nTXT _verify.app.example.com token"} value={record} onChange={(e) => setRecord(e.target.value)} /><p className="mt-1 text-[11px] text-muted-foreground">One record per line: TYPE NAME VALUE</p></Field></ResourceEditor>; }

function ResourceEditor({ open, setOpen, title, onSubmit, trigger, triggerNode, submitLabel, children }: { open: boolean; setOpen: (v: boolean) => void; title: string; onSubmit: () => Promise<unknown>; trigger: string; triggerNode?: React.ReactNode; submitLabel: string; children: React.ReactNode }) { const [busy, setBusy] = useState(false); return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild>{triggerNode ?? <Button type="button" size="sm"><Plus className="h-4 w-4" />{trigger}</Button>}</DialogTrigger><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg"><form onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await onSubmit(); setOpen(false); toast.success(`${title.replace(/^(Add|Edit) /, "")} ${submitLabel === "Add" ? "added" : "updated"}`); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }}><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader><div className="grid gap-3 py-4 sm:grid-cols-2">{children}</div><DialogFooter><Button type="submit" disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{submitLabel}</Button></DialogFooter></form></DialogContent></Dialog>; }
function RemoveResourceButton({ name, label, onDelete }: { name: string; label: string; onDelete: () => Promise<void> }) { const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button type="button" variant="ghost" size="sm" className="h-8 text-destructive hover:text-destructive"><Trash2 className="h-3.5 w-3.5" />{label}</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>{label}?</DialogTitle><DialogDescription>This removes {name} from the app registry. Any active managed process for this resource will be stopped where applicable.</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button type="button" variant="destructive" disabled={busy} onClick={async () => { setBusy(true); try { await onDelete(); setOpen(false); toast.success(`${name} removed`); } catch (error) { toast.error(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); } }}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Remove</Button></DialogFooter></DialogContent></Dialog>; }
function DeleteAppButton({ app, onDelete }: { app: RegisteredApp; onDelete: () => Promise<void> }) { const [open, setOpen] = useState(false); const [busy, setBusy] = useState(false); return <Dialog open={open} onOpenChange={setOpen}><DialogTrigger asChild><Button variant="destructive" size="sm"><Trash2 className="h-4 w-4" />Delete app</Button></DialogTrigger><DialogContent><DialogHeader><DialogTitle>Remove {app.name}?</DialogTitle><DialogDescription>All managed processes will be stopped and the registry record and cover removed. Files in {app.localPath} will remain untouched.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button variant="destructive" disabled={busy} onClick={async () => { setBusy(true); try { await onDelete(); } finally { setBusy(false); } }}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Remove app</Button></DialogFooter></DialogContent></Dialog>; }
function Field({ label, wide, children }: { label: string; wide?: boolean; children: React.ReactNode }) { return <label className={cn("text-xs font-medium", wide && "sm:col-span-2")}><span className="mb-1.5 block text-muted-foreground">{label}</span>{children}</label>; }
function EnumSelect({ value, values, onChange }: { value: string; values: string[]; onChange: (value: string) => void }) { return <Select value={value} onValueChange={onChange}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{values.map((item) => <SelectItem key={item} value={item}>{item}</SelectItem>)}</SelectContent></Select>; }
function EnvironmentSelect({ value, onChange }: { value: AppEnvironment; onChange: (value: AppEnvironment) => void }) { return <EnumSelect value={value} values={["development", "preview", "staging", "production"]} onChange={(next) => onChange(next as AppEnvironment)} />; }
function IconAction({ label, text, icon: Icon, onClick, disabled }: { label: string; text?: string; icon: typeof Play; onClick: () => void; disabled?: boolean }) { return <Tooltip><TooltipTrigger asChild><Button type="button" variant={text ? "outline" : "ghost"} size={text ? "sm" : "icon"} className={cn("h-8", !text && "w-8")} aria-label={label} onClick={onClick} disabled={disabled}><Icon className={cn("h-3.5 w-3.5", disabled && "animate-spin")} />{text}</Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>; }
function CardAction({ label, text, icon: Icon, onClick, disabled }: { label: string; text?: string; icon: typeof Play; onClick: () => void; disabled?: boolean }) { return <Tooltip><TooltipTrigger asChild><Button type="button" variant="ghost" size={text ? "sm" : "icon"} className={cn("h-8", !text && "w-8")} aria-label={label} onClick={onClick} disabled={disabled}><Icon className={cn("h-3.5 w-3.5", disabled && "opacity-50")} />{text}</Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>; }
function CardLink({ label, icon: Icon, href }: { label: string; icon: typeof Play; href: string }) { return <Tooltip><TooltipTrigger asChild><Button asChild variant="ghost" size="icon" className="h-7 w-7"><a href={href} target="_blank" rel="noreferrer" aria-label={label}><Icon className="h-3.5 w-3.5" /></a></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>; }
function IconLink({ href, label }: { href: string; label: string }) { return <Tooltip><TooltipTrigger asChild><Button asChild variant="ghost" size="icon" className="h-8 w-8"><a href={href} target="_blank" rel="noreferrer" aria-label={label}><ExternalLink className="h-3.5 w-3.5" /></a></Button></TooltipTrigger><TooltipContent>{label}</TooltipContent></Tooltip>; }
function StatusBadge({ status }: { status: string }) { const good = status === "running" || status === "succeeded" || status === "valid"; const bad = status === "failed" || status === "invalid"; return <Badge variant="outline" className={cn("text-[10px]", good && "border-emerald-500/30 text-emerald-500", bad && "border-destructive/30 text-destructive")}>{status}</Badge>; }
function Count({ value }: { value: number }) { return <span className="ml-1 text-[10px] text-muted-foreground">{value}</span>; }
function EmptyRows({ text }: { text: string }) { return <div className="px-4 py-12 text-center text-xs text-muted-foreground">{text}</div>; }
function CenteredLoader() { return <div className="flex flex-1 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>; }
function Empty({ icon: Icon, title, detail, action }: { icon: typeof AppWindow; title: string; detail: string; action?: React.ReactNode }) { return <div className="flex flex-1 flex-col items-center justify-center px-6 text-center"><Icon className="mb-3 h-8 w-8 text-muted-foreground/50" /><p className="text-sm font-medium">{title}</p><p className="mt-1 max-w-md text-xs text-muted-foreground">{detail}</p>{action && <div className="mt-4">{action}</div>}</div>; }
function toInput(app: RegisteredApp): AppInput { const { id: _id, runtime: _runtime, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = app; return input; }
function slugify(value: string) { return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function parseRecords(value: string): AppDomain["expectedRecords"] { return value.split("\n").map((line) => line.trim().split(/\s+/, 3)).filter((parts) => parts.length === 3 && ["A", "AAAA", "CNAME", "TXT"].includes(parts[0]!.toUpperCase())).map(([type, name, recordValue]) => ({ type: type!.toUpperCase() as "A" | "AAAA" | "CNAME" | "TXT", name: name!, value: recordValue! })); }
function localDevPreviewUrl(app: RegisteredApp): string | undefined {
  const runningServiceIds = new Set(app.runtime
    .filter((runtime) => runtime.kind === "service" && runtime.status === "running")
    .map((runtime) => runtime.resourceId));
  const service = app.services.find((item) => item.kind === "frontend" && runningServiceIds.has(item.id) && (item.publicUrl || item.port))
    ?? app.services.find((item) => runningServiceIds.has(item.id) && (item.publicUrl || item.port));
  return service ? servicePreviewUrl(service) : undefined;
}

function servicePreviewUrl(service: AppService): string | undefined {
  if (service.publicUrl) return service.publicUrl;
  return service.port ? `${window.location.protocol}//${window.location.hostname}:${service.port}/` : undefined;
}

function publishedAppUrl(app: RegisteredApp): string | undefined {
  const deploymentUrl = app.deployments.find((deployment) => deployment.environment === "production" && deployment.url && deployment.lastRun?.status === "succeeded")?.url;
  if (deploymentUrl) return deploymentUrl;
  const domain = app.domains.find((item) => item.environment === "production" && item.verification.status === "valid");
  return domain ? `https://${domain.hostname}` : undefined;
}

function appCoverTarget(app: RegisteredApp): AppCoverTarget | undefined {
  const available = app.services.filter((service) => service.publicUrl || service.port);
  const ordered = [...available.filter((service) => service.kind === "frontend"), ...available.filter((service) => service.kind !== "frontend")];
  const active = ordered.find((service) => {
    const status = app.runtime.find((runtime) => runtime.kind === "service" && runtime.resourceId === service.id)?.status;
    return status === "running" || status === "starting";
  });
  if (active) return {
    url: active.publicUrl || `http://127.0.0.1:${active.port}/`,
    service: active,
    status: app.runtime.find((runtime) => runtime.kind === "service" && runtime.resourceId === active.id)?.status,
  };
  const published = publishedAppUrl(app);
  if (published) return { url: published };
  const service = ordered[0];
  if (!service) return undefined;
  return {
    url: service.publicUrl || `http://127.0.0.1:${service.port}/`,
    service,
    status: app.runtime.find((runtime) => runtime.kind === "service" && runtime.resourceId === service.id)?.status ?? "stopped",
  };
}

function useAppScreenshot(app: RegisteredApp): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!app.screenshotUpdatedAt) { setUrl(undefined); return; }
    const controller = new AbortController();
    const headers = new Headers();
    if (config.apiKey) headers.set("authorization", `Bearer ${config.apiKey}`);
    let objectUrl: string | undefined;
    fetch(apiUrl(`/api/v1/apps/${encodeURIComponent(app.id)}/screenshot?v=${encodeURIComponent(app.screenshotUpdatedAt)}`), { credentials: "include", headers, signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error("Cover unavailable"); return response.blob(); })
      .then((blob) => { objectUrl = URL.createObjectURL(blob); setUrl(objectUrl); })
      .catch(() => { if (!controller.signal.aborted) setUrl(undefined); });
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [app.id, app.screenshotUpdatedAt]);
  return url;
}
