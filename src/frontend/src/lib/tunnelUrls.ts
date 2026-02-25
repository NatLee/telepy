/**
 * Terminal page URL builder and shared types.
 * Centralizes URL construction for terminal/browser/files entry points.
 */

/** The three possible main views on the terminal page. */
export type TerminalMainView = "terminal" | "browser" | "files";

/**
 * Build the URL for the terminal page.
 * @param tunnel - Object with tunnel id and reverse_port.
 * @param options - Optional mainView to open a specific tab.
 */
export function getTerminalPageUrl(
    tunnel: { id: number; reverse_port: number },
    options?: { mainView?: TerminalMainView }
): string {
    const base = `/tunnels/terminal?serverId=${tunnel.id}&port=${tunnel.reverse_port}`;
    if (options?.mainView && options.mainView !== "terminal") {
        return `${base}&mainView=${options.mainView}`;
    }
    return base;
}
