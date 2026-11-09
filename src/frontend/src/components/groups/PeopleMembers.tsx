"use client";

/**
 * 人的成員編輯（角色、管理員維護的群組、個人群組共用）：上面是「目前的成員」（可以在成員裡搜尋、分頁、每列 × 拿掉、
 * 拿掉的劃線可復原），下面是「加人」——打字就列出還不是成員的人（↑↓ + Enter 或點一下加入），或「一次貼上好幾個」
 * （帳號或 email，先說找到幾個、哪些找不到才加）。這裡只改草稿；送出由外面決定（管理區用增減路由，個人群組在
 * 對話框的儲存）。通道群組、金鑰群組仍用 MemberPicker。
 * The people member editor (shared by roles, admin-kept groups and personal groups): "Current members" on top
 * (search within them, pages, × per row, removed rows struck through and undoable), then "Add people" — typing lists
 * matching non-members (↑↓ + Enter or a click adds), or "Paste several" (usernames or emails; says how many were
 * found and which were not before adding). Only the draft changes here; the caller sends it (the delta routes on the
 * admin pages, the dialog's Save for personal groups). Tunnel / key groups keep using MemberPicker.
 */
import React, { useId, useMemo, useState } from "react";
import { ClipboardPaste, Search, Shield, Undo2, User, UserPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/pagination";
import { Textarea } from "@/components/ui/textarea";
import { usePagination } from "@/hooks/usePagination";
import { pageSlice } from "@/lib/pagination";
import { addCandidates, memberRows, parsePaste, personMatches, resolvePaste, type MemberPerson } from "@/lib/peopleMembers";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/* ── 打字找、Enter 加入 / Type to find, Enter to add ─────────────── */

export interface TypeAheadItem {
    id: number;
    label: string;
    sub?: string;
    icon?: React.ReactNode;
}

/**
 * 打字就在下面列出符合的（最多幾個），↑↓ 移動、Enter 加入、Esc 清掉；點一下也加入。清單在版面裡（不浮在上面），
 * 所以在對話框和窄螢幕裡都不會被切掉。
 * Typing lists matches right below (a few at most); ↑↓ moves, Enter adds, Esc clears; a click adds too. The list is
 * in the flow (not floating), so it is never clipped inside dialogs or on narrow screens.
 */
export function TypeAhead({
    search,
    onPick,
    placeholder,
    emptyText,
    showOnFocus = false,
    disabled = false,
    icon,
}: {
    /** 這個字串的結果（已排除不能選的）。/ The matches for a query (already without unpickable ones). */
    search: (query: string) => TypeAheadItem[];
    onPick: (id: number) => void;
    placeholder: string;
    emptyText: string;
    /** 還沒打字、游標在框裡時也列出（角色、群組這種不多的）。/ List even before typing while focused (short lists). */
    showOnFocus?: boolean;
    disabled?: boolean;
    icon?: React.ReactNode;
}) {
    const { t } = useI18n();
    const id = useId();
    const [query, setQuery] = useState("");
    const [focused, setFocused] = useState(false);
    const [active, setActive] = useState(0);
    const typed = query.trim() !== "";
    const open = !disabled && (typed || (showOnFocus && focused));
    const items = open ? search(query) : [];
    const current = Math.min(active, Math.max(0, items.length - 1));
    const pick = (itemId: number) => {
        onPick(itemId);
        setQuery("");
        setActive(0);
    };
    const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive(items.length === 0 ? 0 : (current + 1) % items.length);
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive(items.length === 0 ? 0 : (current - 1 + items.length) % items.length);
        } else if (e.key === "Enter") {
            // 表單裡按 Enter 不送出整個表單。/ Enter never submits the surrounding form.
            e.preventDefault();
            if (items[current]) pick(items[current].id);
        } else if (e.key === "Escape" && query) {
            e.stopPropagation();
            setQuery("");
        }
    };
    return (
        <div className="space-y-1">
            <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground [&>svg]:size-3.5" aria-hidden>
                    {icon ?? <Search />}
                </span>
                <Input
                    role="combobox"
                    aria-expanded={open}
                    aria-controls={`${id}-list`}
                    aria-autocomplete="list"
                    aria-activedescendant={open && items[current] ? `${id}-${items[current].id}` : undefined}
                    aria-label={placeholder}
                    value={query}
                    disabled={disabled}
                    placeholder={placeholder}
                    className="h-8 pl-8"
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setActive(0);
                    }}
                    onFocus={() => setFocused(true)}
                    // 點清單時 blur 會先發生：晚一點才收起來，讓點擊能到。/ Blur fires before a click on the list: close a moment later.
                    onBlur={() => window.setTimeout(() => setFocused(false), 150)}
                    onKeyDown={onKey}
                />
            </div>
            {open && (
                <ul id={`${id}-list`} role="listbox" aria-label={placeholder} className="overflow-hidden rounded-md ring-1 ring-inset ring-border/80">
                    {items.length === 0 ? (
                        <li className="px-3 py-2 text-sm text-muted-foreground" role="presentation">{emptyText}</li>
                    ) : (
                        items.map((it, i) => (
                            <li
                                key={it.id}
                                id={`${id}-${it.id}`}
                                role="option"
                                aria-selected={i === current}
                                onMouseDown={(e) => e.preventDefault()}
                                onMouseEnter={() => setActive(i)}
                                onClick={() => pick(it.id)}
                                className={cn("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm", i === current ? "bg-muted text-foreground" : "text-foreground")}
                            >
                                {it.icon}
                                <span className="min-w-0 truncate">{it.label}</span>
                                {it.sub && <span className="min-w-0 truncate text-xs text-muted-foreground">{it.sub}</span>}
                                <span className="ml-auto shrink-0 text-xs text-muted-foreground" aria-hidden>{i === current ? t("members.enterToAdd") : ""}</span>
                            </li>
                        ))
                    )}
                </ul>
            )}
        </div>
    );
}

