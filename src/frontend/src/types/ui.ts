/**
 * UI 共用型別 / UI Component types
 * Defines shared types across UI components.
 */

export interface ViewToggleProps {
    value: "list" | "card";
    onChange: (value: "list" | "card") => void;
    storageKey?: string;
}
