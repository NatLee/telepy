/**
 * 通道詳細資訊視窗的邏輯:載入通道、可編輯的主機別名 / 公鑰 / 描述(只送有改的欄位),
 * 後端的欄位錯誤(別名或公鑰與別條通道重複)顯示在對應欄位旁。
 * Tunnel details dialog logic: load the tunnel, edit alias / public key / description (only changed
 * fields are sent), and surface the backend's field errors (duplicate alias or key) next to the field.
 */
import { useEffect, useMemo, useState } from "react";
import { apiFetch, readJson, responseError } from "@/lib/api";
import { useToast } from "@/components/ui/Toast";
import { useI18n } from "@/lib/i18n";
import { useTunnelNameError } from "@/components/tunnels/TunnelNameHelp";
import { keyProblem } from "@/lib/sshKeys";
import { parseLabels, sameLabels } from "@/lib/tunnelLabels";
import type { TranslationKey } from "@/locales/en";
import type { TunnelEndpoint } from "@/types/tunnel";

export interface TunnelDetails {
    id: number;
    host_friendly_name: string;
    key: string;
    reverse_port: number;
    description: string | null;
    user_permission: "owner" | "admin" | "edit" | "view" | null;
    is_owner: boolean;
    can_edit: boolean;
    created_at?: string;
    updated_at?: string;
    shared_with_count?: number;
    labels?: string[];
    /** 開 session 前要確認是你。/ Sessions ask for a step-up first. */
    require_step_up?: boolean;
    /** 網頁終端機會錄影。/ Web terminal sessions are recorded. */
    record_sessions?: boolean;
    terminal_detach_policy?: "user" | "never";
    /** 裝置的位址與基本狀況（能登入裝置的人才有，否則 null）。/ Addresses and facts (null when hidden). */
    endpoint?: TunnelEndpoint | null;
}

export type TunnelForm = { host_friendly_name: string; key: string; description: string };
export type TunnelFormErrors = Partial<Record<keyof TunnelForm | "labels", string>>;

const PROBLEM: Record<NonNullable<ReturnType<typeof keyProblem>>, TranslationKey> = {
    invalid: "keys.problem.invalid",
    multiline: "keys.problem.multiline",
    dsa: "keys.problem.dsa",
    rsaShort: "keys.problem.rsaShort",
};

