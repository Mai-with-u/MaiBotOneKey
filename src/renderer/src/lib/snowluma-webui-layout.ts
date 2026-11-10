// Keep consent readable in short embedded windows without shrinking its text.
// :has scopes the override to onboarding; normal SnowLuma pages keep their layout.
export const SNOWLUMA_WEBUI_LAYOUT_CSS = `
.h-svh:has([aria-label$="正文"]) {
  min-height: max(100svh, 56rem) !important;
}
[aria-label$="正文"] {
  min-height: 15rem !important;
}
`;
