import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin, { OptionType } from "@utils/types";
import { findStore } from "@webpack";
import { FluxDispatcher, React, RestAPI, TextInput } from "@webpack/common";

const logger = new Logger("FakeGameDetection");

interface DetectableExecutable {
    os: string;
    name: string;
    is_launcher?: boolean;
}

interface DetectableApp {
    id: string;
    name: string;
    aliases?: string[];
    icon?: string;
    icon_hash?: string;
    executables?: DetectableExecutable[];
}

interface FakeGameObject {
    cmdLine: string;
    exeName: string;
    exePath: string;
    hidden: boolean;
    isLauncher: boolean;
    id: string;
    name: string;
    pid: number;
    pidPath: number[];
    processName: string;
    start: number;
}

// ==========================================
// 1. CÀI ĐẶT PLUGIN (TÁCH BIỆT VỚI ENABLED)
// ==========================================
const settings = definePluginSettings({
    enablePresence: {
        type: OptionType.BOOLEAN,
        description: "Whether to show the presence (Bật/tắt giả lập game qua RunningGameStore)",
        default: true,
        onChange: (val: boolean) => {
            if (val) startSpoof();
            else stopSpoof();
        },
    },
    appSelector: {
        type: OptionType.COMPONENT,
        component: () => (
            <ErrorBoundary>
                <AppSearchSelector />
            </ErrorBoundary>
        ),
    },
    appId: {
        type: OptionType.STRING,
        hidden: true,
        default: "1236687512530063482",
    },
    appName: {
        type: OptionType.STRING,
        hidden: true,
        default: "Minecraft",
    },
    appIcon: {
        type: OptionType.STRING,
        hidden: true,
        default: "",
    },
    exeName: {
        type: OptionType.STRING,
        hidden: true,
        default: "javaw.exe",
    },
    customExeOverride: {
        type: OptionType.STRING,
        description: "Ghi đè tên file .exe thủ công (để trống nếu muốn tự động theo game đã chọn)",
        default: "",
        onChange: () => {
            if (settings.store.enablePresence) restartSpoof();
        },
    },
});

// ==========================================
// 2. LOGIC TẢI & TRA CỨU GAME
// ==========================================
let cachedCatalog: DetectableApp[] | null = null;
let catalogPromise: Promise<DetectableApp[]> | null = null;

async function fetchDetectableCatalog(forceRefresh = false): Promise<DetectableApp[]> {
    if (cachedCatalog && !forceRefresh) return cachedCatalog;
    if (catalogPromise && !forceRefresh) return catalogPromise;

    catalogPromise = RestAPI.get({ url: "/applications/detectable" })
        .then(res => {
            cachedCatalog = (res.body as DetectableApp[]) ?? [];
            return cachedCatalog;
        })
        .catch(err => {
            logger.error("Không thể tải danh sách /applications/detectable:", err);
            return cachedCatalog ?? [];
        })
        .finally(() => {
            catalogPromise = null;
        });

    return catalogPromise;
}

function resolveExeName(app: DetectableApp): string {
    const winExe = app.executables?.find(e => e.os === "win32") ?? app.executables?.[0];
    if (winExe?.name) {
        const cleaned = winExe.name.replace(/^>/, "");
        return cleaned.split("/").pop() || cleaned;
    }
    const slug = app.name.toLowerCase().replace(/[^a-z0-9]/g, "") || "game";
    return `${slug}.exe`;
}

function getAppIconUrl(appId: string, iconHash?: string): string | null {
    if (!appId || !iconHash) return null;
    return `https://cdn.discordapp.com/app-icons/${appId}/${iconHash}.png?size=128`;
}

// ==========================================
// 3. HOOK RUNNINGGAMESTORE (KIỂU 1 + GIỮ PHIÊN LIÊN TỤC)
// ==========================================
let activeFakeGame: FakeGameObject | null = null;
let isPatched = false;

let RunningGameStore: any = null;
let origGetRunningGames: (() => any[]) | null = null;
let origGetVisibleRunningGames: (() => any[]) | null = null;
let origGetVisibleGame: (() => any) | null = null;
let origGetGameForPID: ((pid: number) => any) | null = null;

