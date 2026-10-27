"use client";

/**
 * 網站設定 → 登入 →「登入頁的樣子」：一般登入頁與 OAuth 登入頁各自選一般 / 低調、低調頁上的那句話、即時預覽
 * （PreviewFrame 裡畫的是真正頁面的同一組元件，桌機與手機各一個），以及「運作方式」說明（路徑圖 + 兩種樣子的對照）。
 * Site settings → Sign-in → "Sign-in page look": standard / discreet for the sign-in and OAuth sign-in pages, the
 * discreet page's line, a live preview (PreviewFrame renders the real page components, desktop and phone) and the
 * "How it works" dialog (path diagram + a comparison of the two looks).
 */
import React, { useState } from "react";
import { Eye, EyeOff, Globe, Info, ScanEye, SquareDashed } from "lucide-react";
import { LoginFormPreview } from "@/components/auth/LoginForm";
import { OAuthSignInScreen, SignInScreen } from "@/components/auth/SignInScreens";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Field } from "@/components/ui/field";
import { Modal } from "@/components/ui/Modal";
import { PreviewFrame } from "@/components/ui/preview-frame";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { Textarea } from "@/components/ui/textarea";
import { rememberSignInLook } from "@/hooks/useSignInLook";
import { useI18n } from "@/lib/i18n";
import { DEFAULT_LOOK, MESSAGE_LINES, MESSAGE_MAX, messageProblem, parseSignInLook, styleOf, tidyMessage, type SignInLook, type SignInPageKind, type SignInStyle } from "@/lib/signinLook";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

/** 這三個設定由這個面板編輯，不再出現在一般的設定清單。/ Edited here, so the generic list leaves them out. */
export const SIGNIN_LOOK_KEYS = ["signin_page_style", "signin_oauth_style", "signin_page_message"];

const STYLE_KEY: Record<SignInPageKind, "signin_page_style" | "signin_oauth_style"> = { signin: "signin_page_style", oauth: "signin_oauth_style" };
const PATH: Record<SignInPageKind, string> = { signin: "/login", oauth: "/oauth/login" };
const BUILT_IN_LINES: TranslationKey[] = ["discreet.line1", "discreet.line2", "discreet.line3"];
const noop = () => {};

function lookFrom(values: Record<string, unknown>): SignInLook {
    return parseSignInLook({ style: values.signin_page_style, oauth_style: values.signin_oauth_style, message: values.signin_page_message }) ?? DEFAULT_LOOK;
}

function useStyleOptions() {
    const { t } = useI18n();
    return [
        { value: "standard" as const, label: t("signinLook.standard"), icon: <Eye size={14} />, title: t("signinLook.standardHint") },
        { value: "discreet" as const, label: t("signinLook.discreet"), icon: <EyeOff size={14} />, title: t("signinLook.discreetHint") },
    ];
}

/** 選哪一頁（標籤附上那頁目前的樣子）。/ Page choices, each labelled with its current look. */
function usePageOptions(look: SignInLook) {
    const { t } = useI18n();
    const name = (s: SignInStyle) => t(s === "discreet" ? "signinLook.discreet" : "signinLook.standard");
    return [
        { value: "signin" as const, label: `${t("signinLook.previewSignin")} · ${name(look.style)}` },
        { value: "oauth" as const, label: `${t("signinLook.previewOauth")} · ${name(look.oauthStyle)}` },
    ];
}

/** 某一頁、某個樣子的畫面（預覽用：表單不會登入）。/ One page in one look, with the inert preview form. */
function PreviewScreen({ page, look }: { page: SignInPageKind; look: SignInLook }) {
    const { t } = useI18n();
    if (page === "oauth") {
        return (
            <OAuthSignInScreen
                style={look.oauthStyle}
                message={look.message}
                Form={LoginFormPreview}
                app={{ name: t("signinLook.previewApp"), host: "app.example.com", scopes: ["tunnels:read", "ssh:exec"], loading: false }}
                onCancel={noop}
            />
        );
    }
    return <SignInScreen style={look.style} message={look.message} Form={LoginFormPreview} />;
}

