import { FolderOpen, Loader2, Play, RotateCcw, Settings, Square, TerminalSquare, X } from "lucide-react";
import { type KeyboardEvent, useId } from "react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { FlappyScreen, useFlappyGame } from "./MaimaiFlappy";

// 千禧风格的「MaiBot 未运行」页：一台坐在主机上的米黄电脑，屏幕和电源灯随服务状态变化；
// 下方是一块控制面板：左边下沉读数显示状态，右边是主操作键和辅助键。
export type MillenniumServicePhase =
  | "missing"
  | "standby"
  | "booting"
  | "linking"
  | "unreachable"
  | "stopping"
  | "error";

type LedTone = "off" | "amber" | "green" | "red";

const PHASE_DISPLAY: Record<
  MillenniumServicePhase,
  { word: string; led: LedTone; ledBlink: boolean; cells: "empty" | "full" | "running" }
> = {
  missing: { word: "未找到", led: "off", ledBlink: false, cells: "empty" },
  standby: { word: "待机", led: "off", ledBlink: false, cells: "empty" },
  booting: { word: "启动中", led: "amber", ledBlink: true, cells: "running" },
  linking: { word: "已运行", led: "green", ledBlink: false, cells: "running" },
  unreachable: { word: "无响应", led: "amber", ledBlink: false, cells: "full" },
  stopping: { word: "停止中", led: "amber", ledBlink: true, cells: "running" },
  error: { word: "已退出", led: "red", ledBlink: true, cells: "empty" },
};

const CELL_COUNT = 12;
const NOISE_DOTS: Array<[number, number]> = [
  [90, 52], [128, 74], [176, 58], [230, 48], [282, 70], [330, 54], [372, 78], [96, 196],
  [150, 210], [204, 192], [262, 206], [318, 196], [366, 212], [112, 130], [356, 136],
];

function ScreenContent({ phase }: { phase: MillenniumServicePhase }): React.JSX.Element {
  switch (phase) {
    case "booting":
    case "stopping":
      return (
        <>
          <text className="mil-launch-screen-text" fill="var(--mil-crt-amber)" fontSize="34" letterSpacing="8" textAnchor="middle" x="240" y="118">
            {phase === "booting" ? "BOOTING" : "SHUTDOWN"}
          </text>
          {Array.from({ length: 10 }, (_, index) => (
            <rect
              className="mil-launch-boot-block"
              fill="var(--mil-crt-amber)"
              height="16"
              key={index}
              style={{ animationDelay: `${index * 0.18}s` }}
              width="20"
              x={110 + index * 26}
              y="142"
            />
          ))}
        </>
      );
    case "linking":
      return (
        <>
          <path d="M74 84h332M74 132h332M74 180h332M140 36v194M206 36v194M272 36v194M338 36v194" stroke="var(--mil-crt-grid)" strokeWidth="2" />
          <path
            d="M84 150h44v-36h26v54h28v-74h24v62h30v-26h32v40h28v-20h40"
            fill="none"
            stroke="var(--mil-on)"
            strokeLinecap="square"
            strokeWidth="4"
          />
          <rect className="mil-launch-blink" fill="var(--mil-on)" height="20" width="12" x="362" y="140" />
        </>
      );
    case "unreachable":
      return (
        <>
          <path d="M74 84h332M74 132h332M74 180h332M140 36v194M206 36v194M272 36v194M338 36v194" stroke="var(--mil-crt-grid)" strokeWidth="2" />
          <path d="M84 150h292" fill="none" stroke="var(--mil-crt-amber)" strokeDasharray="12 10" strokeWidth="4" />
          <text className="mil-launch-screen-text" fill="var(--mil-crt-amber)" fontSize="30" letterSpacing="6" textAnchor="middle" x="240" y="112">
            NO RESPONSE
          </text>
        </>
      );
    case "error":
      return (
        <>
          <rect fill="var(--mil-danger)" height="56" width="260" x="110" y="96" />
          <text className="mil-launch-screen-text" fill="#fbf2e6" fontSize="34" letterSpacing="10" textAnchor="middle" x="240" y="136">
            ERROR
          </text>
          <rect className="mil-launch-blink" fill="var(--mil-crt-ink)" height="20" width="12" x="352" y="166" />
        </>
      );
    case "missing":
      return (
        <>
          <g fill="var(--mil-crt-noise)">
            {NOISE_DOTS.map(([x, y]) => <rect height="6" key={`${x}-${y}`} width="6" x={x} y={y} />)}
          </g>
          <text className="mil-launch-screen-text" fill="var(--mil-crt-ink)" fontSize="34" letterSpacing="6" textAnchor="middle" x="240" y="146">
            NO SIGNAL
          </text>
        </>
      );
    default:
      return (
        <>
          <text className="mil-launch-screen-text" fill="var(--mil-crt-amber)" fontSize="34" letterSpacing="8" textAnchor="middle" x="232" y="146">
            STANDBY
          </text>
          <rect className="mil-launch-blink" fill="var(--mil-crt-amber)" height="26" width="12" x="330" y="120" />
          <text className="mil-launch-screen-text mil-launch-play-hint" fill="var(--mil-crt-dim)" fontSize="15" letterSpacing="2" textAnchor="middle" x="240" y="198">
            CLICK TO PLAY
          </text>
        </>
      );
  }
}