export function useTunnelDetailsModal(tunnelId: number | null, isOpen: boolean, onUpdate: () => void, onClose: () => void) {
    const { t } = useI18n();
    const nameError = useTunnelNameError();
    const [details, setDetails] = useState<TunnelDetails | null>(null);
    const [loading, setLoading] = useState(false);
    const [form, setForm] = useState<TunnelForm>({ host_friendly_name: "", key: "", description: "" });
    const [errors, setErrors] = useState<TunnelFormErrors>({});
    // 標籤另外存（另一支 API：PUT …/labels）。/ Labels are kept apart (their own endpoint).
    const [labelsText, setLabelsTextState] = useState("");
    const [isSaving, setIsSaving] = useState(false);
    const { showSuccess, showError } = useToast();

    useEffect(() => {
        if (!isOpen || !tunnelId) return;
        let cancelled = false;
        (async () => {
            setLoading(true);
            setErrors({});
            try {
                const res = await apiFetch(`/api/reverse/server/keys/${tunnelId}`);
                const data = await readJson<TunnelDetails>(res);
                if (cancelled) return;
                if (res.ok && data) {
                    setDetails(data);
                    setForm({ host_friendly_name: data.host_friendly_name ?? "", key: data.key ?? "", description: data.description ?? "" });
                    setLabelsTextState((data.labels ?? []).join(", "));
                } else {
                    showError(responseError(res, data, t("tunnelDetails.fetchFailed")));
                }
            } catch (e) {
                if (!cancelled) showError(e instanceof Error ? e.message : t("tunnelDetails.fetchFailed"));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, tunnelId]);

    // 關閉後清掉上一條通道的資料,下次打開不會先閃一下舊內容。/ Drop the previous tunnel on close.
    useEffect(() => {
        if (!isOpen) {
            setDetails(null);
            setErrors({});
        }
    }, [isOpen]);

    const canEdit = !!details && details.user_permission !== "view";
    const setField = (name: keyof TunnelForm, value: string) => {
        setForm((f) => ({ ...f, [name]: value }));
        // 刪掉而不是設成 undefined:合併 {...live, ...server} 時 undefined 會蓋掉即時檢查的錯誤。
        // Delete rather than set undefined, which would shadow the live error when merging.
        setErrors((e) => {
            if (!(name in e)) return e;
            const next = { ...e };
            delete next[name];
            return next;
        });
    };

    const setLabelsText = (value: string) => {
        setLabelsTextState(value);
        setErrors((e) => {
            if (!("labels" in e)) return e;
            const next = { ...e };
            delete next.labels;
            return next;
        });
    };
    const labelCheck = useMemo(() => parseLabels(labelsText), [labelsText]);
    const labelsChanged = !!details && !sameLabels(labelCheck.labels, details.labels ?? []);

    /** 只送有改的欄位。/ Only the changed fields. */
    const patch = useMemo(() => {
        if (!details) return {};
        const p: Partial<TunnelForm> = {};
        if (form.host_friendly_name.trim() !== details.host_friendly_name) p.host_friendly_name = form.host_friendly_name.trim();
        if (form.key.trim() !== details.key) p.key = form.key.trim();
        if (form.description !== (details.description ?? "")) p.description = form.description;
        return p;
    }, [details, form]);
    const dirty = Object.keys(patch).length > 0 || labelsChanged;
    const keyChanged = patch.key !== undefined;
    // 名稱 / 描述 / 標籤有改（「基本資料」分頁上的點）。/ Name, description or labels changed (the Basics tab's dot).
    const basicsDirty = labelsChanged || Object.keys(patch).some((k) => k !== "key");

    // 即時檢查(後端會再檢查一次):別名必填、公鑰格式 / 強度。/ Live checks; the backend re-validates.
    const liveErrors: TunnelFormErrors = {};
    if (details && !form.host_friendly_name.trim()) liveErrors.host_friendly_name = t("tunnelDetails.nameRequired");
    // 改了名才照規則檢查（規則之前的舊名稱沒改就照樣能存）。/ Only a changed name is checked against the rule.
    else if (patch.host_friendly_name !== undefined) {
        const nameMsg = nameError(patch.host_friendly_name);
        if (nameMsg) liveErrors.host_friendly_name = nameMsg;
    }
    if (keyChanged) {
        const problem = form.key.trim() ? keyProblem(form.key) : "invalid";
        if (problem) liveErrors.key = t(PROBLEM[problem]);
    }
    if (labelCheck.invalid.length) liveErrors.labels = t("tunnelDetails.labelInvalid", { label: labelCheck.invalid[0] });
    else if (labelCheck.tooMany) liveErrors.labels = t("tunnelDetails.labelsTooMany");
    const valid = Object.keys(liveErrors).length === 0;

    /** 存檔；後端擋下的欄位錯誤也回傳，讓對話框跳到那一頁。/ Save; returns the backend's field errors so the dialog can jump to their tab. */
    const save = async (): Promise<TunnelFormErrors | null> => {
        if (!tunnelId || !dirty || !valid) return null;
        setIsSaving(true);
        try {
            if (labelsChanged) {
                const lr = await apiFetch(`/api/reverse/server/${tunnelId}/labels`, { method: "PUT", body: JSON.stringify({ labels: labelCheck.labels }) });
                const lb = await readJson<Record<string, unknown>>(lr);
                if (!lr.ok) {
                    const v = lb?.labels;
                    if (Array.isArray(v) && v[0]) {
                        const labelErrors = { labels: String(v[0]) };
                        setErrors(labelErrors);
                        return labelErrors;
                    }
                    showError(responseError(lr, lb, t("tunnelDetails.updateFailed")));
                    return null;
                }
                if (Object.keys(patch).length === 0) {
                    showSuccess(t("tunnelDetails.updated"));
                    onUpdate();
                    onClose();
                    return null;
                }
            }
            const res = await apiFetch(`/api/reverse/server/keys/${tunnelId}`, { method: "PATCH", body: JSON.stringify(patch) });
            const body = await readJson<Record<string, unknown>>(res);
            if (res.ok) {
                showSuccess(t("tunnelDetails.updated"));
                onUpdate();
                onClose();
                return null;
            }
            // 欄位錯誤 {field: [msg]}:重複的別名 / 公鑰翻成好懂的句子,其餘照後端文字顯示。
            // Field errors {field: [msg]}: duplicates get a friendly sentence, anything else is shown verbatim.
            const fieldErrors: TunnelFormErrors = {};
            for (const field of ["host_friendly_name", "key", "description"] as const) {
                const v = body?.[field];
                const msg = Array.isArray(v) ? String(v[0] ?? "") : typeof v === "string" ? v : "";
                if (!msg) continue;
                fieldErrors[field] = msg.includes("already exists")
                    ? t(field === "key" ? "tunnelDetails.keyTaken" : "tunnelName.taken")
                    : msg;
            }
            if (Object.keys(fieldErrors).length) {
                setErrors(fieldErrors);
                return fieldErrors;
            }
            showError(responseError(res, body, t("tunnelDetails.updateFailed")));
            return null;
        } catch (e) {
            showError(e instanceof Error ? e.message : t("tunnelDetails.updateFailed"));
            return null;
        } finally {
            setIsSaving(false);
        }
    };

    return {
        state: { details, loading, form, labelsText, labels: labelCheck.labels, errors: { ...liveErrors, ...errors }, canEdit, dirty, basicsDirty, keyChanged, valid, isSaving },
        actions: { setField, setLabelsText, save },
    };
}
