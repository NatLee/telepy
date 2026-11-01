/** 
 * 認證相關型別 / Authentication types
 * Defines the shapes for user profiles and the authentication context.
 */

export interface UserProfile {
    id?: number;
    username?: string;
    email?: string;
    is_superuser?: boolean;
    /** 介面語言偏好;null = 從未設定過(見 lib/i18n.tsx 的同步規則)。
     *  UI language preference; null = never chosen (see the sync rules in lib/i18n.tsx). */
    language?: "auto" | "en" | "zh-TW" | "ja" | null;
    /** 介面主題;server 為準,登入後套用(lib/userPrefs.ts)。/ UI theme, server-authoritative. */
    theme?: "system" | "light" | "dark";
    /** 終端機字型大小(px, 10–24)。/ Web terminal font size. */
    terminal_font_size?: number;
    /** 終端機字型 / 配色 id(lib/terminalAppearance.ts)。/ Terminal font / colour-scheme ids. */
    terminal_font?: string;
    terminal_scheme?: string;
    /** 粗體的畫法(face / bright / both)與連字。/ Bold style and ligatures. */
    terminal_bold?: string;
    terminal_ligatures?: boolean;
    /** 各頁的卡片 / 清單顯示（lib/viewModes.ts）。/ Card / list view per page. */
    view_modes?: Record<string, string>;
    /** 遠端桌面的偏好（null = 帳號還沒選過）。/ Remote desktop preferences (null = never chosen). */
    desktop_display?: unknown;
    /** Tapi（彩蛋）十字髮夾的顏色；空 = 還沒找到 Tapi；`daily` = 每天換一個。/ Tapi's clip colour; empty = not found yet. */
    tapi_color?: string;
    /** 「每天換一個」解鎖了（看完片尾名單）。/ "Daily" is unlocked (watched the credits). */
    tapi_daily?: boolean;
    /** Tapi 偶爾自己來串門子（預設 true）。/ Tapi drops by now and then (default true). */
    tapi_visits?: boolean;
    /** 介面顯示大小(%, 85–130;lib/userPrefs.ts)。/ UI display scale in percent. */
    ui_scale?: number;
    /** 已設定任一第二因素。/ A passkey or an authenticator app is set up. */
    mfa_enabled?: boolean;
    /** 管理員要求、但這個帳號還沒設定的因素；非空時只能先完成設定（components/auth/EnrollmentGate）。
     *  Second factors the admin requires that this account still lacks; while non-empty the app shows the enrollment gate. */
    mfa_missing?: RequiredFactor[];
    /** 這個人能用的功能 id（管理員 = 全部；lib/features.ts）。沒有 = 舊後端，當作全部可以。
     *  Feature ids this person may use (all for admins; lib/features.ts). Missing = older backend, treat as all. */
    features?: string[];
}

export type RequiredFactor = "totp" | "passkey";

export interface AuthContextType {
    accessToken: string | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    user: UserProfile | null;
    login: (access: string, refresh: string) => void;
    /** next：登入後回到的站內路徑。/ next: the same-origin path to return to after signing in. */
    logout: (next?: string) => void;
    fetchUserProfile: () => Promise<void>;
}
