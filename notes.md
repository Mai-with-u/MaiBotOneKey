# Notes

## 设置页滚动条圆角

- 在 `future-retro` 外观下，设置页滚动条圆角不是单纯由 `::-webkit-scrollbar-thumb` 控制。
- 关键原因是主题作用域里设置了标准滚动条属性 `scrollbar-color` / `scrollbar-width`，Chromium/Electron 会优先走标准滚动条绘制路径，导致 WebKit 伪元素里的 `border-radius: 0` 看起来不生效。
- 处理方式：在设置页作用域 `.settings-scroll-scope` 内先将 `scrollbar-color` 和 `scrollbar-width` 重置为 `auto !important`，再用 `::-webkit-scrollbar-thumb` 设置 `border-radius: 0 !important` 和 `border: 0 !important`。
