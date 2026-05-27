import { screen, type BrowserWindow, type Rectangle } from "electron";

const MAXIMIZED_BOUNDS_TOLERANCE = 2;

function nearlyEqual(a: number, b: number): boolean {
  return Math.abs(a - b) <= MAXIMIZED_BOUNDS_TOLERANCE;
}

export function getWindowWorkAreaBounds(window: BrowserWindow): Rectangle {
  const workArea = screen.getDisplayMatching(window.getBounds()).workArea;
  return {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
  };
}

export function isWindowVisuallyMaximized(window: BrowserWindow): boolean {
  if (window.isDestroyed() || window.isFullScreen()) {
    return false;
  }
  if (window.isMaximized()) {
    return true;
  }

  const bounds = window.getBounds();
  const workArea = getWindowWorkAreaBounds(window);
  return (
    nearlyEqual(bounds.x, workArea.x) &&
    nearlyEqual(bounds.y, workArea.y) &&
    nearlyEqual(bounds.width, workArea.width) &&
    nearlyEqual(bounds.height, workArea.height)
  );
}
