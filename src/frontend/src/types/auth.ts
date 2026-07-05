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
}

export interface AuthContextType {
    accessToken: string | null;
    isAuthenticated: boolean;
    isLoading: boolean;
    user: UserProfile | null;
    login: (access: string, refresh: string) => void;
    logout: () => void;
    fetchUserProfile: () => Promise<void>;
}
