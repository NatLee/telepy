/**
 * 機器類型的圖示（lucide）。網路頁的樹、表格、面板與「網路上有什麼」共用。
 * Icons per machine type (lucide), shared by the network page's tree, table, panel and "what's on the network".
 */
import React from "react";
import { Boxes, Cctv, Clapperboard, HardDrive, House, Monitor, Printer, Router, Server, Smartphone, Wifi } from "lucide-react";
import type { DeviceKind } from "@/lib/lanIdentity";

export const DEVICE_ICON: Record<DeviceKind, React.ReactNode> = {
    router: <Router />,
    network: <Wifi />,
    nas: <HardDrive />,
    hypervisor: <Boxes />,
    server: <Server />,
    computer: <Monitor />,
    printer: <Printer />,
    camera: <Cctv />,
    media: <Clapperboard />,
    iot: <House />,
    phone: <Smartphone />,
};
