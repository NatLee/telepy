"use client";

/**
 * 簽章密鑰：看 / 複製 / 換一把，以及怎麼在自己的服務驗證（Standard Webhooks 的三個 header + Node.js / Python 範例）。
 * The signing secret: reveal, copy, rotate, and how to verify it in your own service (the three Standard
 * Webhooks headers plus Node.js / Python examples).
 */
import React, { useEffect, useState } from "react";
import { Eye, EyeOff, KeyRound, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { CopyButton } from "@/components/ui/CopyButton";
import { Modal } from "@/components/ui/Modal";
import { Property, PropertyList } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { useI18n } from "@/lib/i18n";
import type { Webhook } from "@/types/webhooks";

const NODE = `import crypto from "node:crypto";

// secret = "whsec_…"; body = the raw request body as a string
export function verify(secret, headers, body) {
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const id = headers["webhook-id"];
  const ts = headers["webhook-timestamp"];
  const expected = "v1," + crypto.createHmac("sha256", key).update(\`\${id}.\${ts}.\${body}\`).digest("base64");
  const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
  return fresh && headers["webhook-signature"].split(" ").some(
    (sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)),
  );
}`;

const PYTHON = `import base64, hashlib, hmac, time

# secret = "whsec_…"; body = the raw request body (bytes)
def verify(secret: str, headers: dict, body: bytes) -> bool:
    key = base64.b64decode(secret.removeprefix("whsec_"))
    signed = f"{headers['webhook-id']}.{headers['webhook-timestamp']}.".encode() + body
    expected = "v1," + base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode()
    fresh = abs(time.time() - int(headers["webhook-timestamp"])) < 300
    return fresh and any(hmac.compare_digest(s, expected) for s in headers["webhook-signature"].split())`;

interface Props {
    hook: Webhook | null;
    onClose: () => void;
    load: (id: number, rotate: boolean) => Promise<{ secret: string } | { error: string }>;
}

export function SecretDialog({ hook, onClose, load }: Props) {
    return hook ? <Secret key={hook.id} hook={hook} onClose={onClose} load={load} /> : null;
}

function Secret({ hook, onClose, load }: Props & { hook: Webhook }) {
    const { t } = useI18n();
    const [secret, setSecret] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [shown, setShown] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [lang, setLang] = useState<"node" | "python">("node");

    useEffect(() => {
        let cancelled = false;
        void load(hook.id, false).then((r) => {
            if (cancelled) return;
            if ("secret" in r) setSecret(r.secret);
            else setError(r.error);
        });
        return () => {
            cancelled = true;
        };
    }, [hook.id, load]);

    const rotate = async () => {
        const r = await load(hook.id, true);
        if ("secret" in r) {
            setSecret(r.secret);
            setError(null);
            setShown(true);
        } else {
            setError(r.error);
        }
    };

    return (
        <>
            <Modal
                isOpen
                onClose={onClose}
                size="2xl"
                icon={<KeyRound />}
                title={t("webhooks.secret.title")}
                description={t("webhooks.secret.description", { name: hook.name })}
                footer={
                    <>
                        <Button variant="outline" onClick={() => setConfirm(true)} className="mr-auto">
                            <RotateCw size={15} /> {t("webhooks.secret.rotate")}
                        </Button>
                        <Button variant="outline" onClick={onClose}>
                            {t("common.close")}
                        </Button>
                    </>
                }
            >
                <div className="space-y-6">
                    {error && <Callout tone="danger">{error}</Callout>}
                    <div className="space-y-1.5">
                        <p className="text-sm text-muted-foreground">{t("webhooks.secret.label")}</p>
                        <div className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2">
                            <code className="min-w-0 flex-1 font-mono text-sm text-foreground [overflow-wrap:anywhere]">{secret ? (shown ? secret : `whsec_${"•".repeat(24)}`) : t("common.loading")}</code>
                            {secret && (
                                <>
                                    <Button size="icon-sm" variant="ghost" onClick={() => setShown((v) => !v)} aria-label={shown ? t("webhooks.secret.hide") : t("webhooks.secret.show")} title={shown ? t("webhooks.secret.hide") : t("webhooks.secret.show")}>
                                        {shown ? <EyeOff /> : <Eye />}
                                    </Button>
                                    <CopyButton value={secret} />
                                </>
                            )}
                        </div>
                    </div>
                    <Callout tone="tip">{t("webhooks.secret.chatApps")}</Callout>
                    <div className="space-y-2">
                        <h3 className="text-base text-foreground">{t("webhooks.secret.headers")}</h3>
                        <PropertyList>
                            <Property label={<code className="font-mono text-xs">webhook-id</code>}>{t("webhooks.secret.headerId")}</Property>
                            <Property label={<code className="font-mono text-xs">webhook-timestamp</code>}>{t("webhooks.secret.headerTimestamp")}</Property>
                            <Property label={<code className="font-mono text-xs">webhook-signature</code>}>{t("webhooks.secret.headerSignature")}</Property>
                            <Property label={<code className="font-mono text-xs">x-telepy-event</code>}>{t("webhooks.secret.headerEvent")}</Property>
                        </PropertyList>
                    </div>
                    <div className="space-y-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <h3 className="text-base text-foreground">{t("webhooks.secret.verify")}</h3>
                            <Segmented
                                size="sm"
                                value={lang}
                                onChange={setLang}
                                options={[
                                    { value: "node", label: "Node.js" },
                                    { value: "python", label: "Python" },
                                ]}
                                aria-label={t("webhooks.secret.verify")}
                            />
                        </div>
                        <CodeBlock language={lang === "node" ? "javascript" : "python"} value={lang === "node" ? NODE : PYTHON} />
                        <p className="text-xs text-muted-foreground">{t("webhooks.secret.libraries")}</p>
                    </div>
                </div>
            </Modal>
            <ConfirmDialog
                isOpen={confirm}
                onClose={() => setConfirm(false)}
                onConfirm={() => {
                    setConfirm(false);
                    void rotate();
                }}
                title={t("webhooks.secret.rotateTitle")}
                message={t("webhooks.secret.rotateMessage")}
                confirmText={t("webhooks.secret.rotate")}
            />
        </>
    );
}
