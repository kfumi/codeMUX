// 页面级布局使用同一条分割线，避免侧栏和工作区面板出现不同灰度。
// 分割线必须完全不透明：半透明墨水在圆角转弯处会被抗锯齿摊开，
// 导致弯曲段看起来比直线段更粗更淡。
export const LAYOUT_DIVIDER_CLASS = 'border-[hsl(var(--layout-divider))]';
