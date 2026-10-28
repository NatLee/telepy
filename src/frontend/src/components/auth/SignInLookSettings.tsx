"use client";

/**
 * 網站設定 → 登入 →「登入頁的樣子」：一般登入頁、應用程式連接頁與 CLI 登入頁（`telepy login`）各自選一般 / 低調、低調頁上輪流打出來的句子
 * （SignInLinesEditor）、即時預覽（PreviewFrame 裡畫的是真正頁面的同一組元件，桌機與手機各一個；正在編輯的那句會被釘住），
 * 以及「運作方式」說明（路徑圖 + 兩種樣子的對照）。
 * Site settings → Sign-in → "Sign-in page look": standard / discreet for the sign-in, app connection and CLI (`telepy login`) pages, the
 * discreet page's typed lines (SignInLinesEditor), a live preview (PreviewFrame renders the real page components,
 * desktop and phone; the line being edited is pinned) and the "How it works" dialog (path diagram + a comparison of
 * the two looks).
 */
import React, { useState } from "react";
import { Eye, EyeOff, Globe, Info, ScanEye, SquareDashed, SquareTerminal } from "lucide-react";
import { LoginFormPreview } from "@/components/auth/LoginForm";
import { OAuthSignInScreen, SignInScreen } from "@/components/auth/SignInScreens";
import { FlowLink, FlowNode, FlowPath } from "@/components/flow/PathFlow";
import { Button } from "@/components/ui/button";
import { SignInLinesEditor, type LinesDraft } from "@/components/auth/SignInLinesEditor";
import { Callout } from "@/components/ui/callout";
import { Modal } from "@/components/ui/Modal";
import { NativeSelect } from "@/components/ui/native-select";
import { PreviewFrame } from "@/components/ui/preview-frame";
import { Chip, SectionHeading } from "@/components/ui/section";
import { Segmented } from "@/components/ui/segmented";
import { rememberSignInLook } from "@/hooks/useSignInLook";
import { useMediaQuery } from "@/hooks/useMediaQuery";
import { useI18n } from "@/lib/i18n";
import { DEFAULT_LOOK, joinLines, messageLines, messageProblem, parseSignInLook, pinnedLine, styleOf, type SignInLook, type SignInPageKind, type SignInStyle } from "@/lib/signinLook";
import { LOGIN_SCOPES } from "@/lib/cliGuide";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/locales/en";

/** 這四個設定由這個面板編輯，不再出現在一般的設定清單。/ Edited here, so the generic list leaves them out. */
export const SIGNIN_LOOK_KEYS = ["signin_page_style", "signin_oauth_style", "signin_cli_style", "signin_page_message"];

type StyleKey = "signin_page_style" | "signin_oauth_style" | "signin_cli_style";
const STYLE_KEY: Record<SignInPageKind, StyleKey> = { signin: "signin_page_style", oauth: "signin_oauth_style", cli: "signin_cli_style" };
const LOOK_FIELD: Record<SignInPageKind, "style" | "oauthStyle" | "cliStyle"> = { signin: "style", oauth: "oauthStyle", cli: "cliStyle" };
/** 應用程式與 CLI 是同一個網址，看要求的是誰決定用哪個。/ Apps and the CLI share the address; who is asking decides. */
const PATH: Record<SignInPageKind, string> = { signin: "/login", oauth: "/oauth/login", cli: "/oauth/login" };
const PAGE_NAME: Record<SignInPageKind, TranslationKey> = { signin: "signinLook.previewSignin", oauth: "signinLook.previewOauth", cli: "signinLook.previewCli" };
const BUILT_IN_LINES: TranslationKey[] = ["discreet.line1", "discreet.line2", "discreet.line3"];
const noop = () => {};

function lookFrom(values: Record<string, unknown>): SignInLook {
    return (
        parseSignInLook({ style: values.signin_page_style, oauth_style: values.signin_oauth_style, cli_style: values.signin_cli_style, message: values.signin_page_message }) ??
        DEFAULT_LOOK
    );
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
    return (["signin", "oauth", "cli"] as const).map((p) => ({ value: p, label: `${t(PAGE_NAME[p])} · ${name(styleOf(look, p))}` }));
}