/** 桌機 + 手機兩個預覽框。/ The desktop and phone frames. */
export function SignInPreview({ page, look }: { page: SignInPageKind; look: SignInLook }) {
    const { t } = useI18n();
    const pageName = t(page === "oauth" ? "signinLook.previewOauth" : "signinLook.previewSignin");
    const screen = <PreviewScreen page={page} look={look} />;
    return (
        <div className="grid items-start gap-4 md:grid-cols-[minmax(0,1fr)_10.5rem]">
            <figure className="min-w-0">
                <PreviewFrame width={1280} height={800} title={t("signinLook.previewFrame", { page: pageName, device: t("signinLook.previewDesktop") })}>
                    {screen}
                </PreviewFrame>
                <figcaption className="mt-1.5 text-center text-xs text-muted-foreground">{t("signinLook.previewDesktop")} · 1280 × 800</figcaption>
            </figure>
            <figure className="mx-auto w-40 md:w-full">
                <PreviewFrame width={390} height={800} title={t("signinLook.previewFrame", { page: pageName, device: t("signinLook.previewPhone") })} className="rounded-xl">
                    {screen}
                </PreviewFrame>
                <figcaption className="mt-1.5 text-center text-xs text-muted-foreground">{t("signinLook.previewPhone")} · 390 × 800</figcaption>
            </figure>
        </div>
    );
}

/** 一頁的樣子：說明 + 一般 / 低調切換（選了就存）。/ One page's look: label + a standard / discreet toggle (saves on change). */
function StyleRow({ page, value, onChange }: { page: SignInPageKind; value: SignInStyle; onChange: (v: SignInStyle) => void }) {
    const { t } = useI18n();
    const key = STYLE_KEY[page];
    const options = useStyleOptions();
    return (
        <li className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between sm:px-6 sm:py-5">
            <div className="min-w-0 flex-1">
                <h4 className="text-[1rem] text-foreground">{t(`siteSettings.${key}.label` as TranslationKey)}</h4>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{t(`siteSettings.${key}.description` as TranslationKey)}</p>
                <p className="mt-2 inline-block rounded-md bg-muted px-1.5 py-px font-mono text-xs text-muted-foreground/80">{key}</p>
            </div>
            <div className="shrink-0 sm:pt-0.5 sm:text-right">
                <Segmented kind="toggle" size="sm" options={options} value={value} onChange={onChange} aria-label={t(`siteSettings.${key}.label` as TranslationKey)} />
                <p className="mt-1.5 text-xs text-muted-foreground">{t(value === "discreet" ? "signinLook.discreetHint" : "signinLook.standardHint")}</p>
            </div>
        </li>
    );
}

