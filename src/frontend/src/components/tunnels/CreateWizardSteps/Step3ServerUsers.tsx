/**
 * 建立通道精靈步驟 3：目標伺服器使用者清單。
 * Create tunnel wizard step 3: target server users list.
 */
import React from "react";
import { Info, ChevronRight } from "lucide-react";

export interface ServerUser {
    id: number;
    username: string;
}

export interface Step3ServerUsersProps {
    users: ServerUser[];
    newUsername: string;
    onNewUsernameChange: (v: string) => void;
    isProcessing: boolean;
    onAddUser: (e: React.FormEvent) => void;
    onDeleteUser: (u: ServerUser) => void;
    onBack: () => void;
    onNext: () => void;
}

export function Step3ServerUsers({
    users,
    newUsername,
    onNewUsernameChange,
    isProcessing,
    onAddUser,
    onDeleteUser,
    onBack,
    onNext,
}: Step3ServerUsersProps) {
    return (
        <div className="p-6 sm:p-8">
            <h3 className="text-lg font-medium text-gray-900 mb-4">Target Server Users</h3>
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-4 flex items-start gap-2 text-sm text-blue-800">
                <Info size={16} className="mt-0.5 shrink-0" />
                <span>Add at least one OS user that <strong>actually exists</strong> on your target server (e.g. <code className="bg-blue-100 px-1 rounded">root</code>, <code className="bg-blue-100 px-1 rounded">ubuntu</code>). Connections will only be allowed for listed usernames.</span>
            </div>
            <p className="text-sm text-gray-500 mb-6">Specify which OS usernames (e.g., root, ubuntu, your_name) on your server are allowed to be used for connections via this tunnel.</p>

            <form onSubmit={onAddUser} className="flex gap-2 mb-6">
                <input
                    type="text"
                    value={newUsername}
                    onChange={(e) => onNewUsernameChange(e.target.value)}
                    placeholder="e.g. root"
                    className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-green-500 focus:border-green-500 sm:text-sm bg-slate-50"
                />
                <button
                    type="submit"
                    disabled={!newUsername.trim() || isProcessing}
                    className="inline-flex items-center px-6 py-2 border border-transparent shadow-sm text-sm font-medium rounded-lg text-white bg-blue-600 hover:bg-blue-700 focus:outline-none disabled:opacity-50"
                >
                    Add User
                </button>
            </form>

            <div className="bg-white border rounded-lg overflow-hidden mb-8">
                {users.length === 0 ? (
                    <div className="p-8 text-center text-gray-500">No users added yet. Add users to enable connections.</div>
                ) : (
                    <ul className="divide-y divide-gray-200">
                        {users.map((serverUser) => (
                            <li key={serverUser.id} className="px-6 py-4 flex items-center justify-between">
                                <span className="font-medium text-gray-900">{serverUser.username}</span>
                                <button type="button" onClick={() => onDeleteUser(serverUser)} className="text-red-500 hover:text-red-700 text-sm font-medium">Remove</button>
                            </li>
                        ))}
                    </ul>
                )}
            </div>

            <div className="flex justify-between">
                <button type="button" onClick={onBack} className="inline-flex items-center px-6 py-3 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">Back</button>
                <button type="button" onClick={onNext} className="inline-flex items-center px-6 py-3 border border-transparent rounded-lg shadow-sm text-sm font-medium text-white bg-green-600 hover:bg-green-700">Next Step <ChevronRight size={16} className="ml-2 -mr-1" /></button>
            </div>
        </div>
    );
}
