"use client";

/**
 * SSH 金鑰 › 金鑰群組：把金鑰放進群組，整組授予給一台裝置或一個通道群組（`KeyGroupsSection`）。
 * SSH keys › Key groups: put keys in groups and give a whole group to a device or a tunnel group (`KeyGroupsSection`).
 */
import React from "react";
import { KeyGroupsSection } from "@/components/keys/KeyGroupsSection";
import { useKeysArea } from "@/components/keys/KeysArea";

export default function KeyGroupsPage() {
    const { page, keyGroups, tunnelGroups } = useKeysArea();
    return <KeyGroupsSection api={keyGroups} keys={page.keys} tunnelGroups={tunnelGroups.groups} devices={page.devices} />;
}
