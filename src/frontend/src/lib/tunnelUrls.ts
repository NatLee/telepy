/**
 * Terminal page URL builder and shared types.
 * Centralizes URL construction for terminal/browser/files entry points.
 */

/** The three possible main views on the terminal page. */
export type TerminalMainView = "terminal" | "browser" | "files";

/**
 * Build the URL for the terminal page.
 * @param tunnel - Object with tunnel id and reverse_port.
 * @param options - Optional mainView to open a specific tab; `lanHost` (+ `lanUser`) opens the
 *   shell on a machine of the device's LAN, reached through the device.
 */
export function getTerminalPageUrl(
    tunnel: { id: number; reverse_port: number },
    options?: { mainView?: TerminalMainView; lanHost?: number; lanUser?: string }
): string {
    let url = `/tunnels/terminal?serverId=${tunnel.id}&port=${tunnel.reverse_port}`;
    if (options?.mainView && options.mainView !== "terminal") {
        url += `&mainView=${options.mainView}`;
    }
    if (options?.lanHost !== undefined) {
        url += `&lanHost=${options.lanHost}`;
        if (options.lanUser) url += `&lanUser=${encodeURIComponent(options.lanUser)}`;
    }
    return url;
}
