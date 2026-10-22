/**
 * Passkey（WebAuthn）的瀏覽器端：把後端（webauthn-rs）給的 JSON 選項轉成 navigator.credentials 要的
 * ArrayBuffer，再把結果轉回 base64url JSON 送回後端。不用第三方套件。
 * Browser side of passkeys: decode the backend's JSON options for navigator.credentials and encode the
 * result back to the base64url JSON webauthn-rs expects. No third-party library.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export type JsonOptions = Record<string, any>;

function b64urlToBuffer(value: string): ArrayBuffer {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

function bufferToB64url(buf: ArrayBuffer | null | undefined): string | null {
    if (!buf) return null;
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 這個瀏覽器能不能用 passkey。/ Whether this browser supports passkeys at all. */
export function passkeySupported(): boolean {
    return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials;
}

/** 能不能在帳號欄位的自動填入裡提供 passkey（conditional mediation）。/ Whether autofill (conditional UI) is available. */
export async function conditionalMediationAvailable(): Promise<boolean> {
    if (!passkeySupported()) return false;
    const pkc = window.PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> };
    try {
        return typeof pkc.isConditionalMediationAvailable === "function" && (await pkc.isConditionalMediationAvailable());
    } catch {
        return false;
    }
}

/** 使用者在瀏覽器的 passkey 視窗按了取消（或逾時）。/ The user dismissed the browser's passkey prompt. */
export function isPasskeyCancel(err: unknown): boolean {
    return err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "AbortError");
}

/** 註冊：後端的 creation options（publicKey）→ navigator.credentials.create → JSON。/ Create a passkey. */
export async function createPasskey(publicKey: JsonOptions): Promise<JsonOptions> {
    const options: PublicKeyCredentialCreationOptions = {
        ...publicKey,
        challenge: b64urlToBuffer(publicKey.challenge),
        user: { ...publicKey.user, id: b64urlToBuffer(publicKey.user.id) },
        excludeCredentials: (publicKey.excludeCredentials ?? []).map((c: JsonOptions) => ({ ...c, id: b64urlToBuffer(c.id) })),
        // 盡量建立可被「發現」的憑證，免帳號登入（自動填入）才找得到它。
        // Prefer a discoverable credential so usernameless sign-in (autofill) can find it.
        authenticatorSelection: { ...(publicKey.authenticatorSelection ?? {}), residentKey: "preferred", requireResidentKey: false },
    } as PublicKeyCredentialCreationOptions;
    const cred = (await navigator.credentials.create({ publicKey: options })) as PublicKeyCredential | null;
    if (!cred) throw new DOMException("No credential", "NotAllowedError");
    const response = cred.response as AuthenticatorAttestationResponse;
    return {
        id: cred.id,
        rawId: bufferToB64url(cred.rawId),
        type: cred.type,
        response: {
            attestationObject: bufferToB64url(response.attestationObject),
            clientDataJSON: bufferToB64url(response.clientDataJSON),
            transports: typeof response.getTransports === "function" ? response.getTransports() : undefined,
        },
        extensions: cred.getClientExtensionResults(),
    };
}

/** 登入 / 再驗證：後端的 request options → navigator.credentials.get → JSON。/ Use a passkey. */
export async function getPasskey(
    publicKey: JsonOptions,
    opts: { mediation?: "conditional" | "optional"; signal?: AbortSignal } = {}
): Promise<JsonOptions> {
    const options: PublicKeyCredentialRequestOptions = {
        ...publicKey,
        challenge: b64urlToBuffer(publicKey.challenge),
        allowCredentials: (publicKey.allowCredentials ?? []).map((c: JsonOptions) => ({ ...c, id: b64urlToBuffer(c.id) })),
    } as PublicKeyCredentialRequestOptions;
    const request: CredentialRequestOptions & { mediation?: string } = { publicKey: options, signal: opts.signal };
    if (opts.mediation) request.mediation = opts.mediation;
    const cred = (await navigator.credentials.get(request)) as PublicKeyCredential | null;
    if (!cred) throw new DOMException("No credential", "NotAllowedError");
    const response = cred.response as AuthenticatorAssertionResponse;
    return {
        id: cred.id,
        rawId: bufferToB64url(cred.rawId),
        type: cred.type,
        response: {
            authenticatorData: bufferToB64url(response.authenticatorData),
            clientDataJSON: bufferToB64url(response.clientDataJSON),
            signature: bufferToB64url(response.signature),
            userHandle: bufferToB64url(response.userHandle),
        },
        extensions: cred.getClientExtensionResults(),
    };
}