/**
 * 選哪一頁：三個長標籤在手機上會各擠成三行，所以手機用一行的下拉。
 * Which page: three long labels would each wrap to three lines on a phone, so phones get a one-line select.
 */
function PagePicker({ look, value, onChange, kind }: { look: SignInLook; value: SignInPageKind; onChange: (p: SignInPageKind) => void; kind: "tabs" | "toggle" }) {
    const { t } = useI18n();
    const options = usePageOptions(look);
    const phone = useMediaQuery("(max-width: 639.98px)") === true;
    if (phone) {
        return (
            <NativeSelect value={value} onChange={(e) => onChange(e.target.value as SignInPageKind)} aria-label={t("signinLook.previewTitle")}>
                {options.map((o) => (
                    <option key={o.value} value={o.value}>
                        {o.label}
                    </option>
                ))}
            </NativeSelect>
        );
    }
    return <Segmented kind={kind} size="sm" fullWidth={kind === "tabs"} options={options} value={value} onChange={onChange} aria-label={t("signinLook.previewTitle")} />;
}

/** 某一頁、某個樣子的畫面（預覽用：表單不會登入）。/ One page in one look, with the inert preview form. */
function PreviewScreen({ page, look, pin }: { page: SignInPageKind; look: SignInLook; pin: number | null }) {
    const { t } = useI18n();
    if (page === "oauth" || page === "cli") {
        // CLI 的預覽：名字照 CLI 註冊的樣子（`telepy CLI (<電腦>)`），導回本機、預設的 scope。/ The CLI as it registers itself.
        const app =
            page === "cli"
                ? { name: "telepy CLI (my-laptop)", host: "127.0.0.1", scopes: [...LOGIN_SCOPES], loading: false }
                : { name: t("signinLook.previewApp"), host: "app.example.com", scopes: ["tunnels:read", "ssh:exec"], loading: false };
        return <OAuthSignInScreen style={styleOf(look, page)} message={look.message} Form={LoginFormPreview} app={app} onCancel={noop} pin={pin} />;
    }
    return <SignInScreen style={look.style} message={look.message} Form={LoginFormPreview} pin={pin} />;
}

