/**
 * 建立通道精靈步驟 4：測試連線腳本與連線狀態。
 * Create tunnel wizard step 4: test connection script and status.
 */
import React from "react";
import { ChevronRight, Info, AlertTriangle } from "lucide-react";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { ConnectionStatusLight } from "@/components/ui/ConnectionStatusLight";

export interface Step4TestConnectionProps {
    sshScriptContent: string;
    autosshScriptContent: string;
    status: { is_connected?: boolean; host_friendly_name?: string; reverse_port?: number } | null;
    createdHostName: string;
    sshPort: number;
    onBack: () => void;
    onNext: () => void;
}

export function Step4TestConnection({
    sshScriptContent,
    autosshScriptContent,
    status,
    createdHostName,
    sshPort,
    onBack,
    onNext,
}: Step4TestConnectionProps) {
    return (
        <div className="p-6 sm:p-8">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Execute Connection Script</h3>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 flex items-start gap-2 text-sm text-blue-800">
                <Info size={16} className="mt-0.5 shrink-0" />
                <span>Run this script <strong>on your target server</strong> to establish the reverse tunnel.</span>
            </div>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm text-amber-800">
                <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                <span>Make sure the keys from <strong>Step 2</strong> are already in <code className="bg-amber-100 px-1 rounded">~/.ssh/authorized_keys</code> before running. Testing is optional — you can also retrieve scripts later from the Tunnels page.</span>
            </div>

            <div className="space-y-6 mb-6">
                <div>
                    <h4 className="text-sm font-semibold text-gray-800 mb-2">Option 1: Quick Testing (Standard SSH)</h4>
                    <CodeBlock language="bash" value={sshScriptContent} />
                </div>
                <div>
                    <h4 className="text-sm font-semibold text-gray-800 mb-2">Option 2: Persistent Connection (AutoSSH)</h4>
                    <CodeBlock language="bash" value={autosshScriptContent} />
                </div>
            </div>

            <div className={`p-5 rounded-lg border flex items-center gap-5 ${status?.is_connected ? "bg-green-50 border-green-200 text-green-800" : "bg-yellow-50 border-yellow-200 text-yellow-800"}`}>
                <ConnectionStatusLight state={status?.is_connected ? "connected" : "disconnected"} size={48} />
                <div>
                    <strong className="block text-sm mb-1">Connection Status</strong>
                    <span className="text-sm">
                        {status?.is_connected
                            ? `Connected! Tunnel "${status.host_friendly_name ?? createdHostName}" is active on port ${status.reverse_port ?? sshPort}.`
                            : "Waiting for connection from the remote endpoint..."}
                    </span>
                </div>
            </div>

            <div className="mt-8 flex justify-between">
                <button type="button" onClick={onBack} className="inline-flex items-center px-6 py-3 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">Back</button>
                <button type="button" onClick={onNext} className="inline-flex items-center px-6 py-3 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700">Next Step <ChevronRight size={16} className="ml-2 -mr-1" /></button>
            </div>
        </div>
    );
}
