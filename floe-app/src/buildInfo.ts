import type { ClientBuildIdentity } from "./features/feedback/problemReport.ts";

export function getClientBuildIdentity(): ClientBuildIdentity {
  return {
    component: "floe-app",
    release_version: typeof __FLOE_RELEASE_VERSION__ === "undefined" ? null : __FLOE_RELEASE_VERSION__,
    build_sha: typeof __FLOE_BUILD_SHA__ === "undefined" ? null : __FLOE_BUILD_SHA__,
  };
}
