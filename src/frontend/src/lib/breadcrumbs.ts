/**
 * 頁首麵包屑：哪幾段能點。最後一段是「你在這裡」不能點——除非它指的網址不是目前這頁（例如在「即時連線」底下的觀看頁，
 * 「即時連線」那段要能點回去）；前面每一段都是連結。純函式。
 * The header breadcrumb: which crumbs are links. The last crumb is "you are here" and not a link — unless its URL is not
 * the current page (on the watch page under Live sessions, "Live sessions" must lead back); every earlier crumb is. Pure.
 */

export interface Crumb {
    label: string;
    href?: string;
}

export interface ShownCrumb extends Crumb {
    /** 畫成連結。/ Drawn as a link. */
    link: boolean;
    /** 最後一段（aria-current）。/ The last crumb (aria-current). */
    current: boolean;
}

export function shownCrumbs(crumbs: Crumb[], pathname: string): ShownCrumb[] {
    const last = crumbs.length - 1;
    return crumbs.map((c, i) => ({
        ...c,
        current: i === last,
        link: !!c.href && (i < last || c.href !== pathname),
    }));
}
