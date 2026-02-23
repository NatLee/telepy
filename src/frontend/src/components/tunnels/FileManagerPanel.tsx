import React from "react";
import {
    Folder,
    File,
    Upload,
    Download,
    RefreshCw,
    CornerLeftUp,
    FileCode2,
    Archive,
    Home,
    Image as ImageIcon
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { FileItem } from "@/types/tunnel";

interface FileManagerPanelProps {
    serverId: string;
    username: string;
    accessToken: string;
    initialPath?: string;
}

import { useFileManager } from "@/hooks/useFileManager";

export function FileManagerPanel({ serverId, username, accessToken, initialPath }: FileManagerPanelProps) {
    const { refs, state, actions } = useFileManager(serverId, username, accessToken, initialPath);

    const { fileInputRef } = refs;
    const {
        connected,
        connecting,
        currentPath, setCurrentPath,
        items,
        loading,
        uploading
    } = state;

    const {
        loadDirectory,
        handlePathSubmit,
        navigateTo,
        goUp,
        goHome,
        handleUploadClick,
        handleFileChange,
        handleDownload
    } = actions;

    const getIcon = (item: FileItem) => {
        if (item.type === "directory" || (item.permissions && item.permissions.string.startsWith("d"))) {
            return <Folder className="text-blue-500 fill-blue-500/20" size={16} />;
        }

        const name = item.name.toLowerCase();
        if (name.endsWith('.zip') || name.endsWith('.tar.gz') || name.endsWith('.rar')) {
            return <Archive className="text-amber-500" size={16} />;
        }
        if (name.endsWith('.png') || name.endsWith('.jpg') || name.endsWith('.jpeg')) {
            return <ImageIcon className="text-emerald-500" size={16} />;
        }
        if (name.endsWith('.js') || name.endsWith('.ts') || name.endsWith('.py') || name.endsWith('.json') || name.endsWith('.html')) {
            return <FileCode2 className="text-slate-500" size={16} />;
        }
        return <File className="text-slate-400" size={16} />;
    };

    const formatSize = (sizeStr: string | number) => {
        if (typeof sizeStr === 'string' && sizeStr.includes(" ")) return sizeStr; // already formatted like "4.5 MB" from backend
        const size = typeof sizeStr === 'string' ? parseInt(sizeStr) : sizeStr;
        if (isNaN(size)) return sizeStr;
        if (size < 1024) return size + " B";
        if (size < 1024 * 1024) return (size / 1024).toFixed(1) + " KB";
        return (size / (1024 * 1024)).toFixed(1) + " MB";
    };

    return (
        <div className="flex flex-col h-full bg-card text-card-foreground border-l border-border/50">
            <div className="p-3 border-b border-border/50 flex flex-col gap-3 shrink-0">
                <div className="flex items-center justify-between">
                    <h2 className="text-sm font-semibold flex items-center gap-2">
                        <Folder size={16} className="text-primary" /> File Manager
                    </h2>
                    <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${connecting ? 'bg-warning animate-pulse' : connected ? 'bg-success' : 'bg-destructive'}`} title={connected ? 'Connected' : 'Disconnected'} />
                        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => loadDirectory(currentPath)} disabled={!connected || loading}>
                            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
                        </Button>
                    </div>
                </div>

                <form onSubmit={handlePathSubmit} className="flex gap-2">
                    <Button type="button" variant="outline" size="icon" className="h-9 md:h-8 w-9 md:w-8 shrink-0" onClick={goHome} disabled={!connected} title="Home">
                        <Home size={14} />
                    </Button>
                    <Button type="button" variant="outline" size="icon" className="h-9 md:h-8 w-9 md:w-8 shrink-0" onClick={goUp} disabled={!connected} title="Go Up relative to current folder">
                        <CornerLeftUp size={14} />
                    </Button>
                    <Input
                        value={currentPath}
                        onChange={(e) => setCurrentPath(e.target.value)}
                        className="h-9 md:h-8 text-xs font-mono"
                        placeholder="Path"
                        disabled={!connected}
                    />
                </form>

                <div className="flex gap-2">
                    <input
                        type="file"
                        ref={fileInputRef}
                        onChange={handleFileChange}
                        className="hidden"
                    />
                    <Button
                        size="sm"
                        className="w-full text-xs h-9 md:h-8 gap-2"
                        onClick={handleUploadClick}
                        disabled={!connected || uploading}
                    >
                        {uploading ? (
                            <><RefreshCw size={14} className="animate-spin" /> Uploading...</>
                        ) : (
                            <><Upload size={14} /> Upload File</>
                        )}
                    </Button>
                </div>
            </div>

            <div className="flex-1 overflow-y-auto min-h-0 bg-background/50">
                {loading && items.length === 0 ? (
                    <div className="flex justify-center p-8">
                        <RefreshCw className="animate-spin text-muted-foreground" size={24} />
                    </div>
                ) : items.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground text-sm">
                        Empty directory
                    </div>
                ) : (
                    <ul className="divide-y divide-border/50">
                        {items.map((item, i) => {
                            const isDir = item.type === "directory" || (item.permissions && item.permissions.string.startsWith("d"));
                            return (
                                <li key={`${item.name}-${i}`} className="group flex items-center justify-between p-3 md:p-2 hover:bg-muted/50 transition-colors text-sm">
                                    <div
                                        className={`flex items-center gap-2 overflow-hidden ${isDir ? "cursor-pointer hover:text-primary transition-colors font-medium" : "text-foreground"}`}
                                        onClick={() => isDir && navigateTo(item.name)}
                                    >
                                        <span className="shrink-0">{getIcon(item)}</span>
                                        <span className="truncate" title={item.name}>{item.name}</span>
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0 ml-2">
                                        <span className="text-xs text-muted-foreground hidden sm:block w-16 text-right">
                                            {formatSize(item.size)}
                                        </span>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-8 w-8 md:h-7 md:w-7 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                                            onClick={() => handleDownload(item)}
                                            title="Download"
                                        >
                                            <Download size={14} />
                                        </Button>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </div>
    );
}
