import { useCallback, useEffect, useRef, useState } from "react";

// 待机屏幕上的小游戏：点屏幕让麦麦往上拍，穿过键帽柱子的缺口。
// 坐标沿用 MillenniumComputer 的 viewBox：屏幕可视区 x 74–406、y 36–230，地面从 y 214 开始。

export type FlappyMode = "off" | "ready" | "play" | "over";

const SCREEN_LEFT = 74;
const SCREEN_TOP = 36;
const SCREEN_WIDTH = 332;
const SCREEN_HEIGHT = 194;
const GROUND_Y = 214;
const BIRD_X = 130;
const BIRD_START_Y = 125;
const PIPE_WIDTH = 34;
const PIPE_GAP = 92;
const PIPE_SPEED = 1.35;
const PIPE_SPAWN_X = 420;
const PIPE_SPAWN_AFTER = 250;
const GRAVITY = 0.2;
const FLAP_VELOCITY = -4;
const MAX_FALL = 4.8;
// 判定框只算身体，比画出来的小一圈，嫩芽和尾巴擦边不算撞
const HIT_LEFT = 10;
const HIT_RIGHT = 14;
const HIT_TOP = 8;
const HIT_BOTTOM = 9;
const BEST_STORAGE_KEY = "maibot-flappy-best";

interface Pipe {
  x: number;
  gap: number;
  scored: boolean;
}

interface FlappyState {
  mode: FlappyMode;
  birdY: number;
  velocity: number;
  pipes: Pipe[];
  score: number;
  best: number;
  newBest: boolean;
  groundOffset: number;
}