function patchRunningGameStore() {
    if (isPatched) return;

    RunningGameStore = findStore("RunningGameStore");
    if (!RunningGameStore) {
        logger.error("Không tìm thấy RunningGameStore!");
        return;
    }

    origGetRunningGames = RunningGameStore.getRunningGames;
    origGetVisibleRunningGames = RunningGameStore.getVisibleRunningGames;
    origGetVisibleGame = RunningGameStore.getVisibleGame;
    origGetGameForPID = RunningGameStore.getGameForPID;

    // KIỂU 1: Nếu mở game thật TRÙNG ID với game đang fake -> ẩn bản fake để tránh trùng
    RunningGameStore.getRunningGames = function () {
        const real = origGetRunningGames?.call(this) ?? [];
        if (!activeFakeGame) return real;
        const hasSameRealGame = real.some((g: any) => g.id === activeFakeGame!.id);
        return hasSameRealGame ? real : [...real, activeFakeGame];
    };

    if (origGetVisibleRunningGames) {
        RunningGameStore.getVisibleRunningGames = function () {
            const real = origGetVisibleRunningGames?.call(this) ?? [];
            if (!activeFakeGame) return real;
            const hasSameRealGame = real.some((g: any) => g.id === activeFakeGame!.id);
            return hasSameRealGame ? real : [...real, activeFakeGame];
        };
    }

    if (origGetVisibleGame) {
        RunningGameStore.getVisibleGame = function () {
            return origGetVisibleGame?.call(this) ?? activeFakeGame;
        };
    }

    if (origGetGameForPID) {
        RunningGameStore.getGameForPID = function (pid: number) {
            if (activeFakeGame && pid === activeFakeGame.pid) return activeFakeGame;
            return origGetGameForPID?.call(this, pid);
        };
    }

    isPatched = true;
}

function unpatchRunningGameStore() {
    if (!isPatched || !RunningGameStore) return;

    if (origGetRunningGames) RunningGameStore.getRunningGames = origGetRunningGames;
    if (origGetVisibleRunningGames) RunningGameStore.getVisibleRunningGames = origGetVisibleRunningGames;
    if (origGetVisibleGame) RunningGameStore.getVisibleGame = origGetVisibleGame;
    if (origGetGameForPID) RunningGameStore.getGameForPID = origGetGameForPID;

    isPatched = false;
}

function startSpoof() {
    if (!settings.store.enablePresence) return;
    if (activeFakeGame) return; // Đã chạy rồi thì không tạo đè để giữ nguyên chuỗi giờ liên tục

    patchRunningGameStore();
    if (!RunningGameStore) return;

    const { appId, appName, exeName, customExeOverride } = settings.store;
    if (!appId || !appName) return;

    const finalExe = (customExeOverride?.trim() || exeName || `${appName.toLowerCase()}.exe`).replace(/^>/, "");
    const pid = Math.floor(Math.random() * 30000) + 10000;

    activeFakeGame = {
        cmdLine: `C:\\Program Files\\${appName}\\${finalExe}`,
        exeName: finalExe,
        exePath: `c:/program files/${appName.toLowerCase()}/${finalExe}`,
        hidden: false,
        isLauncher: false,
        id: appId,
        name: appName,
        pid,
        pidPath: [pid],
        processName: appName,
        start: Date.now(),
    };

    FluxDispatcher.dispatch({
        type: "RUNNING_GAMES_CHANGE",
        removed: [],
        added: [activeFakeGame],
        games: RunningGameStore.getRunningGames(),
    });

    logger.info(`Đang giả lập liên tục: ${appName} (ID: ${appId}, Exe: ${finalExe})`);
}

function stopSpoof() {
    if (!activeFakeGame || !RunningGameStore) return;

    const removedGame = activeFakeGame;
    activeFakeGame = null;

    FluxDispatcher.dispatch({
        type: "RUNNING_GAMES_CHANGE",
        removed: [removedGame],
        added: [],
        games: RunningGameStore.getRunningGames(),
    });
}

