// Cloudhaven Air Rally — keyboard and mouse input tracking.

const TRACKED = new Set([
  'KeyW', 'KeyS', 'KeyA', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'KeyB', 'KeyC', 'KeyP', 'KeyR', 'KeyM',
  'Enter', 'Space',
]);

// Keys whose default browser action (page scrolling) must be suppressed.
const PREVENT_DEFAULT = new Set([
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space',
]);

export class Input {
  constructor() {
    this.keys = new Set();      // currently held keys
    this.mouseDX = 0;           // accumulated mouse movement since last endFrame()
    this.mouseDY = 0;
    this.canvas = null;
    this._presses = new Set();  // fresh presses not yet consumed this frame

    this._onKeyDown = (e) => {
      if (!TRACKED.has(e.code)) return;
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
      // Auto-repeat keydowns must not register as new physical presses.
      if (!e.repeat && !this.keys.has(e.code)) this._presses.add(e.code);
      this.keys.add(e.code);
    };

    this._onKeyUp = (e) => {
      if (!TRACKED.has(e.code)) return;
      if (PREVENT_DEFAULT.has(e.code)) e.preventDefault();
      this.keys.delete(e.code);
    };

    this._onMouseMove = (e) => {
      this.mouseDX += e.movementX || 0;
      this.mouseDY += e.movementY || 0;
    };

    // Releasing focus would otherwise leave keys stuck "held".
    this._onBlur = () => {
      this.keys.clear();
      this._presses.clear();
    };
  }

  attach(canvas) {
    if (this.canvas) this.detach();
    this.canvas = canvas;
    window.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('keyup', this._onKeyUp);
    window.addEventListener('blur', this._onBlur);
    canvas.addEventListener('mousemove', this._onMouseMove);
  }

  detach() {
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    window.removeEventListener('blur', this._onBlur);
    if (this.canvas) this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas = null;
    this.keys.clear();
    this._presses.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
  }

  /** True while the key is held down. */
  pressed(code) {
    return this.keys.has(code);
  }

  /** True exactly once per physical press of the key (for toggles). */
  consumePress(code) {
    if (!this._presses.has(code)) return false;
    this._presses.delete(code);
    return true;
  }

  /** Call at the end of each frame: resets mouse deltas and drops unconsumed presses. */
  endFrame() {
    this.mouseDX = 0;
    this.mouseDY = 0;
    this._presses.clear();
  }
}
