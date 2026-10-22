/**
 * 以 Promise 方式要求再驗證：`const proof = await request(methods)`（取消回 null）；把 `dialog` 放進畫面。
 * Promise-based re-authentication: `await request(methods)` resolves with a proof, or null when cancelled.
 */
import React, { useCallback, useState } from "react";
import { ReauthDialog } from "@/components/auth/ReauthDialog";
import type { MfaMethod, MfaProof } from "@/lib/mfa";

export function useReauth() {
    const [pending, setPending] = useState<{ methods: MfaMethod[]; resolve: (proof: MfaProof | null) => void } | null>(null);

    const request = useCallback(
        (methods: MfaMethod[]) => new Promise<MfaProof | null>((resolve) => setPending({ methods, resolve })),
        []
    );

    const dialog = pending ? (
        <ReauthDialog
            methods={pending.methods}
            onDone={(proof) => {
                pending.resolve(proof);
                setPending(null);
            }}
        />
    ) : null;

    return { request, dialog };
}