export function SignInLookPanel({ values, onSave }: { values: Record<string, unknown>; onSave: (key: string, value: unknown) => Promise<void> | void }) {
    const { t } = useI18n();
    const saved = lookFrom(values);
    /** 還沒存的那句話（null = 跟存好的一樣）。/ The unsaved line (null = same as saved). */
    const [draft, setDraft] = useState<string | null>(null);
    const [page, setPage] = useState<SignInPageKind>("signin");
    const [infoOpen, setInfoOpen] = useState(false);
    const pageOptions = usePageOptions(saved);

    const text = draft ?? saved.message;
    const dirty = draft !== null && tidyMessage(draft) !== saved.message;
    const problem = messageProblem(text);
    const chars = [...tidyMessage(text)].length;
    const look: SignInLook = { ...saved, message: tidyMessage(text) };
    const unused = saved.style === "standard" && saved.oauthStyle === "standard";

    const setStyle = (p: SignInPageKind, v: SignInStyle) => {
        void onSave(STYLE_KEY[p], v);
        // 這個瀏覽器登出後馬上就是新的樣子。/ This browser shows the new look right after signing out.
        rememberSignInLook({ ...saved, [p === "oauth" ? "oauthStyle" : "style"]: v });
        setPage(p);
    };
    const saveMessage = async () => {
        if (problem) return;
        const next = tidyMessage(text);
        await onSave("signin_page_message", next);
        rememberSignInLook({ ...saved, message: next });
        setDraft(null);
    };

    return (
        <section className="overflow-hidden rounded-xl border border-border/80 bg-card text-card-foreground shadow-card">
            <div className="p-4 sm:px-6 sm:pt-5 sm:pb-4">
                <SectionHeading
                    icon={<ScanEye />}
                    title={t("signinLook.title")}
                    description={t("signinLook.description")}
                    action={
                        <Button type="button" size="sm" variant="ghost" onClick={() => setInfoOpen(true)}>
                            <Info size={15} /> {t("signinLook.info")}
                        </Button>
                    }
                />
            </div>

            <ul className="divide-y divide-border/70 border-t border-border/70">
                <StyleRow page="signin" value={saved.style} onChange={(v) => setStyle("signin", v)} />
                <StyleRow page="oauth" value={saved.oauthStyle} onChange={(v) => setStyle("oauth", v)} />
                <li className="p-4 sm:px-6 sm:py-5">
                    <Field
                        label={t("siteSettings.signin_page_message.label")}
                        addon={<span className={cn("tabular-nums", problem === "tooLong" && "text-destructive")}>{t("signinLook.messageCount", { count: chars, max: MESSAGE_MAX })}</span>}
                        hint={unused ? `${t("siteSettings.signin_page_message.description")} ${t("signinLook.messageUnused")}` : t("siteSettings.signin_page_message.description")}
                        error={problem === "tooLong" ? t("signinLook.messageTooLong", { max: MESSAGE_MAX }) : problem === "tooManyLines" ? t("signinLook.messageTooManyLines", { max: MESSAGE_LINES }) : undefined}
                    >
                        <Textarea
                            rows={3}
                            value={text}
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder={t("signinLook.messagePlaceholder", { lines: BUILT_IN_LINES.map((k) => t(k)).join(" · ") })}
                            className="resize-y"
                        />
                    </Field>
                    <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <Button type="button" size="sm" variant="soft" disabled={!dirty || !!problem} onClick={() => void saveMessage()}>
                            {t("common.save")}
                        </Button>
                        {text.trim() !== "" && (
                            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft("")}>
                                {t("signinLook.messageBuiltIn")}
                            </Button>
                        )}
                        <span className="font-mono text-xs text-muted-foreground/80">signin_page_message</span>
                    </div>
                </li>
            </ul>

            <div className="space-y-3 border-t border-border/70 bg-surface p-4 sm:px-6 sm:py-5">
                <SectionHeading as="h4" title={t("signinLook.previewTitle")} description={t("signinLook.previewBody")} action={dirty ? <Chip tone="warning">{t("signinLook.unsaved")}</Chip> : undefined} />
                <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
                    <Segmented kind="toggle" size="sm" options={pageOptions} value={page} onChange={setPage} aria-label={t("signinLook.previewTitle")} />
                </div>
                <SignInPreview page={page} look={look} />
            </div>

            <SignInLookInfoDialog isOpen={infoOpen} onClose={() => setInfoOpen(false)} look={saved} page={page} onPage={setPage} />
        </section>
    );
}

/* ── 運作方式 / How it works ─────────────────────────────────────── */

type Cell = "shown" | "hidden" | "afterSignIn" | "emptyFrame" | "unchanged";

const ROWS: { label: TranslationKey; standard: Cell; discreet: Cell; oauthOnly?: boolean }[] = [
    { label: "signinLook.cmp.name", standard: "shown", discreet: "shown" },
    { label: "signinLook.cmp.product", standard: "shown", discreet: "hidden" },
    { label: "signinLook.cmp.methods", standard: "shown", discreet: "shown" },
    { label: "signinLook.cmp.app", standard: "shown", discreet: "shown", oauthOnly: true },
    { label: "signinLook.cmp.scopes", standard: "shown", discreet: "afterSignIn", oauthOnly: true },
    { label: "signinLook.cmp.html", standard: "emptyFrame", discreet: "emptyFrame" },
    { label: "signinLook.cmp.after", standard: "unchanged", discreet: "unchanged" },
];

const CELL_TEXT: Record<Cell, TranslationKey> = {
    shown: "signinLook.cmp.shown",
    hidden: "signinLook.cmp.hidden",
    afterSignIn: "signinLook.cmp.afterSignIn",
    emptyFrame: "signinLook.cmp.emptyFrame",
    unchanged: "signinLook.cmp.unchanged",
};

function CellText({ cell }: { cell: Cell }) {
    const { t } = useI18n();
    const Icon = cell === "shown" ? Eye : cell === "hidden" || cell === "afterSignIn" ? EyeOff : null;
    return (
        <span className={cn("inline-flex items-center gap-1 text-xs", cell === "shown" ? "text-foreground" : "text-muted-foreground")}>
            {Icon && <Icon size={13} aria-hidden />}
            {t(CELL_TEXT[cell])}
        </span>
    );
}

