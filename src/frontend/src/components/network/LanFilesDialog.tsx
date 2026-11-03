"use client";

/**
 * 區網主機的檔案（網路頁的主機面板 → 「檔案」）：經裝置登入那台主機、開 SFTP，裡面就是平常的檔案管理（瀏覽、上傳、下載、
 * 編輯、搬移、權限），每個操作都落在那台主機上。登入方式跟面板的終端機一樣（Telepy 的金鑰 / 在這裡打密碼 / 存的登入）；
 * Telepy 的金鑰不收時可以改打密碼（只拿來登入，不存）。關掉視窗 = 關掉那個 session（沒傳完的暫存檔一起刪）。
 * A LAN host's files (the Network page's host panel → "Files"): log in to the host through the device, open SFTP, and
 * the usual file manager runs on it. The login method is the panel's; when Telepy's key is refused, a password can be
 * typed instead (used to log in, never stored). Closing the dialog closes the session (its unfinished uploads go too).
 */
import React, { useEffect, useState } from "react";
import { FolderOpen, KeyRound, Loader2, RefreshCw } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FileManagerPanel } from "@/components/tunnels/FileManagerPanel";
import { useAuth } from "@/lib/auth";
import { useI18n } from "@/lib/i18n";
import { offerPassword } from "@/lib/lanFiles";
import type { LanAuth } from "@/lib/lanAuth";
import { useLanFiles } from "@/hooks/useLanFiles";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import type { LanHost, TopologyTunnel } from "@/types/lan";

interface Props {
    isOpen: boolean;
    onClose: () => void;
    tunnel: TopologyTunnel;
    host: LanHost;
    name: string;
    login: string;
    deviceUser: string | null;
    auth: LanAuth;
}

/** 視窗開著才掛上（關掉 = 狀態與 session 都重來）。/ Mounted only while open (closing starts over). */
export function LanFilesDialog(props: Props) {
    if (!props.isOpen) return null;
    return <LanFilesBody {...props} />;
}

function LanFilesBody({ onClose, tunnel, host, name, login, deviceUser, auth }: Props) {
    const { t } = useI18n();
    const { accessToken } = useAuth();
    const { phase, open, close, askPassword } = useLanFiles(tunnel.id, host.id);
    // 改打密碼之後，這個視窗就用密碼（重新打開也是）。/ Once a password was chosen, this dialog keeps using it.
    const [authNow, setAuthNow] = useState<LanAuth>(auth);
    const [password, setPassword] = useState("");
    const where = host.ssh_port === 22 ? host.address : `${host.address}:${host.ssh_port}`;
    // 手機上說明會移進內容區；檔案管理貼滿內容區時就不放（面板標題已經寫了 login@主機）。
    // On phones the description moves into the body; with the file manager filling it, leave it out (its header names login@host).
    const phone = useMediaQuery("(max-width: 639px)") === true;

    useEffect(() => {
        void open(auth, login, deviceUser);
        return () => close();
        // 只在打開時登入一次；之後由按鈕重試。/ Log in once on open; retries come from the buttons.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const submitPassword = (e: React.FormEvent) => {
        e.preventDefault();
        if (!password) return;
        const pw = password;
        void open({ kind: "prompt" }, login, deviceUser, pw);
    };
    const usePassword = () => {
        setAuthNow({ kind: "prompt" });
        askPassword();
    };
    const reopen = () => {
        if (authNow.kind === "prompt") askPassword();
        else void open(authNow, login, deviceUser);
    };

    const session = phase.kind === "open" ? phase.session : null;
    return (
        <Modal
            isOpen
            onClose={onClose}
            title={t("lanFiles.title", { name })}
            description={session && phone ? undefined : t("lanFiles.description", { login, host: where, account: deviceUser ?? "—", device: tunnel.name })}
            icon={<FolderOpen />}
            size="5xl"
            fixedHeight
            bodyClassName={session ? "p-0 sm:px-0 overflow-hidden" : undefined}
            footer={<Button variant="outline" onClick={onClose}>{t("lanFiles.close")}</Button>}
        >
            {session && accessToken ? (
                <div className="h-full min-h-0 [&>div]:border-l-0">
                    <FileManagerPanel
                        key={session.session}
                        serverId={String(tunnel.id)}
                        username={session.session}
                        accessToken={accessToken}
                        deviceName={tunnel.name}
                        lan={{ login: session.login, address: session.address, port: session.ssh_port, account: session.account, auth: session.auth, fingerprint: session.fingerprint, onReopen: reopen }}
                    />
                </div>
            ) : phase.kind === "password" ? (
                <form onSubmit={submitPassword} className="mx-auto max-w-md space-y-4 py-4">
                    <p className="text-sm text-muted-foreground">{t("lanFiles.passwordIntro", { login, host: where })}</p>
                    <Field label={t("lanFiles.password", { login })} hint={t("lanFiles.passwordHint")} error={phase.error}>
                        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="off" autoFocus />
                    </Field>
                    <Button type="submit" disabled={!password}>
                        <KeyRound size={15} /> {t("lanFiles.submit")}
                    </Button>
                </form>
            ) : phase.kind === "failed" ? (
                <div className="mx-auto max-w-lg space-y-4 py-4">
                    <Callout tone="danger" title={t("lanFiles.failedTitle")}>
                        <span className="[overflow-wrap:anywhere]">{phase.message}</span>
                    </Callout>
                    <div className="flex flex-wrap gap-2">
                        <Button variant="outline" onClick={reopen}>
                            <RefreshCw size={15} /> {t("lanFiles.retry")}
                        </Button>
                        {offerPassword(phase.code, authNow) && (
                            <Button onClick={usePassword}>
                                <KeyRound size={15} /> {t("lanFiles.usePassword")}
                            </Button>
                        )}
                    </div>
                </div>
            ) : (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
                    <Loader2 size={22} className="animate-spin text-muted-foreground" />
                    <p className="text-sm text-foreground">{t("lanFiles.opening", { login, host: where })}</p>
                    <p className="text-xs text-muted-foreground">{t("lanFiles.openingHint", { device: tunnel.name })}</p>
                </div>
            )}
        </Modal>
    );
}
