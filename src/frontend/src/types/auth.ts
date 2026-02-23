/** 
 * 認證相關型別 / Authentication types
 * Defines the shapes for user profiles and the authentication context.
 */

export interface UserProfile {
    id?: number;
    username?: string;
    email?: string;
    is_superuser?: boolean;
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
