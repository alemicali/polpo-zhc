import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import {
  AppWindow,
  ArrowLeft,
  ArrowRight,
  Camera,
  Check,
  Code2,
  Crop,
  Download,
  ExternalLink,
  Globe2,
  Laptop,
  Loader2,
  Lock,
  Maximize2,
  Monitor,
  MousePointer2,
  Play,
  RefreshCw,
  RotateCw,
  ScanLine,
  Moon,
  Smartphone,
  Square,
  Sun,
  Tablet,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { sidebarActions, useChatState } from "@/hooks/chat-context";
import { useTheme } from "@/hooks/use-theme";
import {
  clearAppPreviewContext,
  setAppPreviewContext,
  useAppPreviewContext,
  type AppPreviewNode,
  type AppPreviewSelection,
} from "@/hooks/use-app-preview-context";
import { apiUrl, config } from "@/lib/config";
import { cn } from "@/lib/utils";
import { syncCodingState, type PersistedCodingState } from "./coding/use-coding-state";

type PreviewTarget = {
  port: number;
  url: string;
  label: string;
  infrastructure: boolean;
  cwd?: string;
};

type PreviewDiscovery = {
  hostname?: string;
  targets: PreviewTarget[];
  suggested?: PreviewTarget;
};

type DeviceId = "fit" | "desktop" | "laptop" | "tablet" | "mobile";
type PreviewTheme = "system" | "light" | "dark";
type PreviewSurface = "browser" | "code";
type CaptureRegion = { x: number; y: number; width: number; height: number };

type CapturedScreenshot = {
  dataUrl: string;
  width: number;
  height: number;
  label: string;
};

type DevicePreset = {
  id: DeviceId;
  label: string;
  width?: number;
  height?: number;
};

const DEVICE_PRESETS: DevicePreset[] = [
  { id: "fit", label: "Fit" },
  { id: "desktop", label: "Desktop", width: 1440, height: 900 },
  { id: "laptop", label: "Laptop", width: 1280, height: 800 },
  { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  { id: "mobile", label: "Mobile", width: 390, height: 844 },
];

function DeviceIcon({ id, className }: { id: DeviceId; className?: string }) {
  if (id === "desktop") return <Monitor className={className} />;
  if (id === "laptop") return <Laptop className={className} />;
  if (id === "tablet") return <Tablet className={className} />;
  if (id === "mobile") return <Smartphone className={className} />;
  return <Maximize2 className={className} />;
}

function normalizePreviewUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/.*)?$/i.test(trimmed)) return `http://${trimmed}`;
  return `https://${trimmed}`;
}

function excludedPlatformPorts(): number[] {
  const ports = new Set<number>();
  const sources = [window.location.href, config.baseUrl];
  for (const source of sources) {
    if (!source) continue;
    try {
      const port = Number(new URL(source, window.location.href).port);
      if (Number.isInteger(port) && port > 0) ports.add(port);
    } catch {
      // A malformed optional API base should not block preview discovery.
    }
  }
  return [...ports];
}

async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read screenshot"));
    reader.readAsDataURL(blob);
  });
}

async function imageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("Could not read screenshot dimensions"));
    image.src = dataUrl;
  });
}

