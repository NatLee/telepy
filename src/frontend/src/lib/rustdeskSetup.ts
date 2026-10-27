/**
 * 「讓那台電腦的 RustDesk 準備好」清單的狀態（純函式，`rustdeskSetup.test.ts` 有測試）。
 * Telepy 經隧道連 RustDesk 的 Direct IP 埠，所以那台的 RustDesk 要：開著並啟用 IP 直接存取、有固定密碼（密碼設定不是
 * 「只用一次性密碼」）、macOS 給螢幕錄製與輔助使用權限；裝了系統服務才會在 app 關掉或重開機後還連得到（只能提醒，
 * Telepy 看不到）。狀態來源：從裝置探測埠、上一次連線的失敗、這個目標這次開頁以來有沒有連上過。
 * 「Mac 的聲音」也只是提醒（開了聲音、上次連到的是 macOS 才顯示）：Apple 晶片版的 RustDesk 經 ScreenCaptureKit 抓系統
 * 聲音（螢幕錄製權限），Intel 版只會錄「音訊輸入」裝置（預設是麥克風），要系統聲音得裝 BlackHole 這類 loopback 裝置。
 * The "get that computer's RustDesk ready" checklist. Telepy reaches RustDesk's Direct IP port through the tunnel, so
 * that RustDesk must be open with direct IP access on, have a permanent password it accepts, and (on macOS) hold the
 * screen and control permissions; its system service keeps it reachable after the app closes or the computer
 * restarts (advice only: Telepy cannot see it). States come from the port probe, the last connect failure, and
 * whether a session to this target connected since the page opened.
 */

export type SetupStepId = "directIp" | "password" | "permissions" | "sound" | "service";
export const SETUP_STEPS: readonly SetupStepId[] = ["directIp", "password", "permissions", "sound", "service"];
/** 只是提醒、不擋「準備好了」的步驟。/ Advice-only steps that never hold back "ready". */
const ADVICE: readonly SetupStepId[] = ["sound", "service"];

/** ok = 確認好了、failed = 確定是這裡、checking = 探測中、unknown = 還不知道、advice = 只能提醒。/ advice = cannot be checked. */
export type StepStatus = "ok" | "failed" | "checking" | "unknown" | "advice";

export interface SetupInput {
    probe: "idle" | "checking" | "ok" | "failed";
    /** 探測失敗的說明 key（`desktop.err.*`）。/ The probe failure's message key. */
    probeFailure?: string | null;
    /** 最近一次連線失敗的說明 key。/ The last connect failure's message key. */
    failure?: string | null;
    /** 這個目標這次開頁以來連上過。/ A session to this target connected since the page opened. */
    connected: boolean;
}

/** 埠沒人接：RustDesk 沒開或沒啟用 IP 直接存取。/ Nobody answers on the port: RustDesk closed or direct IP access off. */
const DIRECT_IP_FAILURES = new Set(["desktop.err.rdDirectIpOff", "desktop.err.rdOffline"]);

export function setupStatus(i: SetupInput): Record<SetupStepId, StepStatus> {
    const directIp: StepStatus =
        i.connected || i.probe === "ok"
            ? "ok"
            : i.probe === "checking"
              ? "checking"
              : (i.probe === "failed" && DIRECT_IP_FAILURES.has(i.probeFailure ?? "")) || DIRECT_IP_FAILURES.has(i.failure ?? "")
                ? "failed"
                : "unknown";
    const password: StepStatus = i.connected ? "ok" : i.failure === "desktop.err.rdPassword" ? "failed" : "unknown";
    const permissions: StepStatus = i.connected ? "ok" : i.failure === "desktop.err.rdNoDisplay" ? "failed" : "unknown";
    return { directIp, password, permissions, sound: "advice", service: "advice" };
}

/**
 * 現在該看的那一步：第一個確定有問題的；沒有就照順序第一個還不知道的；前三步都好了才輪到系統服務（建議）。
 * The step to spotlight: the first failed one, else the first not yet known in order; the service advice comes last.
 */
export function nextStep(s: Record<SetupStepId, StepStatus>): SetupStepId {
    const checked = SETUP_STEPS.filter((id) => !ADVICE.includes(id));
    return checked.find((id) => s[id] === "failed") ?? checked.find((id) => s[id] !== "ok") ?? "service";
}

/**
 * 清單上要顯示的步驟：「Mac 的聲音」只在開了聲音、上次連到的是 macOS 時出現。
 * The steps to show: the Mac sound advice only when sound is on and the last peer was a Mac.
 */
export function visibleSteps(soundFromMac: boolean): SetupStepId[] {
    return SETUP_STEPS.filter((id) => id !== "sound" || soundFromMac);
}

/** 前三步都確認好了（連上過）：清單收成一行。/ The checked steps are all fine: the card folds to one row. */
export function allReady(s: Record<SetupStepId, StepStatus>): boolean {
    return s.directIp === "ok" && s.password === "ok" && s.permissions === "ok";
}

/**
 * 探測失敗但不是 RustDesk 這端的問題（裝置離線、登入被拒…）：清單上方另外說，清單本身不知道。
 * The probe failed for a reason outside RustDesk (device offline, login refused…): shown above the list instead.
 */
export function tunnelProblem(i: Pick<SetupInput, "probe" | "probeFailure">): boolean {
    return i.probe === "failed" && !!i.probeFailure && !DIRECT_IP_FAILURES.has(i.probeFailure);
}