/* ── 成員編輯 / The member editor ───────────────────────────── */

const personIcon = (p: MemberPerson | null) =>
    p?.is_superuser ? <Shield size={14} className="shrink-0 text-muted-foreground" aria-hidden /> : <User size={14} className="shrink-0 text-muted-foreground" aria-hidden />;

export function PeopleMembers({
    people,
    base,
    value,
    onChange,
    marks,
    storageKey,
    hint,
    canAdd = true,
    addHint,
    disabled = false,
}: {
    /** 可以加進來的人，也拿來查名字。/ Who can be added; also used to look names up. */
    people: MemberPerson[];
    /** 伺服器上的成員（拿來標出新加 / 拿掉的）。/ The server's members (to mark additions / removals). */
    base: number[];
    /** 草稿。/ The draft. */
    value: number[];
    onChange: (next: number[]) => void;
    /** 一列後面的標記（單一登入之類）。/ A mark after a row (SSO and the like). */
    marks?: (id: number) => React.ReactNode;
    storageKey: string;
    hint?: string;
    canAdd?: boolean;
    /** 不能加人時的說明。/ Why adding is off. */
    addHint?: string;
    disabled?: boolean;
}) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const [pasting, setPasting] = useState(false);
    const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
    const draft = useMemo(() => new Set(value), [value]);
    const rows = memberRows(base, value, byId);
    const shownRows = rows.filter((r) => (r.person ? personMatches(r.person, query) : query.trim() === "" || `#${r.id}`.includes(query.trim())));
    const pager = usePagination(shownRows.length, { storageKey, resetKey: query });
    const remove = (id: number) => onChange(value.filter((x) => x !== id));
    const add = (ids: number[]) => onChange([...value, ...ids.filter((id) => !draft.has(id))]);

    return (
        <div className="space-y-4">
            {/* 目前的成員 / Current members */}
            <div className="space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <h3 className="text-sm text-foreground">{t("members.current", { count: value.length })}</h3>
                    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
                </div>
                {rows.length >= 7 && (
                    <div className="relative">
                        <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("members.searchMembers")} aria-label={t("members.searchMembers")} className="h-8 pl-8" />
                    </div>
                )}
                {rows.length === 0 ? (
                    <p className="rounded-md px-3 py-2 text-sm text-muted-foreground ring-1 ring-inset ring-border/80">{t("members.none")}</p>
                ) : shownRows.length === 0 ? (
                    <p className="px-1 text-sm text-muted-foreground">{t("access.noMatch")}</p>
                ) : (
                    <ul className="divide-y divide-border/70 rounded-md ring-1 ring-inset ring-border/80">
                        {pageSlice(shownRows, pager.page, pager.size).map((r) => {
                            const name = r.person?.username ?? `#${r.id}`;
                            const removed = r.state === "removed";
                            return (
                                <li key={r.id} className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-sm">
                                    {personIcon(r.person)}
                                    <span className={cn("min-w-0 flex-1", removed && "opacity-60")}>
                                        <span className={cn("flex min-w-0 flex-wrap items-baseline gap-x-2", removed && "line-through")}>
                                            <span className="min-w-0 truncate text-foreground">{name}</span>
                                            {r.person?.email && <span className="min-w-0 truncate text-xs text-muted-foreground">{r.person.email}</span>}
                                        </span>
                                    </span>
                                    <span className="flex shrink-0 items-center gap-1.5 text-xs">
                                        {r.state === "added" && <span className="text-success">{t("members.new")}</span>}
                                        {removed && <span className="text-warning">{t("members.removing")}</span>}
                                        {r.person?.is_active === false && <span className="text-warning">{t("members.inactive")}</span>}
                                        {!r.person && <span className="text-muted-foreground">{t("members.unknown")}</span>}
                                        {r.person?.is_superuser && <span className="text-muted-foreground">{t("access.adminChip")}</span>}
                                        {marks?.(r.id)}
                                    </span>
                                    {removed ? (
                                        <Button type="button" variant="ghost" size="icon-xs" disabled={disabled} onClick={() => add([r.id])} aria-label={t("members.undoRemove", { name })} title={t("members.undoRemove", { name })}>
                                            <Undo2 />
                                        </Button>
                                    ) : (
                                        <Button
                                            type="button"
                                            variant="ghost"
                                            size="icon-xs"
                                            disabled={disabled}
                                            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                                            onClick={() => remove(r.id)}
                                            aria-label={t("members.remove", { name })}
                                            title={t("members.remove", { name })}
                                        >
                                            <X />
                                        </Button>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
                <Pagination pager={pager} compact className="justify-center" />
            </div>

            {/* 加人 / Add people */}
            <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm text-foreground">{t("members.add")}</h3>
                    {canAdd && (
                        <Button type="button" variant="ghost" size="sm" className="h-7 px-2" aria-expanded={pasting} disabled={disabled} onClick={() => setPasting((v) => !v)}>
                            <ClipboardPaste size={14} /> {t("members.pasteSeveral")}
                        </Button>
                    )}
                </div>
                {!canAdd ? (
                    <p className="text-sm text-muted-foreground">{addHint ?? t("members.noneToAdd")}</p>
                ) : (
                    <>
                        <TypeAhead
                            icon={<UserPlus />}
                            disabled={disabled}
                            placeholder={t("members.addSearch")}
                            emptyText={t("members.noPerson")}
                            onPick={(id) => add([id])}
                            search={(q) =>
                                addCandidates(people, q, draft).map((p) => ({ id: p.id, label: p.username, sub: p.email || undefined, icon: personIcon(p) }))
                            }
                        />
                        {pasting && <PasteSeveral people={people} members={draft} disabled={disabled} onAdd={(ids) => { add(ids); setPasting(false); }} onCancel={() => setPasting(false)} />}
                    </>
                )}
            </div>
        </div>
    );
}

function PasteSeveral({ people, members, disabled, onAdd, onCancel }: { people: MemberPerson[]; members: ReadonlySet<number>; disabled: boolean; onAdd: (ids: number[]) => void; onCancel: () => void }) {
    const { t } = useI18n();
    const id = useId();
    const [text, setText] = useState("");
    const tokens = parsePaste(text);
    const r = resolvePaste(tokens, people, members);
    return (
        <div className="space-y-2 rounded-md bg-surface p-3 ring-1 ring-inset ring-border/80">
            <label htmlFor={id} className="block text-xs text-muted-foreground">{t("members.pasteHint")}</label>
            <Textarea id={id} rows={3} value={text} autoFocus onChange={(e) => setText(e.target.value)} placeholder="alice, bob@example.com" />
            {tokens.length > 0 && (
                <p className="text-sm text-foreground" aria-live="polite">
                    {t("members.pasteFound", { count: r.found.length })}
                    {r.already.length > 0 && <span className="text-muted-foreground"> · {t("members.pasteAlready", { count: r.already.length })}</span>}
                    {r.missing.length > 0 && (
                        <span className="text-warning"> · {t("members.pasteMissing", { count: r.missing.length, names: r.missing.slice(0, 10).join(", ") + (r.missing.length > 10 ? " …" : "") })}</span>
                    )}
                </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={onCancel}>{t("common.cancel")}</Button>
                <Button type="button" size="sm" disabled={disabled || r.found.length === 0} onClick={() => onAdd(r.found)}>
                    {t("members.pasteAdd", { count: r.found.length })}
                </Button>
            </div>
        </div>
    );
}