async function cropScreenshot(
  blob: Blob,
  region: CaptureRegion,
  coordinateViewport?: { width: number; height: number },
): Promise<string> {
  const source = await createImageBitmap(blob);
  try {
    const scaleX = coordinateViewport ? source.width / coordinateViewport.width : 1;
    const scaleY = coordinateViewport ? source.height / coordinateViewport.height : 1;
    const x = Math.max(0, Math.floor(region.x * scaleX));
    const y = Math.max(0, Math.floor(region.y * scaleY));
    const width = Math.max(1, Math.min(source.width - x, Math.floor(region.width * scaleX)));
    const height = Math.max(1, Math.min(source.height - y, Math.floor(region.height * scaleY)));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is not available");
    context.drawImage(source, x, y, width, height, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } finally {
    source.close();
  }
}

function screenshotFile(dataUrl: string): File {
  const [metadata, payload] = dataUrl.split(",");
  const mimeType = metadata.match(/^data:([^;]+)/)?.[1] ?? "image/png";
  const bytes = Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
  return new File([bytes], `app-preview-${Date.now()}.png`, { type: mimeType });
}

export function BrowserPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { resolved: platformTheme } = useTheme();
  const { sessionId } = useChatState();
  const previewContext = useAppPreviewContext();
  const requestedUrl = normalizePreviewUrl(searchParams.get("url") ?? "");
  const requestedCwd = searchParams.get("cwd") ?? undefined;
  const [history, setHistory] = useState<string[]>(requestedUrl ? [requestedUrl] : []);
  const [index, setIndex] = useState(requestedUrl ? 0 : -1);
  const [draft, setDraft] = useState(requestedUrl);
  const [isLoading, setIsLoading] = useState(Boolean(requestedUrl));
  const [reloadKey, setReloadKey] = useState(0);
  const [discovery, setDiscovery] = useState<PreviewDiscovery>({ targets: [] });
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [deviceId, setDeviceId] = useState<DeviceId>("fit");
  const [landscape, setLandscape] = useState(false);
  const [previewTheme, setPreviewTheme] = useState<PreviewTheme>("system");
  const [surface, setSurface] = useState<PreviewSurface>(searchParams.get("surface") === "code" ? "code" : "browser");
  const [responsiveViewport, setResponsiveViewport] = useState({ width: 1280, height: 720 });
  const [inspecting, setInspecting] = useState(false);
  const [bridgeReady, setBridgeReady] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<AppPreviewNode | null>(null);
  const [nodeSelections, setNodeSelections] = useState<AppPreviewSelection[]>([]);
  const [regionSelecting, setRegionSelecting] = useState(false);
  const [regionRect, setRegionRect] = useState<CaptureRegion | null>(null);
  const [capturedScreenshot, setCapturedScreenshot] = useState<CapturedScreenshot | null>(null);
  const [expandedScreenshot, setExpandedScreenshot] = useState<CapturedScreenshot | null>(null);
  const [screenshotZoom, setScreenshotZoom] = useState(1);
  const [toolBusy, setToolBusy] = useState<"screenshot" | null>(null);
  const appliedUrlRef = useRef(requestedUrl);
  const frameRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRequestRef = useRef(0);
  const regionStartRef = useRef<{ x: number; y: number } | null>(null);
  const nodeSelectionsRef = useRef<AppPreviewSelection[]>([]);
  const attachedScreenshotRef = useRef<string | undefined>(undefined);

  const currentUrl = index >= 0 ? history[index] ?? "" : "";
  const canGoBack = index > 0;
  const canGoForward = index >= 0 && index < history.length - 1;
  const device = DEVICE_PRESETS.find((preset) => preset.id === deviceId) ?? DEVICE_PRESETS[0];
  const viewport = useMemo(() => {
    if (!device.width || !device.height) return responsiveViewport;
    return landscape
      ? { width: device.height, height: device.width }
      : { width: device.width, height: device.height };
  }, [device.height, device.width, landscape, responsiveViewport]);
  const deviceLabel = device.id === "fit" ? "Responsive" : `${device.label}${landscape ? " landscape" : ""}`;

  const applyPreviewTheme = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    const resolvedTheme = previewTheme === "system"
      ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
      : previewTheme;

    frame.contentWindow?.postMessage({
      type: "polpo:app-preview-theme",
      theme: previewTheme,
      resolvedTheme,
    }, "*");
    frame.contentWindow?.postMessage({ type: "polpo:app-preview-ping" }, "*");

    try {
      const root = frame.contentDocument?.documentElement;
      if (!root) return;
      root.dataset.theme = resolvedTheme;
      root.classList.toggle("dark", resolvedTheme === "dark");
      root.classList.toggle("light", resolvedTheme === "light");
      root.style.colorScheme = resolvedTheme;
    } catch {
      // Cross-origin previews can opt into the postMessage contract above.
    }
  }, [previewTheme]);

  const replacePreview = useCallback((rawUrl: string) => {
    const url = normalizePreviewUrl(rawUrl);
    if (!url) return;
    appliedUrlRef.current = url;
    setHistory([url]);
    setIndex(0);
    setDraft(url);
    setIsLoading(true);
    setSearchParams({ url }, { replace: true });
  }, [setSearchParams]);

  const navigateTo = useCallback((rawValue: string) => {
    const trimmedValue = rawValue.trim();
    const numericPort = /^\d+$/.test(trimmedValue) ? Number(trimmedValue) : undefined;
    const validPort = numericPort && numericPort >= 1 && numericPort <= 65_535 ? numericPort : undefined;
    const matchingPort = validPort
      ? discovery.targets.find((target) => !target.infrastructure && target.port === validPort)
      : undefined;
    const publicPortUrl = validPort && discovery.hostname
      ? `https://${discovery.hostname}:${validPort}/`
      : undefined;
    const nextUrl = normalizePreviewUrl(matchingPort?.url ?? publicPortUrl ?? rawValue);
    if (!nextUrl) return;
    appliedUrlRef.current = nextUrl;
    setHistory((items) => [...items.slice(0, index + 1), nextUrl]);
    setIndex((value) => value + 1);
    setDraft(nextUrl);
    setIsLoading(true);
    setSearchParams({ url: nextUrl }, { replace: true });
  }, [discovery.targets, index, setSearchParams]);

  useEffect(() => {
    if (!requestedUrl || requestedUrl === appliedUrlRef.current) return;
    replacePreview(requestedUrl);
  }, [replacePreview, requestedUrl]);

  useEffect(() => {
    const controller = new AbortController();
    const excluded = excludedPlatformPorts().join(",");
    const endpoint = `/api/v1/app-preview/targets${excluded ? `?excludePorts=${encodeURIComponent(excluded)}` : ""}`;
    setDiscoveryLoading(true);
    const discover = () => {
      fetch(apiUrl(endpoint), { credentials: "include", signal: controller.signal })
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok || !body?.ok) throw new Error(body?.error || "Preview discovery failed");
          return body.data as PreviewDiscovery;
        })
        .then((data) => {
          setDiscovery(data);
          setDiscoveryError(null);
          if (!appliedUrlRef.current && data.suggested?.url) replacePreview(data.suggested.url);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setDiscoveryError(error instanceof Error ? error.message : "Preview discovery failed");
        })
        .finally(() => {
          if (!controller.signal.aborted) setDiscoveryLoading(false);
        });
    };
    discover();
    const interval = window.setInterval(discover, 5_000);
    return () => {
      window.clearInterval(interval);
      controller.abort();
    };
  }, [replacePreview]);

  useEffect(() => {
    if (deviceId !== "fit" || !frameRef.current) return;
    const update = () => {
      const rect = frameRef.current?.getBoundingClientRect();
      if (!rect) return;
      setResponsiveViewport({
        width: Math.max(160, Math.floor(rect.width)),
        height: Math.max(160, Math.floor(rect.height)),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frameRef.current);
    return () => observer.disconnect();
  }, [deviceId]);

  useEffect(() => {
    setInspecting(false);
    setBridgeReady(false);
    setHoveredNode(null);
    setNodeSelections([]);
    nodeSelectionsRef.current = [];
    attachedScreenshotRef.current = undefined;
    setRegionSelecting(false);
    setRegionRect(null);
  }, [currentUrl, deviceId, landscape]);

  useEffect(() => {
    const belongsToCurrentPreview = previewContext?.url === currentUrl && previewContext.sessionId === sessionId;
    const selections = belongsToCurrentPreview ? previewContext.selections ?? [] : [];
    nodeSelectionsRef.current = selections;
    attachedScreenshotRef.current = belongsToCurrentPreview ? previewContext.screenshotDataUrl : undefined;
    setNodeSelections(selections);
  }, [currentUrl, previewContext, sessionId]);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
  }, []);

  useEffect(() => {
    applyPreviewTheme();
    if (previewTheme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", applyPreviewTheme);
    return () => media.removeEventListener("change", applyPreviewTheme);
  }, [applyPreviewTheme, previewTheme]);

  const selectedTarget = useMemo(() => discovery.targets.find((target) => {
    try {
      return new URL(target.url).origin === new URL(currentUrl).origin;
    } catch {
      return false;
    }
  }) ?? (requestedCwd ? {
    port: (() => { try { return Number(new URL(currentUrl).port) || 0; } catch { return 0; } })(),
    url: currentUrl,
    label: requestedCwd.split("/").filter(Boolean).pop() ?? "App",
    infrastructure: false,
    cwd: requestedCwd,
  } : undefined), [currentUrl, discovery.targets, requestedCwd]);
  const previewTargets = useMemo(
    () => discovery.targets.filter((target) => !target.infrastructure),
    [discovery.targets],
  );
  const iframeUrl = useMemo(() => {
    if (!currentUrl || !selectedTarget) return currentUrl;
    try {
      const url = new URL(currentUrl);
      url.searchParams.set("__polpo_preview_parent", window.location.origin);
      return url.toString();
    } catch {
      return currentUrl;
    }
  }, [currentUrl, selectedTarget]);

  const toolContext = useCallback((extra: { selections?: AppPreviewSelection[]; screenshotDataUrl?: string }) => ({
    sessionId,
    url: currentUrl,
    viewport,
    deviceLabel,
    selections: extra.selections,
    screenshotDataUrl: extra.screenshotDataUrl,
  }), [currentUrl, deviceLabel, sessionId, viewport]);

  const captureScreenshot = useCallback(async (options?: { fullPage?: boolean; region?: CaptureRegion }) => {
    if (!selectedTarget || toolBusy) return;
    setToolBusy("screenshot");
    try {
      const response = await fetch(apiUrl("/api/v1/app-preview/screenshot"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: currentUrl, viewport, fullPage: options?.fullPage === true }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.error || "Screenshot failed");
      }
      const blob = await response.blob();
      const dataUrl = options?.region
        ? await cropScreenshot(blob, options.region, viewport)
        : await blobToDataUrl(blob);
      const dimensions = await imageDimensions(dataUrl);
      setCapturedScreenshot({
        dataUrl,
        ...dimensions,
        label: options?.region ? "Selected region" : options?.fullPage ? "Full page" : "Visible area",
      });
      toast.success("Screenshot captured");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Screenshot failed");
    } finally {
      setToolBusy(null);
    }
  }, [currentUrl, selectedTarget, toolBusy, viewport]);

  const attachScreenshot = useCallback(() => {
    if (!capturedScreenshot) return;
    attachedScreenshotRef.current = capturedScreenshot.dataUrl;
    setAppPreviewContext(toolContext({
      selections: nodeSelectionsRef.current.length > 0 ? nodeSelectionsRef.current : undefined,
      screenshotDataUrl: capturedScreenshot.dataUrl,
    }));
    sidebarActions.setSidebarOpen(true);
    toast.success("Screenshot attached to the next prompt");
  }, [capturedScreenshot, toolContext]);

  const previewPoint = useCallback((clientX: number, clientY: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.max(0, Math.min(viewport.width, ((clientX - rect.left) / rect.width) * viewport.width)),
      y: Math.max(0, Math.min(viewport.height, ((clientY - rect.top) / rect.height) * viewport.height)),
    };
  }, [viewport]);

  const beginRegionSelection = useCallback(() => {
    setInspecting(false);
    setHoveredNode(null);
    setRegionRect(null);
    setRegionSelecting(true);
  }, []);

  const handleRegionPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const point = previewPoint(event.clientX, event.clientY);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    regionStartRef.current = point;
    setRegionRect({ ...point, width: 0, height: 0 });
  }, [previewPoint]);

  const handleRegionPointerMove = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = regionStartRef.current;
    const point = previewPoint(event.clientX, event.clientY);
    if (!start || !point) return;
    setRegionRect({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  }, [previewPoint]);

  const handleRegionPointerUp = useCallback((event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const start = regionStartRef.current;
    const point = previewPoint(event.clientX, event.clientY);
    regionStartRef.current = null;
    const region = start && point ? {
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    } : regionRect;
    setRegionSelecting(false);
    setRegionRect(null);
    if (!region || region.width < 8 || region.height < 8) {
      toast.error("Drag a larger screenshot region");
      return;
    }
    void captureScreenshot({ region });
  }, [captureScreenshot, previewPoint, regionRect]);

  const handleScreenshotDragStart = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!capturedScreenshot) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.items.add(screenshotFile(capturedScreenshot.dataUrl));
    event.dataTransfer.setData("text/plain", `App Preview ${capturedScreenshot.label}`);
  }, [capturedScreenshot]);

  const downloadScreenshot = useCallback(() => {
    if (!capturedScreenshot) return;
    const link = document.createElement("a");
    link.href = capturedScreenshot.dataUrl;
    link.download = `app-preview-${Date.now()}.png`;
    link.click();
  }, [capturedScreenshot]);

  const inspectAt = useCallback(async (clientX: number, clientY: number): Promise<AppPreviewNode | null> => {
    if (!selectedTarget || !frameRef.current) return null;
    const rect = frameRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(viewport.width, ((clientX - rect.left) / rect.width) * viewport.width));
    const y = Math.max(0, Math.min(viewport.height, ((clientY - rect.top) / rect.height) * viewport.height));
    try {
      const response = await fetch(apiUrl("/api/v1/app-preview/inspect"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: currentUrl, viewport, x, y }),
      });
      const body = await response.json();
      if (!response.ok || !body?.ok) throw new Error(body?.error || "Element inspection failed");
      return body.data as AppPreviewNode;
    } catch (error) {
      console.warn("[app-preview] inspection failed:", error);
      return null;
    }
  }, [currentUrl, selectedTarget, viewport]);

  const captureNodePreview = useCallback(async (node: AppPreviewNode): Promise<string | undefined> => {
    if (!selectedTarget || node.rect.width < 1 || node.rect.height < 1) return undefined;
    try {
      const requestScreenshot = (selector?: string) => fetch(apiUrl("/api/v1/app-preview/screenshot"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: currentUrl, viewport, fullPage: false, selector }),
      });
      let response = await requestScreenshot(node.selector);
      if (!response.ok) response = await requestScreenshot();
      if (!response.ok) throw new Error("Element screenshot failed");
      const blob = await response.blob();
      return response.headers.get("x-polpo-screenshot-target") === "element"
        ? await blobToDataUrl(blob)
        : await cropScreenshot(blob, node.rect, viewport);
    } catch (error) {
      console.warn("[app-preview] element screenshot failed:", error);
      return undefined;
    }
  }, [currentUrl, selectedTarget, viewport]);

  const publishNodeSelections = useCallback((selections: AppPreviewSelection[]) => {
    nodeSelectionsRef.current = selections;
    setNodeSelections(selections);
    setAppPreviewContext(toolContext({
      selections: selections.length > 0 ? selections : undefined,
      screenshotDataUrl: attachedScreenshotRef.current,
    }));
  }, [toolContext]);

  const attachNode = useCallback((node: AppPreviewNode) => {
    setHoveredNode(null);
    const existingIndex = nodeSelectionsRef.current.findIndex((selection) => selection.node.selector === node.selector);
    const nextSelection = { node };
    const nextSelections = existingIndex >= 0
      ? nodeSelectionsRef.current.map((selection, index) => index === existingIndex ? nextSelection : selection)
      : [...nodeSelectionsRef.current, nextSelection];
    publishNodeSelections(nextSelections);
    sidebarActions.setSidebarOpen(true);
    toast.success(existingIndex >= 0 ? "DOM element updated" : "DOM element added to the next prompt");

    void captureNodePreview(node).then((screenshotDataUrl) => {
      if (!screenshotDataUrl) return;
      const currentIndex = nodeSelectionsRef.current.findIndex((selection) => selection.node.selector === node.selector);
      if (currentIndex < 0) return;
      publishNodeSelections(nodeSelectionsRef.current.map((selection, index) => (
        index === currentIndex ? { ...selection, node, screenshotDataUrl } : selection
      )));
    });
  }, [captureNodePreview, publishNodeSelections]);

  useEffect(() => {
    const receiveBridgeMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || !event.data) return;
      if (event.data.type === "polpo:app-preview-bridge-ready") {
        setBridgeReady(true);
        iframeRef.current?.contentWindow?.postMessage({
          type: "polpo:app-preview-inspector",
          enabled: inspecting,
        }, "*");
        return;
      }
      if (event.data.type === "polpo:app-preview-node-hovered" && event.data.node) {
        setHoveredNode(event.data.node as AppPreviewNode);
        return;
      }
      if (event.data.type === "polpo:app-preview-node-selected" && event.data.node) {
        attachNode(event.data.node as AppPreviewNode);
        return;
      }
      if (event.data.type === "polpo:app-preview-picker-cancelled") {
        setInspecting(false);
        setHoveredNode(null);
      }
    };
    window.addEventListener("message", receiveBridgeMessage);
    return () => window.removeEventListener("message", receiveBridgeMessage);
  }, [attachNode, inspecting]);

  useEffect(() => {
    if (!bridgeReady) return;
    iframeRef.current?.contentWindow?.postMessage({
      type: "polpo:app-preview-inspector",
      enabled: inspecting,
    }, "*");
  }, [bridgeReady, inspecting]);

  const inspectOnHover = useCallback((clientX: number, clientY: number) => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const requestId = ++hoverRequestRef.current;
    hoverTimerRef.current = setTimeout(() => {
      void inspectAt(clientX, clientY).then((node) => {
        if (requestId === hoverRequestRef.current && node) setHoveredNode(node);
      });
    }, 70);
  }, [inspectAt]);

  const selectAt = useCallback(async (clientX: number, clientY: number) => {
    hoverRequestRef.current += 1;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    const node = await inspectAt(clientX, clientY);
    if (node) attachNode(node);
    else toast.error("Could not identify this DOM element");
  }, [attachNode, inspectAt]);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigateTo(draft);
  };

  const goBack = () => {
    if (!canGoBack) return;
    const nextIndex = index - 1;
    const nextUrl = history[nextIndex] ?? "";
    appliedUrlRef.current = nextUrl;
    setIndex(nextIndex);
    setDraft(nextUrl);
    setIsLoading(true);
    setSearchParams({ url: nextUrl }, { replace: true });
  };

  const goForward = () => {
    if (!canGoForward) return;
    const nextIndex = index + 1;
    const nextUrl = history[nextIndex] ?? "";
    appliedUrlRef.current = nextUrl;
    setIndex(nextIndex);
    setDraft(nextUrl);
    setIsLoading(true);
    setSearchParams({ url: nextUrl }, { replace: true });
  };

  const refresh = () => {
    if (!currentUrl) return;
    setIsLoading(true);
    setBridgeReady(false);
    setHoveredNode(null);
    setReloadKey((value) => value + 1);
  };

  const clearSelection = () => {
    setHoveredNode(null);
    setNodeSelections([]);
    nodeSelectionsRef.current = [];
    attachedScreenshotRef.current = undefined;
    setInspecting(false);
    if (previewContext?.url === currentUrl && previewContext.sessionId === sessionId) clearAppPreviewContext();
  };

  const toolDisabled = !selectedTarget || !currentUrl || isLoading || toolBusy !== null;
  const contextAttached = previewContext?.url === currentUrl && previewContext.sessionId === sessionId;
  const showParentHighlight = inspecting && !bridgeReady ? hoveredNode : null;

  return (
    <section className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-background">
      <div className="flex min-h-10 shrink-0 items-center gap-1 border-b border-border/70 bg-background px-1.5 py-1">
        <Tabs
          value={surface}
          onValueChange={(next) => {
            const value = next as PreviewSurface;
            setSurface(value);
            setSearchParams((params) => { params.set("surface", value); return params; }, { replace: true });
          }}
          className="contents"
        >
          <TabsList className="h-8 shrink-0" aria-label="App Preview mode">
            <TabsTrigger value="browser" className="h-6 flex-none gap-1.5 px-2 text-[11px]">
              <Globe2 className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">Browser</span>
            </TabsTrigger>
            <TabsTrigger value="code" className="h-6 flex-none gap-1.5 px-2 text-[11px]">
              <Code2 className="h-3.5 w-3.5" />
              <span className="hidden xl:inline">Code</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {surface === "browser" && <>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={goBack} disabled={!canGoBack} aria-label="Go back">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Back</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={goForward} disabled={!canGoForward} aria-label="Go forward">
              <ArrowRight className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Forward</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={refresh} disabled={!currentUrl} aria-label="Reload preview">
              <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reload</TooltipContent>
        </Tooltip>
        </>}

        {surface === "browser" ? <form onSubmit={handleSubmit} className="relative flex min-w-[150px] flex-1 items-center">
          {currentUrl.startsWith("https://")
            ? <Lock className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-emerald-500" />
            : <Globe2 className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-muted-foreground" />}
          <Input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 border-border/70 bg-muted/30 pl-9 pr-9 font-mono text-xs shadow-none focus-visible:ring-1"
            placeholder={discovery.hostname ? `https://${discovery.hostname}:PORT` : "Enter preview URL or active port"}
            spellCheck={false}
            aria-label="App Preview address"
          />
          <Button type="submit" variant="ghost" size="icon" className="absolute right-1 h-6 w-6 text-muted-foreground hover:text-foreground" aria-label="Open preview URL">
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </form> : (
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2 text-xs text-muted-foreground">
            <Code2 className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">
              {selectedTarget && !selectedTarget.infrastructure
                ? `${selectedTarget.label} · :${selectedTarget.port}`
                : "Select an active app to open its workspace"}
            </span>
          </div>
        )}

        {surface === "browser" && <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`${device.label} viewport`}>
              <DeviceIcon id={deviceId} className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[100] min-w-[210px]">
            {DEVICE_PRESETS.map((preset) => (
              <DropdownMenuItem key={preset.id} onSelect={() => setDeviceId(preset.id)}>
                <DeviceIcon id={preset.id} className="h-3.5 w-3.5" />
                <span>{preset.label}</span>
                <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                  {preset.width ? `${preset.width} × ${preset.height}` : "available space"}
                </span>
                {deviceId === preset.id && <Check className="h-3.5 w-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>}

        {surface === "browser" && deviceId !== "fit" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => setLandscape((value) => !value)} aria-label="Rotate viewport">
                <RotateCw className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Rotate viewport ({viewport.width} × {viewport.height})</TooltipContent>
          </Tooltip>
        )}

        {surface === "browser" && <>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => setPreviewTheme((value) => value === "system" ? "light" : value === "light" ? "dark" : "system")}
              aria-label={`Preview theme: ${previewTheme}`}
            >
              {previewTheme === "light"
                ? <Sun className="h-3.5 w-3.5" />
                : previewTheme === "dark"
                  ? <Moon className="h-3.5 w-3.5" />
                  : <Monitor className="h-3.5 w-3.5" />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Preview theme: {previewTheme}. Click to change.</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant={inspecting ? "default" : "ghost"}
              size="icon"
              className="relative h-8 w-8 shrink-0"
              disabled={toolDisabled}
              onClick={() => {
                setRegionSelecting(false);
                setInspecting((value) => {
                  if (value) setHoveredNode(null);
                  return !value;
                });
              }}
              aria-label="Select element"
              aria-pressed={inspecting}
            >
              <MousePointer2 className="h-3.5 w-3.5" />
              {nodeSelections.length > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center bg-primary px-0.5 text-[8px] leading-none text-primary-foreground">
                  {nodeSelections.length}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {!selectedTarget
              ? "Select an active preview port first"
              : inspecting
                ? (bridgeReady ? "Live DOM picker active" : "DOM mirror picker active")
                : (bridgeReady ? "Pick a live DOM element" : "Pick from the server-rendered DOM mirror")}
          </TooltipContent>
        </Tooltip>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={toolDisabled} aria-label="Capture screenshot">
              {toolBusy === "screenshot" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Camera className="h-3.5 w-3.5" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="z-[100] min-w-[190px]">
            <DropdownMenuItem onSelect={() => void captureScreenshot()}>
              <Maximize2 className="h-3.5 w-3.5" />
              Visible area
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void captureScreenshot({ fullPage: true })}>
              <Download className="h-3.5 w-3.5" />
              Full page
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={beginRegionSelection}>
              <Crop className="h-3.5 w-3.5" />
              Select region
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {contextAttached && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="secondary" size="icon" className="h-8 w-8 shrink-0" onClick={clearSelection} aria-label="Clear preview attachment">
                <X className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Clear attachment for next prompt</TooltipContent>
          </Tooltip>
        )}
        </>}

        {surface === "browser" && <Tooltip>
          <TooltipTrigger asChild>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8 shrink-0" disabled={!currentUrl} onClick={() => window.open(currentUrl, "_blank", "noopener,noreferrer")} aria-label="Open preview externally">
              <ExternalLink className="h-4 w-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open in a new tab</TooltipContent>
        </Tooltip>}

        <Select value={selectedTarget && !selectedTarget.infrastructure ? selectedTarget.url : undefined} onValueChange={replacePreview} disabled={discoveryLoading || previewTargets.length === 0}>
          <SelectTrigger size="sm" className="w-[148px] shrink-0 lg:w-[190px]" aria-label="Active preview port">
            {discoveryLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : surface === "code" ? <Code2 className="h-3.5 w-3.5" /> : <Globe2 className="h-3.5 w-3.5" />}
            <SelectValue placeholder={discoveryError ? "Unavailable" : surface === "code" ? "Active apps" : "Active ports"} />
          </SelectTrigger>
          <SelectContent align="end">
            {previewTargets.map((target) => (
              <SelectItem key={target.url} value={target.url}>
                <span className="font-mono text-xs">:{target.port}</span>
                <span>{target.label}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted/35">
        {surface === "code" ? (
          <PreviewCodePane
            currentUrl={currentUrl}
            target={selectedTarget && !selectedTarget.infrastructure ? selectedTarget : undefined}
            theme={platformTheme}
          />
        ) : (<>
        <div className={cn("h-full w-full", deviceId === "fit" ? "overflow-hidden" : "overflow-auto")}>
          {currentUrl ? (
            <div className={cn("relative", deviceId === "fit" ? "h-full w-full" : "flex min-h-full min-w-full items-start justify-center p-3")}>
            <div
              ref={frameRef}
              className={cn("relative shrink-0 overflow-hidden bg-white", deviceId === "fit" && "h-full w-full")}
              style={deviceId === "fit" ? undefined : { width: viewport.width, height: viewport.height }}
            >
              {isLoading && (
                <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/75">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              )}
              <iframe
                ref={iframeRef}
                key={`${currentUrl}-${reloadKey}`}
                title="App Preview"
                src={iframeUrl}
                className="h-full w-full border-0 bg-white"
                sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
                referrerPolicy="no-referrer-when-downgrade"
                style={{ colorScheme: previewTheme === "system" ? undefined : previewTheme }}
                onLoad={() => {
                  setIsLoading(false);
                  applyPreviewTheme();
                }}
              />
              {showParentHighlight && (
                <div
                  className="pointer-events-none absolute z-50 border-2 border-primary bg-primary/10"
                  style={{
                    left: `${(showParentHighlight.rect.x / viewport.width) * 100}%`,
                    top: `${(showParentHighlight.rect.y / viewport.height) * 100}%`,
                    width: `${(showParentHighlight.rect.width / viewport.width) * 100}%`,
                    height: `${(showParentHighlight.rect.height / viewport.height) * 100}%`,
                  }}
                >
                  <span className="absolute -top-5 left-[-2px] max-w-[280px] truncate bg-primary px-1.5 py-0.5 font-mono text-[9px] text-primary-foreground">
                    {showParentHighlight.selector}
                  </span>
                </div>
              )}
              {inspecting && !bridgeReady && (
                <button
                  type="button"
                  className="absolute inset-0 z-40 cursor-crosshair bg-primary/[0.025]"
                  onPointerMove={(event) => inspectOnHover(event.clientX, event.clientY)}
                  onPointerLeave={() => {
                    hoverRequestRef.current += 1;
                    setHoveredNode(null);
                  }}
                  onClick={(event) => void selectAt(event.clientX, event.clientY)}
                  aria-label="Click an element to inspect it"
                />
              )}
              {regionSelecting && (
                <button
                  type="button"
                  className="absolute inset-0 z-[60] cursor-crosshair bg-black/10"
                  onPointerDown={handleRegionPointerDown}
                  onPointerMove={handleRegionPointerMove}
                  onPointerUp={handleRegionPointerUp}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setRegionSelecting(false);
                      setRegionRect(null);
                    }
                  }}
                  aria-label="Drag to select a screenshot region"
                >
                  {regionRect && (
                    <span
                      className="pointer-events-none absolute border-2 border-primary bg-primary/10"
                      style={{
                        left: `${(regionRect.x / viewport.width) * 100}%`,
                        top: `${(regionRect.y / viewport.height) * 100}%`,
                        width: `${(regionRect.width / viewport.width) * 100}%`,
                        height: `${(regionRect.height / viewport.height) * 100}%`,
                      }}
                    >
                      <span className="absolute -top-5 left-[-2px] bg-primary px-1.5 py-0.5 font-mono text-[9px] text-primary-foreground">
                        {Math.round(regionRect.width)} × {Math.round(regionRect.height)}
                      </span>
                    </span>
                  )}
                </button>
              )}
            </div>
          </div>
          ) : (
            <div className="flex h-full items-center justify-center p-8 text-center">
              <div>
                {discoveryLoading ? <Loader2 className="mx-auto h-5 w-5 animate-spin text-muted-foreground" /> : <AppWindow className="mx-auto h-6 w-6 text-muted-foreground" />}
                <p className="mt-3 text-sm font-medium">{discoveryError ? "Preview discovery unavailable" : "No active app preview"}</p>
                <p className="mt-1 text-xs text-muted-foreground">Enter a public URL or start a service on a Tailscale-exposed port.</p>
              </div>
            </div>
          )}
        </div>

        {capturedScreenshot && (
          <div
            draggable
            onDragStart={handleScreenshotDragStart}
            className="absolute bottom-3 right-3 z-[70] w-[220px] cursor-grab overflow-hidden rounded-md border border-border bg-background shadow-lg active:cursor-grabbing"
          >
            <button
              type="button"
              className="group relative block aspect-video w-full overflow-hidden bg-muted text-left"
              onClick={() => {
                setScreenshotZoom(1);
                setExpandedScreenshot(capturedScreenshot);
              }}
              aria-label="Enlarge screenshot preview"
            >
              <img src={capturedScreenshot.dataUrl} alt="Captured App Preview" className="h-full w-full object-contain" draggable={false} />
              <span className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors group-hover:bg-black/20">
                <Maximize2 className="h-5 w-5 text-white opacity-0 drop-shadow transition-opacity group-hover:opacity-100" />
              </span>
            </button>
            <Button type="button" variant="secondary" size="icon" className="absolute right-1 top-1 z-10 h-6 w-6" onClick={() => setCapturedScreenshot(null)} aria-label="Close screenshot preview">
              <X className="h-3 w-3" />
            </Button>
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] font-medium">{capturedScreenshot.label}</p>
                <p className="font-mono text-[9px] text-muted-foreground">{capturedScreenshot.width} × {capturedScreenshot.height}</p>
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={downloadScreenshot} aria-label="Download screenshot">
                    <Download className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Download PNG</TooltipContent>
              </Tooltip>
              <Button
                type="button"
                variant={contextAttached && previewContext?.screenshotDataUrl === capturedScreenshot.dataUrl ? "secondary" : "default"}
                size="sm"
                className="h-7 gap-1 px-2 text-[10px]"
                onClick={attachScreenshot}
              >
                {contextAttached && previewContext?.screenshotDataUrl === capturedScreenshot.dataUrl && <Check className="h-3 w-3" />}
                {contextAttached && previewContext?.screenshotDataUrl === capturedScreenshot.dataUrl ? "Attached" : "Attach"}
              </Button>
            </div>
          </div>
        )}

        {toolBusy === "screenshot" && (
          <div className="pointer-events-none absolute inset-0 z-[80] overflow-hidden bg-background/15">
            <div className="app-preview-scan-line absolute inset-x-0 h-px bg-primary shadow-[0_0_18px_3px_hsl(var(--primary)/0.55)]" />
            <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 border border-border bg-background/95 px-3 py-2 shadow-lg">
              <ScanLine className="h-4 w-4 animate-pulse text-primary" />
              <span className="text-xs font-medium">Capturing screenshot...</span>
            </div>
          </div>
        )}
        </>)}
      </div>

      <Dialog open={Boolean(expandedScreenshot)} onOpenChange={(open) => { if (!open) setExpandedScreenshot(null); }}>
        <DialogContent className="flex h-[88vh] w-[94vw] max-w-[1440px] flex-col gap-0 overflow-hidden p-0">
          <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3 pr-12">
            <DialogTitle className="min-w-0 flex-1 truncate text-sm">{expandedScreenshot?.label ?? "Screenshot"}</DialogTitle>
            {expandedScreenshot && <span className="font-mono text-[10px] text-muted-foreground">{expandedScreenshot.width} × {expandedScreenshot.height}</span>}
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setScreenshotZoom((value) => Math.max(0.5, value - 0.25))} disabled={screenshotZoom <= 0.5} aria-label="Zoom out">
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <button type="button" className="w-12 text-center font-mono text-[10px] text-muted-foreground" onClick={() => setScreenshotZoom(1)} title="Reset zoom">
              {Math.round(screenshotZoom * 100)}%
            </button>
            <Button type="button" variant="ghost" size="icon" className="h-7 w-7" onClick={() => setScreenshotZoom((value) => Math.min(3, value + 0.25))} disabled={screenshotZoom >= 3} aria-label="Zoom in">
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-4">
            {expandedScreenshot && (
              <div className={cn("min-h-full min-w-full", screenshotZoom === 1 && "flex items-center justify-center")}>
                <img
                  src={expandedScreenshot.dataUrl}
                  alt={`${expandedScreenshot.label} enlarged`}
                  className="mx-auto block bg-background object-contain shadow-lg"
                  style={screenshotZoom === 1
                    ? { maxWidth: "100%", maxHeight: "calc(88vh - 76px)", width: "auto", height: "auto" }
                    : { width: `${screenshotZoom * 100}%`, maxWidth: "none", height: "auto" }}
                />
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}

type PreviewCodeSession = {
  port: number;
  cwd: string;
  workspaceId: string;
  workspaceName: string;
  state: PersistedCodingState;
};

function PreviewCodePane({
  currentUrl,
  target,
  theme,
}: {
  currentUrl: string;
  target?: PreviewTarget;
  theme: "light" | "dark";
}) {
  const navigate = useNavigate();
  const [session, setSession] = useState<PreviewCodeSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef(0);
  const previousThemeRef = useRef(theme);

  const start = useCallback(async (force = false) => {
    if (!target || busy) return;
    const requestId = ++requestRef.current;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/v1/app-preview/code-server/start"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: currentUrl || target.url, cwd: target.cwd, theme, force }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error || `VS Code failed to start (${response.status})`);
      if (requestRef.current !== requestId) return;
      const data = body.data as PreviewCodeSession;
      syncCodingState(data.state);
      setSession(data);
    } catch (startError) {
      if (requestRef.current !== requestId) return;
      setSession(null);
      setError(startError instanceof Error ? startError.message : "VS Code failed to start");
    } finally {
      if (requestRef.current === requestId) setBusy(false);
    }
  }, [busy, currentUrl, target, theme]);

  useEffect(() => {
    const themeChanged = previousThemeRef.current !== theme;
    previousThemeRef.current = theme;
    requestRef.current += 1;
    setSession(null);
    setError(null);
    setBusy(false);
    if (target) void start(themeChanged);
    // Target URL and theme define the editor identity. Discovery refreshes
    // replace the target object every few seconds, so avoid depending on it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.url, theme]);

  const stop = async () => {
    if (!session || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/v1/coding/code-server/stop"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workspaceId: session.workspaceId }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok || !body?.ok) throw new Error(body?.error || `VS Code failed to stop (${response.status})`);
      setSession(null);
    } catch (stopError) {
      setError(stopError instanceof Error ? stopError.message : "VS Code failed to stop");
    } finally {
      setBusy(false);
    }
  };

  if (!target) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center">
        <div className="max-w-sm">
          <Code2 className="mx-auto h-6 w-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium">No app workspace selected</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Choose an active preview port to detect its project folder and open it in VS Code.</p>
        </div>
      </div>
    );
  }

  const editorUrl = session
    ? `${window.location.protocol}//${window.location.hostname}:${session.port}/`
    : null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/70 px-2">
        <Code2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={session?.cwd ?? target.cwd}>
          {session?.cwd ?? target.cwd ?? `:${target.port} ${target.label}`}
        </div>
        {session && (
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[10px] text-muted-foreground" onClick={() => navigate("/coding")}>
            Open Coding
          </Button>
        )}
        {session && (
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" onClick={() => window.open(editorUrl!, "_blank", "noopener,noreferrer")} aria-label="Open VS Code externally">
            <ExternalLink className="h-3.5 w-3.5" />
          </Button>
        )}
        {session && (
          <Button type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground" disabled={busy} onClick={() => void stop()} aria-label="Stop VS Code">
            <Square className="h-3.5 w-3.5" />
          </Button>
        )}
        <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[10px]" disabled={busy} onClick={() => void start(Boolean(session))}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : session ? <RotateCw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {session ? "Restart" : "Start"}
        </Button>
      </div>

      <div className="relative min-h-0 flex-1">
        {editorUrl ? (
          <iframe
            key={editorUrl}
            src={editorUrl}
            title={`VS Code - ${session?.workspaceName ?? target.label}`}
            className="h-full w-full border-0 bg-white"
            allow="clipboard-read; clipboard-write"
          />
        ) : (
          <div className="flex h-full items-center justify-center p-8 text-center">
            <div className="max-w-sm">
              {busy ? <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" /> : <Code2 className="mx-auto h-6 w-6 text-muted-foreground" />}
              <p className="mt-3 text-sm font-medium text-foreground">{busy ? "Opening workspace" : error ? "VS Code unavailable" : "VS Code stopped"}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{error ?? target.cwd ?? "Start the editor for this preview workspace."}</p>
              {!busy && (
                <Button type="button" size="sm" className="mt-4 h-8 px-3 text-xs" onClick={() => void start(false)}>
                  <Play className="h-3.5 w-3.5" />
                  {error ? "Retry" : "Start VS Code"}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
