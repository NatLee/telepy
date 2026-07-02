// Minimal type declaration for @novnc/novnc (the package ships no .d.ts).
// Only the surface we use in RemoteBrowserPanel is declared.
declare module "@novnc/novnc/lib/rfb" {
    export interface RFBOptions {
        shared?: boolean;
        credentials?: { username?: string; password?: string; target?: string };
        repeaterID?: string;
        wsProtocols?: string[];
    }
    export default class RFB extends EventTarget {
        /** urlOrChannel may be a ws(s):// URL string OR an already-open WebSocket. */
        constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);
        viewOnly: boolean;
        focusOnClick: boolean;
        clipViewport: boolean;
        dragViewport: boolean;
        scaleViewport: boolean;
        resizeSession: boolean;
        showDotCursor: boolean;
        background: string;
        qualityLevel: number;
        compressionLevel: number;
        disconnect(): void;
        sendCtrlAltDel(): void;
        focus(): void;
        blur(): void;
        clipboardPasteFrom(text: string): void;
    }
}
