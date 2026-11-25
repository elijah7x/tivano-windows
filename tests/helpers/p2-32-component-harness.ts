// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-25.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app
// Test-only bundle entry exposing the renderer components and store seams
// exercised by the P2-32 shallow-component tests.

export { ChatView } from "../../src/renderer/components/ChatView";
export { HelperPanel } from "../../src/renderer/components/HelperPanel";
export { HydraPanel } from "../../src/renderer/components/HydraPanel";
export { clientStore } from "../../src/renderer/client";
export { emitMemoryPressure } from "../../src/renderer/appActivity";
export {
  MD_COORD_CACHE_MAX,
  clearMdCoordCacheForMemoryPressure,
  mdCoordMapFor,
} from "../../src/renderer/markdownCoordinatorCache";
export { mdCoordEntry } from "../../src/renderer/markdown";
