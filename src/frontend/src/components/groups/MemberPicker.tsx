/**
 * 群組編輯器的成員挑選（金鑰群組、通道群組共用），項目多時也不會把視窗撐得很長：上方是已選的籤（可直接移除，
 * 超過一定數量收成「+N」並切到「已選」）；7 個起有搜尋、「全部 / 已選 / 不在任何群組」分類與「全選這 N 個 /
 * 取消這 N 個」（作用在符合的全部，不只這一頁）；清單一欄一列、分頁（每頁筆數記在 `telepy.groupPickerPageSize`）。
 * Member picking for the group editors (key groups and tunnel groups) that stays short with many items: chips for
 * what is selected on top (removable; past a limit they fold into "+N", which opens "selected"); from 7 items a
 * search, "all / selected / in no group" buckets and "select / deselect these N" (every match, not just this page);
 * a one-column list in pages (page size kept in `telepy.groupPickerPageSize`).
 */
import React, { useMemo, useState } from "react";
import { CheckSquare, Search, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented } from "@/components/ui/segmented";
import { Chip } from "@/components/ui/section";
import { Pagination } from "@/components/ui/pagination";
import { usePagination } from "@/hooks/usePagination";
import { useI18n } from "@/lib/i18n";
import { pageSlice } from "@/lib/pagination";
import { pickerView, toggleMany, type PickerBucket, type PickerEntry } from "@/lib/memberPicker";

/** 這麼多個以上才有搜尋 / 分類 / 全選。/ Controls from this many items on. */
const CONTROLS_FROM = 7;
/** 上方最多列幾個已選的籤。/ Selected chips shown on top before "+N". */
const CHIPS = 10;

export interface MemberItem extends PickerEntry {
    label: string;
    /** 它現在所在群組的名稱（別組的會標「在 X」）。/ The name of the group it is in now. */
    groupName?: string | null;
    /** 名稱前的小圖示（狀態點、鑰匙）。/ A small icon before the name. */
    icon?: React.ReactNode;
    /** 名稱後的小字（金鑰類型）。/ Small text after the name (key type). */
    meta?: React.ReactNode;
    title?: string;
}

