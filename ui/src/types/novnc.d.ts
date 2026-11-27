declare module "@novnc/novnc" {
  type DisconnectDetail = { clean: boolean };
  type SecurityFailureDetail = { status: number; reason: string };

  export default class RFB {
    constructor(
      target: HTMLElement,
      url: string,
      options?: { credentials?: Record<string, string>; shared?: boolean; repeaterID?: string },
    );

    background: string;
    compressionLevel: number;
    focusOnClick: boolean;
    qualityLevel: number;
    resizeSession: boolean;
    scaleViewport: boolean;
    showDotCursor: boolean;
    viewOnly: boolean;

    addEventListener(type: "connect", listener: (event: Event) => void): void;
    addEventListener(type: "disconnect", listener: (event: CustomEvent<DisconnectDetail>) => void): void;
    addEventListener(type: "securityfailure", listener: (event: CustomEvent<SecurityFailureDetail>) => void): void;
    addEventListener(type: "credentialsrequired", listener: (event: CustomEvent<{ types: string[] }>) => void): void;
    /** The desktop's clipboard changed (ServerCutText). */
    addEventListener(type: "clipboard", listener: (event: CustomEvent<{ text: string }>) => void): void;
    /** Put text on the desktop's clipboard (ClientCutText; ignored while view-only). */
    clipboardPasteFrom(text: string): void;
    sendCredentials(credentials: Record<string, string>): void;
    disconnect(): void;
    focus(options?: { preventScroll?: boolean }): void;
  }
}
