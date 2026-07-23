import type { RendererBridge } from '../shared/ipc.js';

declare global {
  interface Window {
    fm: RendererBridge;
  }
}

/** preload が露出する型付き IPC ブリッジ。 */
export const fm: RendererBridge = window.fm;
