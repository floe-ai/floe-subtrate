// Pure helpers for FloeWeb channel auto-scroll behavior.
//
// Keep these helpers free of React and DOM writes so the "stay put unless pinned
// to bottom" policy can be covered by fast unit tests.

export const CHANNEL_AUTO_SCROLL_THRESHOLD_PX = 24;

export type ScrollContainerMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

export function isScrollContainerNearBottom(
  metrics: ScrollContainerMetrics,
  thresholdPx = CHANNEL_AUTO_SCROLL_THRESHOLD_PX
): boolean {
  const distanceFromBottom = metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  return distanceFromBottom <= thresholdPx;
}
