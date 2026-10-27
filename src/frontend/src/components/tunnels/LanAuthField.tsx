"use client";

/**
 * 區網主機那一跳「用什麼登入」的選單 + 「存一組登入」對話框。選項：Telepy 的金鑰（預設）、在終端機裡問密碼、
 * 憑證庫裡存給這台主機的 ssh 登入（密碼和 / 或私鑰，伺服器端加密，只有自己能用）。終端機選擇器與網路頁的主機面板共用。
 * The "log in with" select for the LAN hop plus the "save a login" dialog. Choices: Telepy's key (default), a password
 * prompt in the terminal, or an ssh login saved in the vault for this host (password and / or private key, sealed on the
 * server, usable only by you). Shared by the terminal picker and the network page's host panel.
 */
import React, { useState } from "react";
import { KeyRound, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/Toast";
import { useSavedLogins, type SavedLogin } from "@/hooks/useSavedLogins";
import { useI18n } from "@/lib/i18n";
import { lanAuthFromValue, lanAuthValue, type LanAuth } from "@/lib/lanAuth";
import type { TranslationKey } from "@/locales/en";

interface Props {
    tunnelId: number;
    hostId: number;
    hostName: string;
    /** 目前的登入名（存登入時預填）。/ The current login name (prefilled when saving). */
    login: string;
    value: LanAuth;
    onChange: (auth: LanAuth) => void;
    id?: string;
    disabled?: boolean;
}

const HINT: Record<LanAuth["kind"], TranslationKey> = { telepy: "lanAuth.hint.telepy", prompt: "lanAuth.hint.prompt", credential: "lanAuth.hint.saved" };

/** 選項裡的名字：標籤（登入名）。/ The option text: label (login). */
export function savedLoginText(c: SavedLogin): string {
    return c.login ? `${c.label} (${c.login})` : c.label;
}

/** 只有選單與「存一組」按鈕，外層自己決定標籤的畫法。/ The select and the save button; the caller draws the label. */
export function LanAuthSelect({ tunnelId, hostId, hostName, login, value, onChange, id, disabled }: Props) {
    const { t } = useI18n();
    const saved = useSavedLogins({ tunnelId, hostId, protocol: "ssh" }, true);
    const [open, setOpen] = useState(false);
    const current = lanAuthValue(value);
    // 存的那筆被刪了：回到預設。/ The chosen saved login vanished: back to the default.
    const known = value.kind !== "credential" || saved.list.some((c) => c.id === value.id);
    return (
        <>
            <div className="flex gap-2">
                <NativeSelect id={id} value={known ? current : "telepy"} onChange={(e) => onChange(lanAuthFromValue(e.target.value))} disabled={disabled} className="min-w-0 flex-1">
                    <option value="telepy">{t("lanAuth.telepy")}</option>
                    <option value="prompt">{t("lanAuth.prompt")}</option>
                    {saved.list.map((c) => (
                        <option key={c.id} value={`cred:${c.id}`}>{t("lanAuth.savedOption", { name: savedLoginText(c) })}</option>
                    ))}
                </NativeSelect>
                <Button type="button" variant="outline" size="icon" className="size-9 shrink-0" onClick={() => setOpen(true)} disabled={disabled} title={t("lanAuth.save")} aria-label={t("lanAuth.save")}>
                    <Plus size={16} />
                </Button>
            </div>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">{t(HINT[known ? value.kind : "telepy"])}</p>
            <LanLoginDialog
                isOpen={open}
                onClose={() => setOpen(false)}
                tunnelId={tunnelId}
                hostId={hostId}
                hostName={hostName}
                login={login}
                create={saved.create}
                onSaved={(c) => onChange({ kind: "credential", id: c.id })}
            />
        </>
    );
}

interface DialogProps {
    isOpen: boolean;
    onClose: () => void;
    tunnelId: number;
    hostId: number;
    hostName: string;
    login: string;
    create: ReturnType<typeof useSavedLogins>["create"];
    onSaved: (c: SavedLogin) => void;
}

/** 存一組給這台主機的 ssh 登入：名稱、登入名、密碼和 / 或私鑰。/ Save an ssh login for this host. */
export function LanLoginDialog({ isOpen, onClose, tunnelId, hostId, hostName, login, create, onSaved }: DialogProps) {
    const { t } = useI18n();
    const { showSuccess } = useToast();
    const [label, setLabel] = useState("");
    const [user, setUser] = useState(login);
    const [password, setPassword] = useState("");
    const [key, setKey] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // 開啟時帶入目前的登入名。/ Seed the login name when the dialog opens.
    const [seededFor, setSeededFor] = useState<string | null>(null);
    if (isOpen && seededFor !== login) {
        setSeededFor(login);
        setUser(login);
    }
    const needOne = !password && !key.trim();
    const placeholder = `${user || "user"}@${hostName}`;

    const submit = async () => {
        if (needOne) {
            setError(t("lanLogin.needOne"));
            return;
        }
        setBusy(true);
        setError(null);
        const res = await create({
            label: label.trim() || placeholder,
            protocol: "ssh",
            tunnel_id: tunnelId,
            lan_host_id: hostId,
            port: null,
            login: user.trim(),
            domain: "",
            password,
            ...(key.trim() ? { private_key: key } : {}),
        });
        setBusy(false);
        if (typeof res === "string") {
            setError(res);
            return;
        }
        showSuccess(t("lanLogin.saved", { label: res.label }));
        setLabel("");
        setPassword("");
        setKey("");
        onSaved(res);
        onClose();
    };

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("lanLogin.title", { host: hostName })}
            description={t("lanLogin.description")}
            icon={<KeyRound />}
            size="lg"
            footer={
                <>
                    <Button variant="outline" onClick={onClose} disabled={busy}>{t("common.cancel")}</Button>
                    <Button onClick={() => void submit()} disabled={busy || needOne}>{t("lanLogin.save")}</Button>
                </>
            }
        >
            <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("lanLogin.label")} addon={t("common.optional")}>
                        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={placeholder} maxLength={100} />
                    </Field>
                    <Field label={t("lanLogin.login")}>
                        <Input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" autoCapitalize="off" spellCheck={false} className="font-mono" />
                    </Field>
                </div>
                <Field label={t("lanLogin.password")} addon={t("common.optional")} hint={t("lanLogin.passwordHint")}>
                    <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                </Field>
                <Field label={t("lanLogin.key")} addon={t("common.optional")} hint={t("lanLogin.keyHint")} error={error ?? undefined}>
                    <Textarea value={key} onChange={(e) => setKey(e.target.value)} rows={5} spellCheck={false} className="font-mono text-xs" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                </Field>
                <p className="text-xs text-muted-foreground">{t("lanLogin.note")}</p>
            </div>
        </Modal>
    );
}
