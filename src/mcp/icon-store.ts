/**
 * Custom connectors' icons: discovered (src/mcp/icons.ts) or set by the person, stored next to the
 * connectors' config (`<.polpo>/connector-icons/<id>.light|dark`, the bytes; `iconAsset` in
 * connectors.json, the metadata) and served by GET /api/v1/connectors/:id/icon.
 *
 * Catalog connectors are never looked up: they keep their bundled official icon (ui/public/connector-icons).
 *
 * Discovery runs in the background and never blocks or fails a connection: when a custom connector
 * is created, when it connects (the server's `serverInfo` may carry icons), and lazily when the list is
 * read (existing connectors get theirs after an upgrade), at most once a day when nothing was found.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONNECTOR_ID_PATTERN, type ConnectorConfig, type ConnectorIconAsset, type ConnectorIconImage, type ConnectorIconSource } from "@polpo-ai/core";
import {
  decodeDataUri, discoverConnectorIcon, guardedFetcher, iconHash, IconFetchError, ICON_MAX_BYTES, toIconImage,
  type FetchPolicy, type IconFetcher, type IconImage,
} from "./icons.js";
import type { ConnectorStore } from "./store.js";
import { hostedBundledIcon } from "./view.js";

/** How long after a discovery that found nothing it is tried again (on list / connect). */
const RETRY_AFTER_MS = 24 * 60 * 60_000;
/** A discovered icon is looked up again on connect after this long. */
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60_000;

export type IconTheme = "light" | "dark";

export interface ConnectorIconsOptions {
  polpoDir: string;
  store: ConnectorStore;
  policy: () => FetchPolicy;
  /** Look icons up on create / connect / list (the server). Off: only explicit refreshes and overrides. */
  autoDiscover?: () => boolean;
  /** Tests: the network. */
  fetcher?: IconFetcher;
  /** An icon was stored or removed. */
  onChange?: (id: string) => void;
  log?: (message: string) => void;
}

export interface ServerInfoIcons {
  icons?: unknown;
  websiteUrl?: unknown;
}

export class IconInputError extends Error {}

/** Whether a connector gets a discovered / custom icon (not a catalog one, nor a ready-made hosted server's bundled mark). */
export const iconEligible = (c: Pick<ConnectorConfig, "catalogId"> & Partial<Pick<ConnectorConfig, "icon" | "transport">>) =>
  !c.catalogId && !hostedBundledIcon(c).iconUrl;

const ageMs = (iso: string | undefined) => (iso ? Date.now() - Date.parse(iso) : Infinity);

export class ConnectorIcons {
  readonly dir: string;
  private readonly inflight = new Map<string, Promise<ConnectorIconAsset | undefined>>();
  /** The last `serverInfo` seen per connector (this process). */
  private readonly serverInfo = new Map<string, ServerInfoIcons>();

  constructor(private readonly options: ConnectorIconsOptions) {
    this.dir = join(options.polpoDir, "connector-icons");
  }

  get autoDiscover(): boolean {
    return !!this.options.autoDiscover?.();
  }

  private fetcher(): IconFetcher {
    return this.options.fetcher ?? guardedFetcher(this.options.policy());
  }

  private log(message: string): void {
    this.options.log?.(message);
  }

  private file(id: string, theme: IconTheme): string {
    if (!CONNECTOR_ID_PATTERN.test(id)) throw new Error(`Invalid connector id "${id}"`);
    return join(this.dir, `${id}.${theme}`);
  }