function MillenniumComputer({
  phase,
  game,
}: {
  phase: MillenniumServicePhase;
  game: ReturnType<typeof useFlappyGame>["state"] | null;
}): React.JSX.Element {
  const display = PHASE_DISPLAY[phase];
  const svgId = useId().replace(/:/gu, "");
  const scanlineId = `mil-launch-scan-${svgId}`;

  return (
    <svg aria-hidden className="mil-launch-computer" fill="none" viewBox="0 0 480 400">
      <defs>
        <pattern height="4" id={scanlineId} patternUnits="userSpaceOnUse" width="4">
          <rect fill="rgb(255 255 255 / 0.035)" height="2" width="4" />
        </pattern>
      </defs>
      {/* 显示器 */}
      <rect fill="var(--mil-panel)" height="276" stroke="var(--mil-line)" strokeWidth="3" width="400" x="40" y="8" />
      <path d="M43 281V11h394" stroke="var(--mil-hi)" strokeWidth="3" />
      <path d="M43 281h394V11" stroke="var(--mil-lo)" strokeWidth="3" />
      <rect fill="var(--mil-lo)" height="210" stroke="var(--mil-line)" strokeWidth="2" width="348" x="66" y="28" />
      <rect fill="var(--mil-crt)" height="194" width="332" x="74" y="36" />
      <rect fill={`url(#${scanlineId})`} height="194" width="332" x="74" y="36" />
      {game ? <FlappyScreen clipId={`mil-launch-clip-${svgId}`} state={game} /> : <ScreenContent phase={phase} />}
      <path d="M77 230V39h329" stroke="rgb(0 0 0 / 0.35)" strokeWidth="6" />
      <path d="M352 44h44v10" stroke="rgb(255 255 255 / 0.12)" strokeWidth="4" />
      {/* 下巴：铭牌、散热孔、电源灯 */}
      <rect fill="var(--mil-plate)" height="22" width="94" x="66" y="248" />
      <text className="mil-launch-screen-text" fill="var(--mil-plate-ink)" fontSize="16" letterSpacing="3" textAnchor="middle" x="113" y="265">
        MAIBOT
      </text>
      <path d="M196 252v14M206 252v14M216 252v14M226 252v14M236 252v14M246 252v14M256 252v14M266 252v14" stroke="var(--mil-vent)" strokeWidth="4" />
      <rect
        className={cn("mil-launch-led", !game && display.ledBlink && "mil-launch-blink")}
        data-tone={game ? "green" : display.led}
        height="14"
        stroke="var(--mil-line)"
        strokeWidth="2"
        width="14"
        x="390"
        y="253"
      />
      {/* 脖子与主机 */}
      <rect fill="var(--mil-lo)" height="14" stroke="var(--mil-line)" strokeWidth="2" width="88" x="196" y="284" />
      <rect fill="var(--mil-panel)" height="84" stroke="var(--mil-line)" strokeWidth="3" width="452" x="14" y="298" />
      <path d="M17 379V301h446" stroke="var(--mil-hi)" strokeWidth="3" />
      <path d="M17 379h446V301" stroke="var(--mil-lo)" strokeWidth="3" />
      <rect fill="var(--mil-key)" height="34" stroke="var(--mil-line)" strokeWidth="2" width="150" x="38" y="318" />
      <rect fill="var(--mil-line)" height="8" width="112" x="48" y="330" />
      <rect fill="var(--mil-crt-dim)" height="8" width="10" x="168" y="330" />
      <path d="M214 318h120M214 330h120M214 342h120M214 354h120" stroke="var(--mil-vent)" strokeWidth="4" />
      <rect fill="var(--mil-hot)" height="52" stroke="var(--mil-line)" strokeWidth="2" width="58" x="382" y="312" />
      <rect fill="var(--mil-hot-side)" height="8" width="54" x="384" y="354" />
      <path d="M411 322v12M402 328v14h18V328" stroke="var(--mil-hot-ink)" strokeLinecap="square" strokeWidth="3" />
      <rect fill="var(--mil-line)" height="8" width="44" x="40" y="382" />
      <rect fill="var(--mil-line)" height="8" width="44" x="396" y="382" />
    </svg>
  );
}

