/**
 * 分享彈窗內的權限對照表（Admin/Editor/Viewer）。
 * Permission matrix table inside share modal (Admin / Editor / Viewer).
 */
import React from "react";
import { Shield, Check, X } from "lucide-react";

export function ShareModalPermissionMatrix() {
    return (
        <div className="bg-card border border-border shadow-sm rounded-lg overflow-hidden text-sm">
            <div className="bg-muted/40 px-4 py-2.5 border-b border-border flex items-center gap-2 font-medium text-foreground">
                <Shield size={16} className="text-primary" />
                <span>Permission Matrix</span>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-xs text-left">
                    <thead>
                        <tr className="bg-muted/50 border-b border-border text-xs text-muted-foreground">
                            <th className="px-4 py-2 font-semibold text-left">Role</th>
                            <th className="px-3 py-2 font-medium">View Tunnels</th>
                            <th className="px-3 py-2 font-medium">Edit tunnel configurations</th>
                            <th className="px-3 py-2 font-medium">Manage Target Users</th>
                            <th className="px-3 py-2 font-medium">Share Tunnels</th>
                            <th className="px-3 py-2 font-medium">Delete Tunnels</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-border border-b border-border text-center bg-card">
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-2 font-medium text-left text-foreground">Admin</td>
                            <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                            <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                            <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                            <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                            <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-2 font-medium text-left text-foreground">Editor</td>
                            <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                            <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                            <td className="px-3 py-2 text-center">
                                <div className="flex items-center justify-center gap-0.5" title="Can only manage assigned and self-created Target Users">
                                    <Check size={16} className="text-foreground" />
                                    <span className="text-[10px] text-muted-foreground/70 -mt-2">*</span>
                                </div>
                            </td>
                            <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                            <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                        </tr>
                        <tr className="hover:bg-muted/30 transition-colors">
                            <td className="px-4 py-2 font-medium text-left text-foreground">Viewer</td>
                            <td className="px-3 py-2"><Check size={16} className="mx-auto text-foreground" /></td>
                            <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                            <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                            <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                            <td className="px-3 py-2"><X size={16} className="mx-auto text-muted-foreground/50" /></td>
                        </tr>
                    </tbody>
                </table>
            </div>
            <div className="px-4 py-2 border-t border-border bg-muted/20 text-[10px] text-muted-foreground">
                * Editors can only manage Target Users that are already assigned to them or self-created.
            </div>
        </div>
    );
}