export function MemberPicker({
    items,
    selected,
    onChange,
    current,
    title,
    hint,
}: {
    items: MemberItem[];
    selected: number[];
    onChange: (ids: number[]) => void;
    /** 正在編輯的群組（新增時 null）。/ The group being edited (null when creating). */
    current: number | null;
    title: string;
    hint: string;
}) {
    const { t } = useI18n();
    const [query, setQuery] = useState("");
    const [bucket, setBucketState] = useState<PickerBucket>("all");
    // 進「已選」時記下當時選了哪些，在那裡取消勾選時那列先不消失。/ Remember what was selected when "selected" opened.
    const [kept, setKept] = useState<Set<number>>(new Set());
    const setBucket = (b: PickerBucket) => {
        setKept(b === "selected" ? new Set(selected) : new Set());
        setBucketState(b);
    };
    const sel = useMemo(() => new Set(selected), [selected]);
    const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
    const controls = items.length >= CONTROLS_FROM;
    const view = pickerView(items, sel, controls ? query : "", controls ? bucket : "all", kept);
    const pager = usePagination(view.shown.length, { storageKey: "telepy.groupPickerPageSize", resetKey: `${query}|${bucket}` });
    const rows = pageSlice(view.shown, pager.page, pager.size);
    const allShownOn = view.shown.length > 0 && view.shown.every((i) => sel.has(i.id));
    const chosen = selected.map((id) => byId.get(id)).filter((i): i is MemberItem => !!i);
    const buckets: { value: PickerBucket; label: string }[] = [
        { value: "all", label: `${t("groups.picker.all")} (${view.counts.all})` },
        { value: "selected", label: `${t("groups.picker.selected")} (${view.counts.selected})` },
        { value: "free", label: `${t("groups.picker.free")} (${view.counts.free})` },
    ];

    return (
        // min-w-0：fieldset 預設至少和最寬的子元素一樣寬（分類那排），手機上會把整個對話框撐破。
        // min-w-0: a fieldset is otherwise at least as wide as its widest child (the bucket row), which broke phones.
        <fieldset className="min-w-0 space-y-2.5">
            <legend className="flex flex-wrap items-baseline gap-x-2 text-sm text-foreground">
                {title}
                <span className="text-xs text-muted-foreground">{t("groups.selectedCount", { count: chosen.length })}</span>
            </legend>
            <p className="text-xs text-muted-foreground">{hint}</p>

            {/* 已選的：一眼看到這組有什麼，也能直接拿掉。/ What is selected: see the group at a glance and remove directly. */}
            <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-surface p-2 ring-1 ring-inset ring-border">
                {chosen.length === 0 ? (
                    <span className="px-1 text-xs text-muted-foreground">{t("groups.picker.none")}</span>
                ) : (
                    <>
                        {chosen.slice(0, CHIPS).map((i) => (
                            <Chip key={i.id} className="max-w-full gap-1 pr-0.5" title={i.title ?? i.label}>
                                <span className="truncate">{i.label}</span>
                                <button
                                    type="button"
                                    onClick={() => onChange(selected.filter((x) => x !== i.id))}
                                    aria-label={t("groups.picker.remove", { name: i.label })}
                                    className="grid size-4 shrink-0 place-items-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                                >
                                    <X className="size-3" />
                                </button>
                            </Chip>
                        ))}
                        {chosen.length > CHIPS && (
                            <button type="button" onClick={() => setBucket("selected")} className="rounded-sm px-1.5 py-px text-xs text-primary hover:underline">
                                {t("groups.picker.more", { count: chosen.length - CHIPS })}
                            </button>
                        )}
                    </>
                )}
            </div>

            {controls && (
                <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[10rem] flex-1">
                        <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden />
                        <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t("groups.search")} aria-label={t("groups.search")} className="h-8 pl-8" />
                    </div>
                    {/* 手機放不下一排：下拉選單；寬一點時整排、字太長就換行。/ Phones: a select; wider: one row whose labels wrap. */}
                    <NativeSelect value={bucket} onChange={(e) => setBucket(e.target.value as PickerBucket)} aria-label={t("groups.picker.bucketAria")} className="h-8 w-auto max-w-full sm:hidden">
                        {buckets.map((b) => (
                            <option key={b.value} value={b.value}>{b.label}</option>
                        ))}
                    </NativeSelect>
                    <Segmented size="sm" fullWidth className="hidden w-full sm:grid" value={bucket} onChange={setBucket} aria-label={t("groups.picker.bucketAria")} options={buckets} />
                </div>
            )}

            {view.shown.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border py-4 text-center text-sm text-muted-foreground">{t("groups.noMatch")}</p>
            ) : (
                <div className="overflow-hidden rounded-lg ring-1 ring-border">
                    {controls && view.shown.length > 1 && (
                        <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-2.5 py-1.5">
                            <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                className="text-primary hover:text-primary"
                                onClick={() => onChange(toggleMany(selected, view.shown.map((i) => i.id), !allShownOn))}
                            >
                                {allShownOn ? <Square /> : <CheckSquare />}
                                {allShownOn ? t("groups.picker.deselectShown", { count: view.shown.length }) : t("groups.picker.selectShown", { count: view.shown.length })}
                            </Button>
                        </div>
                    )}
                    <ul className="divide-y divide-border/70">
                        {rows.map((i) => {
                            const elsewhere = i.group !== null && i.group !== current && !sel.has(i.id) ? i.groupName : null;
                            return (
                                <li key={i.id}>
                                    <label className="flex min-w-0 cursor-pointer items-center gap-2.5 px-2.5 py-1.5 transition-colors hover:bg-muted/40 has-[:checked]:bg-primary/6" title={i.title}>
                                        <input
                                            type="checkbox"
                                            checked={sel.has(i.id)}
                                            onChange={(e) => onChange(toggleMany(selected, [i.id], e.target.checked))}
                                            className="size-4 shrink-0 accent-primary"
                                        />
                                        {i.icon}
                                        {/* 「在 X」放不下就換到下一行，名稱不被擠成「…」。/ The "in X" chip wraps below rather than squeezing the name. */}
                                        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                                            <span className="min-w-0 max-w-full truncate text-sm text-foreground">{i.label}</span>
                                            {elsewhere && <Chip className="max-w-full truncate">{t("groups.inGroup", { name: elsewhere })}</Chip>}
                                        </span>
                                        {i.meta}
                                    </label>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
            <Pagination pager={pager} />
        </fieldset>
    );
}