export function MillenniumStatusPanel({
  phase,
  title,
  busy,
  onStart,
  onStop,
  onOpenTerminal,
  onOpenFolder,
  onOpenSettings,
}: {
  phase: MillenniumServicePhase;
  title: string;
  busy: boolean;
  onStart?: () => void;
  onStop?: () => void;
  onOpenTerminal?: () => void;
  onOpenFolder?: () => void;
  onOpenSettings?: () => void;
}): React.JSX.Element {
  const display = PHASE_DISPLAY[phase];
  // 待机时屏幕可以点，点了在屏幕上玩小游戏；离开待机就收起
  const game = useFlappyGame(phase === "standby");
  const gaming = phase === "standby" && game.state.mode !== "off";
  const handleScreenKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "ArrowUp") {
      event.preventDefault();
      game.press();
    } else if (event.key === "Escape" && gaming) {
      event.preventDefault();
      game.exit();
    }
  };
  const handleStart = onStart
    ? () => {
        game.exit();
        onStart();
      }
    : undefined;
  const transitioning = phase === "booting" || phase === "stopping";
  const primaryClassName = "mil-launch-primary";
  const secondaryKeys: React.JSX.Element[] = [];

  let primary: React.JSX.Element | null = null;
  if (phase === "standby" || phase === "error") {
    primary = (
      <Button className={primaryClassName} disabled={busy || !handleStart} onClick={handleStart}>
        {busy ? <Loader2 className="animate-spin" /> : phase === "error" ? <RotateCcw /> : <Play />}
        {phase === "error" ? "重新启动" : "启动麦麦"}
      </Button>
    );
  } else if (transitioning) {
    primary = (
      <Button className={primaryClassName} disabled>
        <Loader2 className="animate-spin" />
        {phase === "booting" ? "启动中…" : "停止中…"}
      </Button>
    );
  } else if (phase === "missing") {
    primary = (
      <Button className={primaryClassName} disabled={!onOpenSettings} onClick={onOpenSettings}>
        <Settings />
        服务设置
      </Button>
    );
  } else if (onOpenTerminal) {
    primary = (
      <Button className={primaryClassName} onClick={onOpenTerminal} variant="outline">
        <TerminalSquare />
        看终端
      </Button>
    );
  }

  const primaryIsTerminal = (phase === "linking" || phase === "unreachable") && Boolean(onOpenTerminal);
  if (onOpenTerminal && !primaryIsTerminal && phase !== "missing") {
    secondaryKeys.push(
      <Button key="terminal" onClick={onOpenTerminal} variant="outline">
        <TerminalSquare />
        终端
      </Button>,
    );
  }
  if ((phase === "linking" || phase === "unreachable") && onStop) {
    secondaryKeys.push(
      <Button disabled={busy} key="stop" onClick={onStop} variant="outline">
        <Square />
        停止
      </Button>,
    );
  }
  if (gaming) {
    secondaryKeys.push(
      <Button key="exit-game" onClick={game.exit} variant="outline">
        <X />
        退出游戏
      </Button>,
    );
  } else if ((phase === "standby" || phase === "error") && onOpenFolder) {
    secondaryKeys.push(
      <Button key="folder" onClick={onOpenFolder} variant="outline">
        <FolderOpen />
        目录
      </Button>,
    );
  }

  return (
    <section
      aria-labelledby="mil-launch-title"
      className="mil-launch relative flex h-full min-h-0 items-center justify-center overflow-auto bg-transparent p-6"
    >
      <div className="mil-launch-stack">
        <div className="mil-launch-screen-wrap">
          <MillenniumComputer game={gaming ? game.state : null} phase={phase} />
          {phase === "standby" ? (
            <button
              aria-label={gaming ? "让麦麦往上拍一下" : "在屏幕上玩小游戏"}
              className="mil-launch-screen-hit"
              onClick={game.press}
              onKeyDown={handleScreenKey}
              type="button"
            />
          ) : null}
        </div>
        <div className="mil-launch-panel">
          <div className="mil-launch-head">
            <h3 id="mil-launch-title">{title}</h3>
            <i aria-hidden className="mil-launch-grip" />
          </div>
          <div className="mil-launch-body">
            <div aria-live="polite" className="mil-launch-readout">
              <div className="mil-launch-status">
                <i
                  aria-hidden
                  className={cn("mil-launch-status-led", !gaming && display.ledBlink && "mil-launch-blink")}
                  data-tone={gaming ? "green" : display.led}
                />
                <span className="mil-launch-status-label">状态</span>
                <span className="mil-launch-status-word">{gaming ? "小游戏" : display.word}</span>
              </div>
              {gaming ? (
                <div className="mil-launch-scores">
                  <span><span className="mil-launch-status-label">本次</span> {game.state.score}</span>
                  <span><span className="mil-launch-status-label">最高</span> {game.state.best}</span>
                </div>
              ) : (
                <div aria-hidden className="mil-launch-cells" data-mode={display.cells}>
                  {Array.from({ length: CELL_COUNT }, (_, index) => (
                    <i key={index} style={{ animationDelay: `${index * 0.12}s` }} />
                  ))}
                </div>
              )}
            </div>
            {primary || secondaryKeys.length > 0 ? (
              <div className="mil-launch-keys">
                {primary}
                {secondaryKeys.length > 0 ? <div className="mil-launch-secondary">{secondaryKeys}</div> : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