  private writeImage(id: string, theme: IconTheme, image: IconImage): ConnectorIconImage {
    mkdirSync(this.dir, { recursive: true });
    const target = this.file(id, theme);
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, image.bytes, { mode: 0o600 });
    renameSync(tmp, target);
    return {
      mimeType: image.mimeType, hash: iconHash(image.bytes),
      ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}),
      ...(image.src && !image.src.startsWith("data:") ? { src: image.src } : {}),
    };
  }

  private removeFiles(id: string, themes: IconTheme[] = ["light", "dark"]): void {
    for (const theme of themes) {
      try { rmSync(this.file(id, theme), { force: true }); } catch { /* ignore */ }
    }
  }

  /** Store images as the connector's icon (or forget it) and announce it. */
  private save(id: string, light: IconImage | undefined, extra: { source?: ConnectorIconSource; dark?: IconImage; pinned?: boolean } = {}): ConnectorIconAsset | undefined {
    const now = new Date().toISOString();
    if (!this.options.store.get(id)) return undefined;
    let asset: ConnectorIconAsset | undefined;
    if (light && extra.source) {
      const main = this.writeImage(id, "light", light);
      const dark = extra.dark ? this.writeImage(id, "dark", extra.dark) : undefined;
      if (!dark) this.removeFiles(id, ["dark"]);
      asset = { ...main, source: extra.source, ...(dark ? { dark } : {}), fetchedAt: now, ...(extra.pinned ? { pinned: true } : {}) };
    }
    const saved = this.options.store.setIcon(id, asset, now);
    if (!saved) {
      // removed meanwhile
      this.removeFiles(id);
      return undefined;
    }
    if (!asset) this.removeFiles(id);
    this.options.onChange?.(id);
    return asset;
  }

  /** The stored image of a connector (undefined when it has none, or for a catalog connector). */
  read(connector: ConnectorConfig, theme: IconTheme = "light"): { bytes: Buffer; mimeType: string; hash: string } | undefined {
    const asset = connector.iconAsset;
    if (!asset || !iconEligible(connector)) return undefined;
    const image = theme === "dark" && asset.dark ? asset.dark : asset;
    const file = this.file(connector.id, theme === "dark" && asset.dark ? "dark" : "light");
    if (!existsSync(file)) return undefined;
    try {
      return { bytes: readFileSync(file), mimeType: image.mimeType, hash: image.hash };
    } catch {
      return undefined;
    }
  }

  /**
   * Look the icon up now (deduplicated per connector). A pinned icon set from a URL is fetched again;
   * an uploaded one is kept. Never throws: failures are logged and the connector keeps what it had.
   */
  refresh(id: string, serverInfo?: ServerInfoIcons): Promise<ConnectorIconAsset | undefined> {
    if (serverInfo) this.serverInfo.set(id, serverInfo);
    const running = this.inflight.get(id);
    if (running) return running;
    const run = (async () => {
      // registered as in flight before any of this runs (a synchronous finish would otherwise stay cached)
      await Promise.resolve();
      const connector = this.options.store.get(id);
      if (!connector || !iconEligible(connector)) return undefined;
      const current = connector.iconAsset;
      try {
        if (current?.pinned) {
          if (current.source !== "url" || !current.src) return current;
          return await this.setFromUrl(id, current.src);
        }
        const url = connector.transport.type === "stdio" ? undefined : connector.transport.url;
        const found = await discoverConnectorIcon({
          ...(url ? { serverUrl: url } : {}),
          ...(this.serverInfo.get(id) ? { serverInfo: this.serverInfo.get(id) } : {}),
          oauth: connector.auth.type === "oauth",
          ...(connector.auth.oauth?.authorizationServer ? { authorizationServer: connector.auth.oauth.authorizationServer } : {}),
        }, { fetch: this.fetcher(), log: (m) => this.log(`${id}: ${m}`) });
        // a pin or a removal may have happened meanwhile
        const latest = this.options.store.get(id);
        if (!latest || latest.iconAsset?.pinned) return latest?.iconAsset;
        if (!found) {
          // keep a previous icon (the site may be down); remember the attempt
          this.options.store.setIcon(id, latest.iconAsset, new Date().toISOString());
          this.log(`${id}: no icon found`);
          return latest.iconAsset;
        }
        const asset = this.save(id, found.light, { source: found.source, ...(found.dark ? { dark: found.dark } : {}) });
        this.log(`${id}: icon from ${found.source}${found.light.src ? ` (${found.light.src})` : ""}`);
        return asset;
      } catch (err) {
        this.log(`${id}: icon discovery failed: ${err instanceof Error ? err.message : String(err)}`);
        if (this.options.store.get(id)) this.options.store.setIcon(id, this.options.store.get(id)?.iconAsset, new Date().toISOString());
        return this.options.store.get(id)?.iconAsset;
      } finally {
        this.inflight.delete(id);
      }
    })();
    this.inflight.set(id, run);
    return run;
  }

  /** Background lookup when a custom connector is created. */
  discoverSoon(id: string): void {
    if (!this.autoDiscover) return;
    void this.refresh(id);
  }

  /** A connection was made: the server's `serverInfo` may carry icons (they win over the other sources). */
  noteConnected(connector: ConnectorConfig, serverInfo: ServerInfoIcons | undefined): void {
    if (!this.autoDiscover || !iconEligible(connector)) return;
    const icons = Array.isArray(serverInfo?.icons) && serverInfo.icons.length > 0;
    const previous = this.serverInfo.get(connector.id);
    if (serverInfo) this.serverInfo.set(connector.id, { icons: serverInfo.icons, websiteUrl: serverInfo.websiteUrl });
    const asset = connector.iconAsset;
    if (asset?.pinned) return;
    const changed = icons && JSON.stringify(previous?.icons) !== JSON.stringify(serverInfo?.icons);
    const due = !asset ? ageMs(connector.iconCheckedAt) > RETRY_AFTER_MS || (icons && previous === undefined)
      : (icons && asset.source !== "mcp") || changed || ageMs(asset.fetchedAt) > REFRESH_AFTER_MS;
    if (due) void this.refresh(connector.id);
  }

  /** Lazily, when the list is read: custom connectors without an icon (e.g. added before this existed). */
  ensure(connectors: ConnectorConfig[]): void {
    if (!this.autoDiscover) return;
    for (const c of connectors) {
      if (!iconEligible(c) || c.iconAsset || this.inflight.has(c.id)) continue;
      if (ageMs(c.iconCheckedAt) < RETRY_AFTER_MS) continue;
      void this.refresh(c.id);
    }
  }

  /** The person's choice: an image from a URL (fetched once, server side). */
  async setFromUrl(id: string, raw: string): Promise<ConnectorIconAsset | undefined> {
    this.assertEligible(id);
    let image: IconImage;
    try {
      const res = await this.fetcher()(raw, { maxBytes: ICON_MAX_BYTES, accept: "image/svg+xml,image/png,image/x-icon,image/*;q=0.8" });
      if (res.status !== 200) throw new IconFetchError(`HTTP ${res.status}`);
      image = toIconImage(res.body, raw);
    } catch (err) {
      throw new IconInputError(`Could not use that image: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.save(id, image, { source: "url", pinned: true });
  }

  /** The person's choice: an uploaded image (a data URI). */
  setFromUpload(id: string, dataUri: string): ConnectorIconAsset | undefined {
    this.assertEligible(id);
    let image: IconImage;
    try {
      image = toIconImage(decodeDataUri(dataUri));
    } catch (err) {
      throw new IconInputError(`Could not use that image: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.save(id, { ...image, src: undefined }, { source: "upload", pinned: true });
  }

  /** Back to automatic: forget the icon and look it up again. */
  async reset(id: string): Promise<ConnectorIconAsset | undefined> {
    this.assertEligible(id);
    this.save(id, undefined);
    return this.refresh(id);
  }

  /** The connector is gone. */
  remove(id: string): void {
    this.serverInfo.delete(id);
    if (CONNECTOR_ID_PATTERN.test(id)) this.removeFiles(id);
  }

  private assertEligible(id: string): void {
    const connector = this.options.store.get(id);
    if (!connector) throw new IconInputError(`No connector "${id}"`);
    if (!iconEligible(connector)) throw new IconInputError(`${connector.name} is a catalog connector: it uses its official icon`);
  }
}