/** 桌機 + 手機兩個預覽框；`pin` = 正在編輯的那句（只打那一句）。/ The desktop and phone frames; `pin` = the line being edited. */
export function SignInPreview({ page, look, pin = null }: { page: SignInPageKind; look: SignInLook; pin?: number | null }) {
    const { t } = useI18n();
    const pageName = t(PAGE_NAME[page]);
    const screen = <PreviewScreen page={page} look={look} pin={pin} />;
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

/** 存好的文字 → 編輯器的狀態。/ The saved text → the editor's state. */
function draftFrom(message: string): LinesDraft {
    const rows = messageLines(message);
    return rows.length ? { mode: "custom", rows } : { mode: "builtin", rows: [""] };
}

export function SignInLookPanel({ values, onSave }: { values: Record<string, unknown>; onSave: (key: string, value: unknown) => Promise<void> | void }) {
    const { t } = useI18n();
    const saved = lookFrom(values);
    /** 還沒存的句子（null = 跟存好的一樣）。/ The unsaved lines (null = same as saved). */
    const [draft, setDraft] = useState<LinesDraft | null>(null);
    /** 正在編輯哪一列（預覽會釘住那句）。/ The row being edited (pinned in the preview). */
    const [editing, setEditing] = useState<number | null>(null);
    const [page, setPage] = useState<SignInPageKind>("signin");
    const [infoOpen, setInfoOpen] = useState(false);

    const lines = draft ?? draftFrom(saved.message);
    const message = lines.mode === "custom" ? joinLines(lines.rows) : "";
    const dirty = message !== saved.message;
    const problem = messageProblem(message);
    const look: SignInLook = { ...saved, message };
    const pin = lines.mode === "custom" ? pinnedLine(lines.rows, editing) : null;
    const unused = saved.style === "standard" && saved.oauthStyle === "standard" && saved.cliStyle === "standard";

    const setStyle = (p: SignInPageKind, v: SignInStyle) => {
        void onSave(STYLE_KEY[p], v);
        // 這個瀏覽器登出後馬上就是新的樣子。/ This browser shows the new look right after signing out.
        rememberSignInLook({ ...saved, [LOOK_FIELD[p]]: v });
        setPage(p);
    };
    const saveLines = async () => {
        if (problem) return;
        await onSave("signin_page_message", message);
        rememberSignInLook({ ...saved, message });
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
                <StyleRow page="cli" value={saved.cliStyle} onChange={(v) => setStyle("cli", v)} />
                <li className="p-4 sm:px-6 sm:py-5">
                    <h4 className="text-[1rem] text-foreground">{t("siteSettings.signin_page_message.label")}</h4>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {t("siteSettings.signin_page_message.description")}
                        {unused && ` ${t("signinLook.linesUnused")}`}
                    </p>
                    <div className="mt-3">
                        <SignInLinesEditor value={lines} onChange={setDraft} builtIn={BUILT_IN_LINES.map((k) => t(k))} onFocusRow={setEditing} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                        <Button type="button" size="sm" variant="soft" disabled={!dirty || !!problem} onClick={() => void saveLines()}>
                            {t("common.save")}
                        </Button>
                        {draft !== null && (
                            <Button type="button" size="sm" variant="ghost" onClick={() => setDraft(null)}>
                                {t("signinLook.discard")}
                            </Button>
                        )}
                        <span className="font-mono text-xs text-muted-foreground/80">signin_page_message</span>
                    </div>
                </li>
            </ul>

            <div className="space-y-3 border-t border-border/70 bg-surface p-4 sm:px-6 sm:py-5">
                <SectionHeading
                    as="h4"
                    title={t("signinLook.previewTitle")}
                    description={t("signinLook.previewBody")}
                    action={
                        pin !== null ? (
                            <Chip tone="primary">{t("signinLook.previewPinned", { n: pin + 1 })}</Chip>
                        ) : dirty ? (
                            <Chip tone="warning">{t("signinLook.unsaved")}</Chip>
                        ) : undefined
                    }
                />
                <PagePicker look={saved} value={page} onChange={setPage} kind="toggle" />
                <SignInPreview page={page} look={look} pin={pin} />
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
    const style = styleOf(look, page);
    const styleName = t(style === "discreet" ? "signinLook.discreet" : "signinLook.standard");
    const rows = ROWS.filter((r) => page !== "signin" || !r.oauthOnly);
    const cli = page === "cli";

    return (
        <Modal
            isOpen={isOpen}
            onClose={onClose}
            title={t("signinLook.infoTitle")}
            description={t("signinLook.infoDescription")}
            icon={<ScanEye />}
            size="4xl"
            toolbar={<PagePicker look={look} value={page} onChange={onPage} kind="tabs" />}
            footer={
                <Button type="button" variant="outline" onClick={onClose}>
                    {t("common.close")}
                </Button>
            }
        >
            <div className="space-y-6">
                <div className="space-y-2">
                    <FlowPath>
                        {cli ? (
                            <FlowNode icon={SquareTerminal} title="telepy login" sub={t("signinLook.flow.cliSub")} state="waiting" stateText={t("signinLook.flow.signedOut")} />
                        ) : (
                            <FlowNode icon={Globe} title={t("signinLook.flow.visitor")} sub={t("signinLook.flow.visitorSub")} state="waiting" stateText={t("signinLook.flow.signedOut")} />
                        )}
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
                    {page !== "signin" && (
                        <p className="text-xs leading-relaxed text-muted-foreground">
                            {tn("signinLook.flow.whichApp", { name: <code className="rounded-sm bg-muted px-1 font-mono">telepy CLI (…)</code> })}
                        </p>
                    )}
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
