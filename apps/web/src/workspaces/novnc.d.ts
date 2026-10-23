// noVNC ships no types; this is the part of its client (core/rfb.js) we use.
declare module '@novnc/novnc' {
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string }; wsProtocols?: string[] })
    scaleViewport: boolean
    resizeSession: boolean
    focusOnClick: boolean
    // CSS for the area around the remote screen.
    background: string
    disconnect(): void
    sendCtrlAltDel(): void
    focus(): void
  }
}