/**
 * 「運作方式」：訪客 ─ 空外框 ─ 選好的樣子 ─ 登入後（路徑圖，依目前設定標出使用中的樣子），兩種樣子各顯示什麼，以及藏不住的東西。
 * "How it works": visitor ─ empty frame ─ the chosen look ─ after sign-in (lit by the current setting), what each
 * look shows, and what it cannot hide.
 */
export function SignInLookInfoDialog({ isOpen, onClose, look, page, onPage }: { isOpen: boolean; onClose: () => void; look: SignInLook; page: SignInPageKind; onPage: (p: SignInPageKind) => void }) {
    const { t, tn } = useI18n();
    const pageOptions = usePageOptions(look);
    const style = styleOf(look, page);
    const styleName = t(style === "discreet" ? "signinLook.discreet" : "signinLook.standard");
    const rows = ROWS.filter((r) => page === "oauth" || !r.oauthOnly);

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("signinLook.infoTitle")}
            description={t("signinLook.infoDescription")}
            icon={<ScanEye />}
            size="4xl"
            toolbar={<Segmented kind="tabs" size="sm" fullWidth options={pageOptions} value={page} onChange={onPage} aria-label={t("signinLook.previewTitle")} />}
            footer={
                <Button type="button" variant="outline" onClick={onClose}>
                    {t("common.close")}
                </Button>
            }
        >
            <div className="space-y-6">
                <div className="space-y-2">
                    <FlowPath>
                        <FlowNode icon={Globe} title={t("signinLook.flow.visitor")} sub={t("signinLook.flow.visitorSub")} state="waiting" stateText={t("signinLook.flow.signedOut")} />
                        <FlowLink label={t("signinLook.flow.opens", { path: PATH[page] })} state="ok" />
                        <FlowNode icon={SquareDashed} title={t("signinLook.flow.frame")} sub={t("signinLook.flow.frameSub")} state="ok" stateText={t("signinLook.flow.noCopy")} />
                        <FlowLink label={t("signinLook.flow.asks")} state="ok" />
                        <FlowNode
                            icon={style === "discreet" ? EyeOff : Eye}
                            title={t("signinLook.flow.look", { look: styleName })}
                            sub={t(style === "discreet" ? "signinLook.discreetHint" : "signinLook.standardHint")}
                            state="ok"
                            stateText={t("signinLook.flow.now")}
                            className="border-primary/60"
                        />
                        <FlowLink label={t("signinLook.flow.signsIn")} state="waiting" />
                        <FlowNode brand title={t("signinLook.flow.app")} sub={t("signinLook.flow.appSub")} state="waiting" stateText={t("signinLook.flow.afterSignIn")} />
                    </FlowPath>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        {tn("signinLook.flow.endpoint", { path: <code className="rounded-sm bg-muted px-1 font-mono">GET /api/auth/sign-in-page</code> })} {t("signinLook.flow.cached")}
                    </p>
                </div>

                <div>
                    <h4 className="mb-2 text-sm text-foreground">{t("signinLook.cmp.title")}</h4>
                    <div className="overflow-hidden rounded-lg border border-border">
                        <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] text-sm">
                            <div className="bg-surface px-3 py-2 text-xs text-muted-foreground">{t("signinLook.cmp.item")}</div>
                            {(["standard", "discreet"] as const).map((s) => (
                                <div key={s} className={cn("flex items-center gap-1.5 px-3 py-2 text-xs", s === style ? "bg-primary/10 text-foreground" : "bg-surface text-muted-foreground")}>
                                    {t(s === "discreet" ? "signinLook.discreet" : "signinLook.standard")}
                                    {s === style && <Chip tone="primary">{t("signinLook.flow.now")}</Chip>}
                                </div>
                            ))}
                            {rows.map((r) => (
                                <React.Fragment key={r.label}>
                                    <div className="border-t border-border px-3 py-2 leading-snug text-foreground">{t(r.label)}</div>
                                    <div className={cn("border-t border-border px-3 py-2", style === "standard" && "bg-primary/5")}>
                                        <CellText cell={r.standard} />
                                    </div>
                                    <div className={cn("border-t border-border px-3 py-2", style === "discreet" && "bg-primary/5")}>
                                        <CellText cell={r.discreet} />
                                    </div>
                                </React.Fragment>
                            ))}
                        </div>
                    </div>
                </div>

                <Callout tone="warning" title={t("signinLook.limitsTitle")}>
                    {t("signinLook.limitsBody")}
                </Callout>
            </div>
        </Modal>
    );
}
