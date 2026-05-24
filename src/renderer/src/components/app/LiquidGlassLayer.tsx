import { useId } from "react";

interface LiquidGlassLayerProps {
  dark: boolean;
  enabled: boolean;
}

export function LiquidGlassLayer({
  dark,
  enabled,
}: LiquidGlassLayerProps): React.JSX.Element {
  const filterId = `liquid-glass-${useId().replace(/:/gu, "")}`;
  const tint = dark
    ? "rgb(18 20 24 / var(--liquid-glass-layer-alpha, 0.24))"
    : "rgb(255 255 255 / var(--liquid-glass-layer-alpha, 0.28))";
  const frost = dark
    ? "rgb(12 14 18 / var(--liquid-glass-dark-frost-alpha, 0.18))"
    : "rgb(255 255 255 / var(--liquid-glass-frost-alpha, 0.22))";
  const glow = dark
    ? "linear-gradient(135deg, rgb(255 255 255 / 0.12), transparent 32%, rgb(120 150 255 / 0.08) 68%, transparent)"
    : "linear-gradient(135deg, rgb(255 255 255 / 0.46), transparent 34%, rgb(255 122 24 / 0.07) 70%, transparent)";

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden transition-opacity duration-200"
      style={{
        borderRadius: "inherit",
        opacity: enabled ? "var(--liquid-glass-compositor-opacity, 1)" : 0,
      }}
    >
      <div
        className="absolute inset-0"
        style={{
          WebkitBackdropFilter: "blur(var(--liquid-glass-window-frost, 14px)) saturate(var(--liquid-glass-saturate, 1.45))",
          backdropFilter: "blur(var(--liquid-glass-window-frost, 14px)) saturate(var(--liquid-glass-saturate, 1.45))",
          background: frost,
          borderRadius: "inherit",
          transform: "translateZ(0)",
        }}
      />

      <svg className="absolute size-0" focusable="false">
        <defs>
          <filter
            colorInterpolationFilters="sRGB"
            height="112%"
            id={filterId}
            width="112%"
            x="-6%"
            y="-6%"
          >
            <feTurbulence
              baseFrequency="0.007 0.012"
              numOctaves="2"
              result="noise"
              seed={dark ? 11 : 7}
              type="fractalNoise"
            />
            <feGaussianBlur in="noise" result="soft-noise" stdDeviation="1.2" />
            <feDisplacementMap
              in="SourceGraphic"
              in2="soft-noise"
              result="refracted"
              scale="10"
              xChannelSelector="R"
              yChannelSelector="G"
            />
            <feColorMatrix
              in="refracted"
              result="polished"
              type="matrix"
              values="1.04 0 0 0 0
                      0 1.04 0 0 0
                      0 0 1.06 0 0
                      0 0 0 1 0"
            />
            <feComposite in="polished" in2="SourceGraphic" operator="over" />
          </filter>
        </defs>
      </svg>

      <div
        className="absolute inset-0"
        style={{
          WebkitBackdropFilter: "blur(var(--liquid-glass-blur, 28px)) saturate(var(--liquid-glass-saturate, 1.45))",
          backdropFilter: "blur(var(--liquid-glass-blur, 28px)) saturate(var(--liquid-glass-saturate, 1.45))",
          background: tint,
          borderRadius: "inherit",
          filter: `url(#${filterId})`,
          transform: "translateZ(0)",
          willChange: "filter, backdrop-filter",
        }}
      />

      <div
        className="absolute inset-0"
        style={{
          background: glow,
          borderRadius: "inherit",
          boxShadow:
            "inset 0 1px 1px rgb(255 255 255 / 0.42), inset 0 -1px 1px rgb(0 0 0 / 0.08)",
          opacity: dark ? 0.52 : 0.58,
        }}
      />
    </div>
  );
}
