/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The registry the catalogue links to ("owner/repo"). */
  readonly VITE_INK_REGISTRY?: string;
}
