import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export function uniqueID() {
    return Math.random().toString(36).substring(2, 18);
}

export function isValidSSHKey(key: string): boolean {
    const validKeyPrefixes = [
        "ssh-rsa",
        "ssh-dss",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "ssh-ed25519",
    ];

    const isValidKeyPrefix = validKeyPrefixes.some((prefix) =>
        key.startsWith(prefix)
    );
    if (!isValidKeyPrefix) {
        return false;
    }

    const base64Pattern = /^[A-Za-z0-9+/]+={0,3}( [^\s]+)?$/;
    const keyParts = key.split(" ");
    if (keyParts.length < 2 || !base64Pattern.test(keyParts[1])) {
        return false;
    }

    return true;
}

export function getHostFriendlyNameFromKey(
    key: string,
    hostFriendlyName: string
): string {
    if (!hostFriendlyName && isValidSSHKey(key)) {
        const keyParts = key.split(" ");
        const keyComment = keyParts[2];
        if (keyComment) {
            return keyComment;
        }
    }
    return hostFriendlyName;
}
