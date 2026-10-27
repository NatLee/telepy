/**
 * 目前登入的人能用哪些功能（profile 的 `features`；管理員 = 全部）。用來把導覽、選單、按鈕藏起來——真正的門在 API。
 * Which features the signed-in person may use (the profile's `features`; admins have all). Hides nav items, menu
 * entries and buttons; the API is the real gate.
 */
import { useCallback } from "react";
import { useAuth } from "@/lib/auth";
import { hasFeature, type FeatureId } from "@/lib/features";

export function useFeatures() {
    const { user } = useAuth();
    const has = useCallback((id: FeatureId) => hasFeature(user, id), [user]);
    return { has };
}
