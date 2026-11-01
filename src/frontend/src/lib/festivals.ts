/**
 * 品牌圖示的節日彩蛋：Telepy 生日（2/18，第一個 commit 是 2024-02-18）、農曆新年（除夕到元宵）與萬聖節（10/31）。
 * 農曆用瀏覽器內建的 `Intl` 中國曆（`ca-chinese`），不寫死日期表；不支援的環境就不顯示。生日優先。
 * Festival easter eggs for the brand tile: Telepy's birthday (18 Feb; the first commit is 2024-02-18), Lunar New
 * Year (eve through the 15th day) and Halloween (31 Oct). The lunar date comes from the built-in `Intl` Chinese calendar — no date table;
 * environments without it simply show nothing. The birthday wins when both fall on one day.
 * 純函式、不依賴 React，`festivals.test.ts` 有測試。/ Pure; tested in festivals.test.ts.
 */

export const TELEPY_BIRTHDAY = { year: 2024, month: 2, day: 18 } as const;

export type Festival = { kind: "birthday"; age: number } | { kind: "lunarNewYear" } | { kind: "halloween" };

/** 萬聖節：10/31（Tapi 是幽靈，這天它扮成幽靈）。/ Halloween, 31 Oct (Tapi is a ghost, so it dresses up as one). */
export const HALLOWEEN = { month: 10, day: 31 } as const;

function parts(date: Date, locale: string, timeZone?: string): Record<string, string> {
    const f = new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric", timeZone });
    if (locale.includes("ca-chinese") && f.resolvedOptions().calendar !== "chinese") return {};
    return Object.fromEntries(f.formatToParts(date).map((p) => [p.type, p.value]));
}

/** 農曆幾月幾日（閏月的 month 會是 "4bis" 之類，所以用字串比）；不支援就 null。/ Lunar month / day, or null. */
export function lunarDate(date: Date, timeZone?: string): { month: string; day: number } | null {
    try {
        const p = parts(date, "en-u-ca-chinese", timeZone);
        if (!p.month || !p.day) return null;
        return { month: p.month, day: Number(p.day) };
    } catch {
        return null;
    }
}

/** `timeZone` 只給測試用；畫面上用使用者的時區。/ `timeZone` is for tests; the UI uses the local zone. */
export function festivalOn(date: Date, timeZone?: string): Festival | null {
    const g = parts(date, "en-US", timeZone);
    const year = Number(g.year);
    if (Number(g.month) === TELEPY_BIRTHDAY.month && Number(g.day) === TELEPY_BIRTHDAY.day && year > TELEPY_BIRTHDAY.year) {
        return { kind: "birthday", age: year - TELEPY_BIRTHDAY.year };
    }
    if (Number(g.month) === HALLOWEEN.month && Number(g.day) === HALLOWEEN.day) return { kind: "halloween" };
    const today = lunarDate(date, timeZone);
    if (today?.month === "1" && today.day <= 15) return { kind: "lunarNewYear" };
    const tomorrow = lunarDate(new Date(date.getTime() + 86_400_000), timeZone);
    if (tomorrow?.month === "1" && tomorrow.day === 1) return { kind: "lunarNewYear" };
    return null;
}
