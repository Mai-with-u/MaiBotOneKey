# 外观架构维护说明

这个文件记录桌面端三套外观的分层方式，方便以后调整样式时不把三种风格搅在一起。

## 核心原则

外观模式不是三套独立应用，而是：

- 一套外观状态：`src/renderer/src/lib/use-appearance.ts`
- 两类结构分支：现代结构、未来复古结构
- 三套视觉结果：未来复古、现代、未来

`modern` 是默认地基。基础 UI 组件应保持现代风格，不要直接写成复古样式。

`future` 复用现代结构，只额外开启液态玻璃层和透明 token。

`future-retro` 使用复古结构分支，并通过 `.retro-*` 类和根节点 data attribute 追加纸质、硬边框、切角和复古图标表现。

## 架构图

```mermaid
flowchart TD
  Settings[设置页：外观选项] --> Appearance[useAppearance]
  Appearance --> Storage[localStorage<br/>maibot-appearance]
  Appearance --> Apply[applyAppearance]

  Apply --> RootAttrs[document.documentElement<br/>data-appearance-mode<br/>data-accent / data-font / data-scale<br/>data-retro-paper-texture]
  Apply --> GlassClass{mode === future?}
  GlassClass -->|是| LiquidClass[添加 .liquid-glass]
  GlassClass -->|否| NoGlass[移除 .liquid-glass]

  Appearance --> DesktopShell[DesktopShell]
  Appearance --> HomePanel[HomePanel]

  DesktopShell --> ChromeBranch{appearance.mode}
  ChromeBranch -->|future-retro| RetroChrome[复古顶部栏<br/>retro-tabs / retro-top-action<br/>retro-shell]
  ChromeBranch -->|modern| ModernChrome[旧版现代顶部栏<br/>紧凑 Tabs / 启动下拉 / 停止按钮]
  ChromeBranch -->|future| FutureChrome[现代顶部栏结构<br/>+ LiquidGlassLayer]

  HomePanel --> HomeBranch{appearance.mode}
  HomeBranch -->|future-retro| RetroHome[复古首页结构<br/>retro-panel / retro-control<br/>宽仪表盘布局]
  HomeBranch -->|modern| ModernHome[旧版现代首页结构<br/>紧凑卡片 / 右侧 320px]
  HomeBranch -->|future| FutureHome[现代首页结构<br/>+ 玻璃 token]

  RootAttrs --> CSS[globals.css]
  LiquidClass --> CSS
  NoGlass --> CSS

  CSS --> BaseTokens[基础 token<br/>现代默认]
  CSS --> RetroScope[:root[data-appearance-mode='future-retro']<br/>复古 token 与 .retro-* 覆盖]
  CSS --> GlassScope[:root.liquid-glass<br/>玻璃透明度 / blur / 背景覆盖]

  BaseTokens --> UIBase[基础 UI 组件<br/>Button / Tabs / Card / Input / Badge / Dialog]
  RetroScope --> RetroChrome
  RetroScope --> RetroHome
  GlassScope --> FutureChrome
  GlassScope --> FutureHome
```

## 状态入口

外观状态在 `use-appearance.ts` 中维护：

```ts
export type AppearanceMode = "future-retro" | "modern" | "future";
```

`applyAppearance` 会把配置同步到 `document.documentElement`：

- `data-appearance-mode`
- `data-retro-paper-texture`
- `data-accent`
- `data-font`
- `data-scale`
- `.liquid-glass`

旧的 `liquidGlass: true` 会迁移为 `mode: "future"`。

## 结构分支

结构差异较大的地方用 React 条件分支，不强行靠 CSS 扭出来。

主要位置：

- `src/renderer/src/components/app/DesktopShell.tsx`
  - `useRetroChrome = appearance.mode === "future-retro"`
  - 控制顶部 tab、右上操作按钮、外壳 `.retro-shell`
- `src/renderer/src/components/app/HomePanel.tsx`
  - `useRetroHome = appearance.mode === "future-retro"`
  - 控制首页布局、卡片结构、快捷操作卡片、弹窗内局部控件

现代和未来模式应尽量走 `2c788736c75aee80379efe6a9ac2d253d972177c` 前的现代结构。

## 样式分层

基础组件保持现代默认：

- `src/renderer/src/components/ui/button.tsx`
- `src/renderer/src/components/ui/tabs.tsx`
- `src/renderer/src/components/ui/card.tsx`
- `src/renderer/src/components/ui/input.tsx`
- `src/renderer/src/components/ui/badge.tsx`
- `src/renderer/src/components/ui/dialog.tsx`

复古样式集中在 `src/renderer/src/styles/globals.css`：

- `.retro-shell`
- `.retro-panel`
- `.retro-control`
- `.retro-title`
- `.retro-value`
- `.retro-tabs`
- `.retro-top-action`

复古覆盖尽量写成：

```css
:root[data-appearance-mode="future-retro"] .retro-panel {
  /* retro only */
}
```

这样现代模式不会被复古类名的默认样式污染。

## 三种模式的职责

### 未来复古

- 使用 `.retro-shell`
- 首页走复古卡片和更宽的仪表盘布局
- 顶部 tab 使用硬边分割和选中镂空/高对比图标
- 可配置纸张纹理、窗口圆角、界面密度

### 现代

- 使用基础组件默认样式
- 首页走旧版紧凑布局
- 顶部 tab 和右上按钮保持旧版紧凑交互
- 可配置主题色、字体、界面密度、窗口圆角

### 未来

- 结构继承现代
- 开启 `.liquid-glass` 和 `LiquidGlassLayer`
- 可配置玻璃透度、主题色、界面密度、窗口圆角

## 维护规则

- 改基础组件时，先确认现代模式是否仍像旧版。
- 复古专属视觉不要直接写进基础组件，放到 `.retro-*` 或 `data-appearance-mode="future-retro"` 作用域。
- 如果一个差异影响 DOM 结构、尺寸、按钮数量或布局轨道，优先在 React 里用模式分支。
- 如果只是颜色、纹理、边框、字体、图标 stroke，优先用 CSS token 或复古作用域。
- 新增外观配置项时，先扩展 `AppearancePreference`，再在设置页按模式展示对应配置。
- `future` 不要复制复古结构；它应该是现代结构上的玻璃视觉层。

## 验证

涉及外观架构调整后至少运行：

```bash
bun run typecheck
bun run build
```

视觉改动建议手动切换三种模式，重点看：

- 顶部 tab 和右上操作按钮
- 首页主卡片和右侧统计/快捷操作
- 设置弹窗是否正常居中显示
- 未来模式下玻璃层是否仍透明且可读