function readBest(): number {
  try {
    return Number(window.localStorage.getItem(BEST_STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function saveBest(best: number): void {
  try {
    window.localStorage.setItem(BEST_STORAGE_KEY, String(best));
  } catch {
    // 存不了就只记在这一次打开里
  }
}

function freshRound(mode: FlappyMode, best: number): FlappyState {
  return {
    mode,
    birdY: BIRD_START_Y,
    velocity: 0,
    pipes: [],
    score: 0,
    best,
    newBest: false,
    groundOffset: 0,
  };
}

function randomGap(): number {
  return 95 + Math.round(Math.random() * 60);
}

// 按 60 帧的步长推进；高刷新率屏幕上按实际耗时折算，速度不会变快
function step(state: FlappyState, frames: number): FlappyState {
  const velocity = Math.min(state.velocity + GRAVITY * frames, MAX_FALL);
  const birdY = state.birdY + velocity * frames;
  let score = state.score;
  let pipes = state.pipes.map((pipe) => ({ ...pipe, x: pipe.x - PIPE_SPEED * frames }));
  for (const pipe of pipes) {
    if (!pipe.scored && pipe.x + PIPE_WIDTH < BIRD_X) {
      pipe.scored = true;
      score += 1;
    }
  }
  pipes = pipes.filter((pipe) => pipe.x > SCREEN_LEFT - PIPE_WIDTH - 10);
  const last = pipes.at(-1);
  if (!last || last.x < PIPE_SPAWN_AFTER) {
    pipes.push({ x: PIPE_SPAWN_X, gap: randomGap(), scored: false });
  }

  let hit = birdY + HIT_BOTTOM + 3 >= GROUND_Y || birdY - HIT_TOP - 2 <= SCREEN_TOP;
  for (const pipe of pipes) {
    const overlapsX = BIRD_X + HIT_RIGHT > pipe.x && BIRD_X - HIT_LEFT < pipe.x + PIPE_WIDTH;
    const outsideGap = birdY - HIT_TOP < pipe.gap - PIPE_GAP / 2 || birdY + HIT_BOTTOM > pipe.gap + PIPE_GAP / 2;
    if (overlapsX && outsideGap) hit = true;
  }

  if (hit) {
    const newBest = score > state.best;
    if (newBest) saveBest(score);
    return {
      ...state,
      mode: "over",
      birdY: Math.min(birdY, GROUND_Y - 14),
      velocity: 0,
      pipes,
      score,
      best: Math.max(state.best, score),
      newBest,
    };
  }

  return {
    ...state,
    birdY,
    velocity,
    pipes,
    score,
    groundOffset: (state.groundOffset + PIPE_SPEED * frames) % 20,
  };
}

export function useFlappyGame(enabled: boolean): {
  state: FlappyState;
  press: () => void;
  exit: () => void;
} {
  const [state, setState] = useState<FlappyState>(() => freshRound("off", readBest()));
  const frameRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  const stopLoop = useCallback(() => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
    lastTimeRef.current = null;
  }, []);

  const loop = useCallback((time: number) => {
    const last = lastTimeRef.current ?? time;
    lastTimeRef.current = time;
    // 切走窗口再回来时不会一下子跳很多帧
    const frames = Math.min((time - last) / (1000 / 60), 3);
    setState((current) => (current.mode === "play" ? step(current, frames) : current));
    // 撞到之后由下面的 effect 停掉循环
    frameRef.current = window.requestAnimationFrame(loop);
  }, []);

  const press = useCallback(() => {
    setState((current) => {
      if (current.mode === "off" || current.mode === "over") {
        return freshRound("ready", current.best);
      }
      if (current.mode === "ready") {
        return {
          ...current,
          mode: "play",
          velocity: FLAP_VELOCITY,
          pipes: [{ x: PIPE_SPAWN_X + 20, gap: 125, scored: false }],
        };
      }
      return { ...current, velocity: FLAP_VELOCITY };
    });
  }, []);

  const exit = useCallback(() => {
    stopLoop();
    setState((current) => freshRound("off", current.best));
  }, [stopLoop]);

  // 进入 play 时启动动画循环；结束或退出时停下
  useEffect(() => {
    if (state.mode === "play" && frameRef.current === null) {
      lastTimeRef.current = null;
      frameRef.current = window.requestAnimationFrame(loop);
    }
    if (state.mode !== "play") stopLoop();
  }, [loop, state.mode, stopLoop]);

  // 麦麦开始启动、或者页面不再是待机时，直接收起游戏
  useEffect(() => {
    if (!enabled) exit();
  }, [enabled, exit]);

  useEffect(() => stopLoop, [stopLoop]);

  return { state, press, exit };
}

// 麦麦像素图，朝右。每格 2 个单位。
// K 深棕描边  O 橙背  W 白肚  E 眼睛高光  G 嫩绿  D 深绿
const SPRITE_BODY = [
  "..........GG..GG....",
  "...........GGGG.....",
  "............D.......",
  ".......KKKKKKKK.....",
  ".....KKOOOOOOOOKK...",
  "....KOOOOOOOOOOOOK..",
  "....KOOOOOOEKOOEKOK.",
  "....KOOOOOOKKOOKKOK.",
  "....KOOOOOOOOOKKKOK.",
  "....KOOOOOOWWWWKWWK.",
  "....KOOOWWWWWWWWWWK.",
  "....KWWWWWWWWWWWWWK.",
  ".....KKWWWWWWWWWKK..",
  ".......KKKKKKKKK....",
];
const SPRITE_TAIL_REST = ["", "", "", "", "", ".GG.", "GDGG", ".GGK", "GGGK", "GDGK", ".GG."];
const SPRITE_TAIL_FLAP = ["", "", "", ".GG.", "GDGG", ".GG.", "GGGK", "..GK", "...K"];
const SPRITE_COLORS: Record<string, string> = {
  K: "#44290f",
  O: "#ea8414",
  W: "#fffaf0",
  E: "#fffaf0",
  G: "#7fe03a",
  D: "#4fae1f",
};
const SPRITE_PIXEL = 2;
const SPRITE_OFFSET_X = -20;
const SPRITE_OFFSET_Y = -16;

interface PixelRun {
  x: number;
  y: number;
  width: number;
  fill: string;
}

// 同色相邻的格子合并成一条，少画一些矩形
function pixelRuns(rows: string[]): PixelRun[] {
  const runs: PixelRun[] = [];
  rows.forEach((row, rowIndex) => {
    let column = 0;
    while (column < row.length) {
      const fill = SPRITE_COLORS[row[column]];
      if (!fill) {
        column += 1;
        continue;
      }
      let end = column;
      while (end < row.length && row[end] === row[column]) end += 1;
      runs.push({
        x: SPRITE_OFFSET_X + column * SPRITE_PIXEL,
        y: SPRITE_OFFSET_Y + rowIndex * SPRITE_PIXEL,
        width: (end - column) * SPRITE_PIXEL,
        fill,
      });
      column = end;
    }
  });
  return runs;
}

const BODY_RUNS = pixelRuns(SPRITE_BODY);
const TAIL_REST_RUNS = pixelRuns(SPRITE_TAIL_REST);
const TAIL_FLAP_RUNS = pixelRuns(SPRITE_TAIL_FLAP);

function PixelRuns({ runs }: { runs: PixelRun[] }): React.JSX.Element {
  return (
    <>
      {runs.map((run) => (
        <rect fill={run.fill} height={SPRITE_PIXEL} key={`${run.x}-${run.y}`} width={run.width} x={run.x} y={run.y} />
      ))}
    </>
  );
}

const GROUND_STRIPES = Array.from({ length: 18 }, (_, index) => `M${70 + index * 20} 223h8`).join("");

export function FlappyScreen({ state, clipId }: { state: FlappyState; clipId: string }): React.JSX.Element {
  const flapping = state.mode === "play" && state.velocity < -1.5;
  // 位置取整、角度按 15° 一档，看起来更像像素游戏的精灵
  const tilt = Math.round(Math.max(-20, Math.min(45, state.velocity * 7)) / 15) * 15;

  return (
    <>
      <defs>
        <clipPath id={clipId}>
          <rect height={SCREEN_HEIGHT} width={SCREEN_WIDTH} x={SCREEN_LEFT} y={SCREEN_TOP} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`} shapeRendering="crispEdges">
        {state.pipes.map((pipe, index) => {
          const top = pipe.gap - PIPE_GAP / 2;
          const bottom = pipe.gap + PIPE_GAP / 2;
          return (
            <g key={index}>
              <rect fill="var(--mil-key)" height={top - 34} stroke="var(--mil-line)" strokeWidth="2" width={PIPE_WIDTH} x={pipe.x} y="34" />
              <rect fill="var(--mil-key)" height="10" stroke="var(--mil-line)" strokeWidth="2" width={PIPE_WIDTH + 8} x={pipe.x - 4} y={top - 10} />
              <rect fill="var(--mil-key)" height={GROUND_Y - bottom} stroke="var(--mil-line)" strokeWidth="2" width={PIPE_WIDTH} x={pipe.x} y={bottom} />
              <rect fill="var(--mil-key)" height="10" stroke="var(--mil-line)" strokeWidth="2" width={PIPE_WIDTH + 8} x={pipe.x - 4} y={bottom} />
            </g>
          );
        })}
        <rect fill="var(--mil-lo)" height="18" stroke="var(--mil-line)" strokeWidth="2" width="336" x="72" y={GROUND_Y} />
        <path d={GROUND_STRIPES} stroke="var(--mil-vent)" strokeWidth="4" transform={`translate(${-state.groundOffset} 0)`} />
        <g transform={`translate(${BIRD_X} ${Math.round(state.birdY)}) rotate(${tilt})`}>
          <PixelRuns runs={flapping ? TAIL_FLAP_RUNS : TAIL_REST_RUNS} />
          <PixelRuns runs={BODY_RUNS} />
        </g>
        {state.mode !== "ready" ? (
          <>
            <text className="mil-launch-screen-text" fill="var(--mil-crt-ink)" fontSize="32" textAnchor="middle" x="240" y="72">
              {state.score}
            </text>
            <text className="mil-launch-screen-text" fill="var(--mil-crt-dim)" fontSize="14" letterSpacing="1" x="88" y="56">
              SCORE {state.score}
            </text>
            <text className="mil-launch-screen-text" fill="var(--mil-crt-amber)" fontSize="14" letterSpacing="1" textAnchor="end" x="392" y="56">
              BEST {state.best}
            </text>
          </>
        ) : null}
      </g>
      {state.mode === "ready" ? (
        <>
          <text className="mil-launch-screen-text" fill="var(--mil-crt-amber)" fontSize="26" letterSpacing="5" textAnchor="middle" x="240" y="104">
            GET READY
          </text>
          <text className="mil-launch-screen-text" fill="var(--mil-crt-dim)" fontSize="15" letterSpacing="2" textAnchor="middle" x="240" y="170">
            CLICK / SPACE
          </text>
          <text className="mil-launch-screen-text" fill="var(--mil-crt-amber)" fontSize="14" letterSpacing="1" textAnchor="end" x="392" y="56">
            BEST {state.best}
          </text>
        </>
      ) : null}
      {state.mode === "over" ? (
        <>
          <rect fill="var(--mil-crt)" height="132" stroke="var(--mil-crt-amber)" strokeWidth="3" width="220" x="130" y="66" />
          <text className="mil-launch-screen-text" fill="var(--mil-crt-amber)" fontSize="24" letterSpacing="4" textAnchor="middle" x="240" y="94">
            GAME OVER
          </text>
          <path d="M148 104h184" stroke="var(--mil-crt-dim)" strokeDasharray="4 4" strokeWidth="2" />
          <text className="mil-launch-game-label" fill="var(--mil-crt-dim)" fontSize="16" x="152" y="130">本次</text>
          <text className="mil-launch-screen-text" fill="var(--mil-crt-ink)" fontSize="26" textAnchor="end" x="328" y="132">
            {state.score}
          </text>
          <text className="mil-launch-game-label" fill="var(--mil-crt-dim)" fontSize="16" x="152" y="158">最高</text>
          <text className="mil-launch-screen-text" fill="var(--mil-crt-amber)" fontSize="26" textAnchor="end" x="328" y="160">
            {state.best}
          </text>
          {state.newBest ? (
            <g className="mil-launch-blink">
              <rect fill="var(--mil-crt-amber)" height="18" width="80" x="200" y="170" />
              <text className="mil-launch-screen-text" fill="var(--mil-crt)" fontSize="13" letterSpacing="1" textAnchor="middle" x="240" y="184">
                NEW BEST
              </text>
            </g>
          ) : (
            <text className="mil-launch-screen-text" fill="var(--mil-crt-dim)" fontSize="13" letterSpacing="1" textAnchor="middle" x="240" y="186">
              CLICK TO RETRY
            </text>
          )}
        </>
      ) : null}
    </>
  );
}