function restartSpoof() {
    stopSpoof();
    startSpoof();
}

// Chốt phiên tức thì khi đóng Discord hoặc Windows gửi tín hiệu đóng cửa sổ
function handleWindowUnload() {
    if (activeFakeGame) {
        stopSpoof();
    }
}

// ==========================================
// 4. GIAO DIỆN PREVIEW GIỐNG CUSTOMRPC
// ==========================================
function formatElapsed(startMs: number): string {
    const totalSec = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return hrs > 0 ? `${hrs}:${pad(mins)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

function PresencePreviewCard() {
    const { enablePresence, appId, appName, appIcon, exeName, customExeOverride } = settings.use([
        "enablePresence",
        "appId",
        "appName",
        "appIcon",
        "exeName",
        "customExeOverride",
    ]);

    const [, setTick] = React.useState(0);
    const [imgError, setImgError] = React.useState(false);

    React.useEffect(() => {
        setImgError(false);
    }, [appId, appIcon]);

    React.useEffect(() => {
        const timer = setInterval(() => setTick(t => t + 1), 1000);
        return () => clearInterval(timer);
    }, []);

    const iconUrl = getAppIconUrl(appId, appIcon);
    const startMs = activeFakeGame?.start ?? Date.now();
    const displayExe = customExeOverride?.trim() || exeName || "game.exe";

    return (
        <div style={{ marginTop: "8px", marginBottom: "16px" }}>
            <div style={{ color: "var(--text-muted)", fontSize: "13px", marginBottom: "12px", lineHeight: "1.4" }}>
                Plugin giả lập tiến trình game liên tục qua <b>RunningGameStore</b> (không tự reset giờ chơi).
                Nếu mở trùng đúng game đang fake ngoài đời thật, plugin sẽ tự nhường cho game thật.
            </div>

            <div
                style={{
                    backgroundColor: "var(--background-secondary-alt, #1e1f22)",
                    border: "1px solid var(--border-subtle, rgba(255,255,255,0.08))",
                    borderRadius: "8px",
                    padding: "12px",
                    maxWidth: "320px",
                    opacity: enablePresence ? 1 : 0.65,
                }}
            >
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: "10px",
                        fontSize: "12px",
                        fontWeight: 600,
                        color: "var(--header-secondary, #b5bac1)",
                    }}
                >
                    <span>{enablePresence ? "Đang chơi" : "Đang chơi (Tạm tắt)"}</span>
                    <span style={{ letterSpacing: "1px", opacity: 0.7 }}>•••</span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                    <div
                        style={{
                            width: "60px",
                            height: "60px",
                            borderRadius: "8px",
                            backgroundColor: "var(--background-tertiary, #111214)",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            overflow: "hidden",
                            flexShrink: 0,
                        }}
                    >
                        {iconUrl && !imgError ? (
                            <img
                                src={iconUrl}
                                alt={appName}
                                onError={() => setImgError(true)}
                                style={{ width: "100%", height: "100%", objectFit: "cover" }}
                            />
                        ) : (
                            <span style={{ fontSize: "28px", fontWeight: 800, color: "var(--header-primary, #fff)" }}>
                                ?
                            </span>
                        )}
                    </div>

                    <div style={{ minWidth: 0, flex: 1 }}>
                        <div
                            style={{
                                fontSize: "14px",
                                fontWeight: 700,
                                color: "var(--header-primary, #f2f3f5)",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}
                        >
                            {appName || "Chưa chọn game"}
                        </div>

                        <div
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: "5px",
                                marginTop: "4px",
                                fontSize: "12px",
                                fontWeight: 600,
                                color: enablePresence ? "#23a55a" : "var(--text-muted, #949ba4)",
                            }}
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M17.5 6H6.5C3.46 6 1 8.46 1 11.5v3.25C1 16.54 2.46 18 4.25 18c1.1 0 2.13-.55 2.74-1.47L8.35 14.5h7.3l1.36 2.03A3.29 3.29 0 0 0 19.75 18C21.54 18 23 16.54 23 14.75V11.5C23 8.46 20.54 6 17.5 6ZM9 12H7.5v1.5h-1.5V12H4.5v-1.5H6V9h1.5v1.5H9V12Zm7.5-.75a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm2.5 2a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
                            </svg>
                            <span>{enablePresence ? formatElapsed(startMs) : "0:00"}</span>
                        </div>

                        <div
                            style={{
                                fontSize: "11px",
                                color: "var(--text-muted, #949ba4)",
                                marginTop: "3px",
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}
                        >
                            {displayExe} • ID: {appId || "N/A"}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ==========================================
// 5. Ô TÌM KIẾM ỨNG DỤNG
// ==========================================
function AppSearchSelector() {
    const { appId, appName } = settings.use(["appId", "appName"]);
    const [catalog, setCatalog] = React.useState<DetectableApp[]>(cachedCatalog ?? []);
    const [loading, setLoading] = React.useState<boolean>(!cachedCatalog);
    const [query, setQuery] = React.useState<string>("");

    const loadCatalog = React.useCallback((force = false) => {
        setLoading(true);
        fetchDetectableCatalog(force).then(list => {
            setCatalog(list);
            setLoading(false);
        });
    }, []);

    React.useEffect(() => {
        if (!cachedCatalog) {
            loadCatalog(false);
        }
    }, [loadCatalog]);

    const filteredApps = React.useMemo(() => {
        if (!catalog.length) return [];
        const q = query.trim().toLowerCase();

        if (!q) {
            return catalog.slice(0, 30);
        }

        const exact: DetectableApp[] = [];
        const starts: DetectableApp[] = [];
        const includes: DetectableApp[] = [];

        for (const app of catalog) {
            const nameLower = app.name.toLowerCase();
            const aliasMatch = app.aliases?.some(a => a.toLowerCase().includes(q));

            if (nameLower === q) exact.push(app);
            else if (nameLower.startsWith(q)) starts.push(app);
            else if (nameLower.includes(q) || aliasMatch) includes.push(app);

            if (exact.length + starts.length + includes.length >= 120) break;
        }

        return [...exact, ...starts, ...includes].slice(0, 40);
    }, [catalog, query]);

    const handleSelectApp = (app: DetectableApp) => {
        settings.store.appId = app.id;
        settings.store.appName = app.name;
        settings.store.appIcon = app.icon_hash || app.icon || "";
        settings.store.exeName = resolveExeName(app);

        if (settings.store.enablePresence) {
            restartSpoof();
        }
    };

    return (
        <div
            style={{
                backgroundColor: "var(--background-secondary, #2b2d31)",
                borderRadius: "8px",
                padding: "12px",
                border: "1px solid var(--border-subtle, rgba(255,255,255,0.06))",
            }}
        >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
                <div>
                    <div style={{ fontSize: "14px", fontWeight: 600, color: "var(--header-primary, #f2f3f5)" }}>
                        Tìm kiếm ứng dụng / Game được Discord hỗ trợ
                    </div>
                    <div style={{ fontSize: "12px", color: "var(--text-muted, #949ba4)" }}>
                        Đang chọn: <b style={{ color: "var(--text-normal, #dbdee1)" }}>{appName}</b> ({catalog.length.toLocaleString()} game khả dụng)
                    </div>
                </div>

                <button
                    type="button"
                    onClick={() => loadCatalog(true)}
                    disabled={loading}
                    style={{
                        backgroundColor: "var(--button-secondary-background, #4e5058)",
                        color: "#fff",
                        border: "none",
                        borderRadius: "4px",
                        padding: "6px 10px",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: loading ? "wait" : "pointer",
                    }}
                >
                    {loading ? "Đang tải..." : "Làm mới"}
                </button>
            </div>

            <TextInput
                value={query}
                onChange={(val: string) => setQuery(val)}
                placeholder="Nhập tên game (VD: Minecraft, Wuthering Waves, Valorant, CS2...)"
            />

            <div
                style={{
                    marginTop: "10px",
                    maxHeight: "260px",
                    overflowY: "auto",
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    paddingRight: "4px",
                }}
            >
                {loading && !catalog.length ? (
                    <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
                        Đang tải danh sách game từ Discord API (/applications/detectable)...
                    </div>
                ) : filteredApps.length === 0 ? (
                    <div style={{ padding: "16px", textAlign: "center", color: "var(--text-muted)", fontSize: "13px" }}>
                        Không tìm thấy tựa game nào khớp với "{query}"
                    </div>
                ) : (
                    filteredApps.map(app => {
                        const isSelected = app.id === appId;
                        const iconUrl = getAppIconUrl(app.id, app.icon_hash || app.icon);
                        const exe = resolveExeName(app);

                        return (
                            <div
                                key={app.id}
                                onClick={() => handleSelectApp(app)}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: "10px",
                                    padding: "8px 10px",
                                    borderRadius: "6px",
                                    cursor: "pointer",
                                    backgroundColor: isSelected
                                        ? "rgba(88, 101, 242, 0.22)"
                                        : "var(--background-tertiary, #1e1f22)",
                                    border: isSelected
                                        ? "1px solid #5865f2"
                                        : "1px solid transparent",
                                }}
                            >
                                <div
                                    style={{
                                        width: "32px",
                                        height: "32px",
                                        borderRadius: "6px",
                                        backgroundColor: "var(--background-secondary, #2b2d31)",
                                        display: "flex",
                                        alignItems: "center",
                                        justifyContent: "center",
                                        overflow: "hidden",
                                        flexShrink: 0,
                                    }}
                                >
                                    {iconUrl ? (
                                        <img
                                            src={iconUrl}
                                            alt=""
                                            loading="lazy"
                                            style={{ width: "100%", height: "100%", objectFit: "cover" }}
                                        />
                                    ) : (
                                        <span style={{ fontSize: "14px", fontWeight: 700, color: "var(--text-muted)" }}>?</span>
                                    )}
                                </div>

                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div
                                        style={{
                                            fontSize: "13px",
                                            fontWeight: 600,
                                            color: "var(--header-primary, #f2f3f5)",
                                            whiteSpace: "nowrap",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                        }}
                                    >
                                        {app.name}
                                    </div>
                                    <div
                                        style={{
                                            fontSize: "11px",
                                            color: "var(--text-muted, #949ba4)",
                                            whiteSpace: "nowrap",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                        }}
                                    >
                                        {exe} • ID: {app.id}
                                    </div>
                                </div>

                                <span
                                    style={{
                                        fontSize: "11px",
                                        fontWeight: 600,
                                        padding: "4px 8px",
                                        borderRadius: "4px",
                                        backgroundColor: isSelected ? "#5865f2" : "var(--background-modifier-accent, #3f4147)",
                                        color: "#fff",
                                        flexShrink: 0,
                                    }}
                                >
                                    {isSelected ? "Đang chọn" : "Chọn"}
                                </span>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

// ==========================================
// 6. ĐỊNH NGHĨA PLUGIN CHÍNH
// ==========================================
export default definePlugin({
    name: "FakeGameDetection",
    description: "Giả lập đang chơi game qua RunningGameStore kèm trình tìm kiếm ứng dụng & Preview như CustomRPC",
    authors: [{ name: "Usidiei", id: 0n }],
    tags: ["Activity", "Customisation"],
    settings,

    settingsAboutComponent: () => (
        <ErrorBoundary>
            <PresencePreviewCard />
        </ErrorBoundary>
    ),

    flux: {
        CONNECTION_OPEN() {
            if (settings.store.enablePresence) startSpoof();
        },
    },

    start() {
        window.addEventListener("beforeunload", handleWindowUnload);
        window.addEventListener("pagehide", handleWindowUnload);

        if (settings.store.enablePresence) startSpoof();
    },

    stop() {
        window.removeEventListener("beforeunload", handleWindowUnload);
        window.removeEventListener("pagehide", handleWindowUnload);

        stopSpoof();
        unpatchRunningGameStore();
    },
});
