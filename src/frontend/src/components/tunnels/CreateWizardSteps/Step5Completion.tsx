/**
 * 建立通道精靈步驟 5：完成與 SSH 設定區塊。
 * Create tunnel wizard step 5: completion and SSH config block.
 */
import React from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { CodeBlock } from "@/components/ui/CodeBlock";

export interface Step5CompletionProps {
    createdHostName: string;
    sshPort: number;
    configContent: string;
    configLoading: boolean;
}

export function Step5Completion({ createdHostName, sshPort, configContent, configLoading }: Step5CompletionProps) {
    return (
        <div className="p-6 sm:p-8 text-center">
            <div className="mx-auto flex items-center justify-center h-20 w-20 rounded-full bg-green-100 mb-6 shadow-inner border-4 border-white shadow-xl shadow-green-100">
                <CheckCircle2 size={40} className="text-green-600" />
            </div>
            <h2 className="text-2xl font-bold text-gray-900 mb-2">Tunnel Created!</h2>
            <p className="text-gray-500 mb-8 max-w-lg mx-auto">
                Your tunnel <strong>{createdHostName}</strong> has been configured successfully. It is assigned to port <strong>{sshPort}</strong>.
            </p>

            <div className="text-left bg-slate-900 rounded-lg p-6 mb-8 max-w-lg mx-auto">
                <h4 className="text-sm font-medium text-gray-300 mb-1 text-center">SSH Config</h4>
                <p className="text-xs text-gray-400 mb-3 text-center">Add this to your local <code className="bg-slate-800 px-1 rounded">~/.ssh/config</code> to connect directly via SSH.</p>
                {configLoading ? (
                    <div className="flex justify-center py-4">
                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-white"></div>
                    </div>
                ) : (
                    <CodeBlock language="txt" value={configContent} />
                )}
            </div>

            <Link
                href="/tunnels"
                className="inline-flex items-center justify-center px-8 py-3 border border-transparent text-base font-semibold rounded-lg text-white bg-blue-600 hover:bg-blue-700 shadow-md hover:shadow-lg transition-all"
            >
                Go to Tunnels Dashboard
            </Link>
        </div>
    );
}
