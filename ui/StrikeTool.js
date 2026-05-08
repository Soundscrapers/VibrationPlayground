/**
 * StrikeTool.js
 *
 * Responsibility:
 * - On pointer down: record the strike position (physical x) and impulse
 *   velocity (derived from how far above/below yCenter the click lands).
 * - On pointer up: inject that velocity impulse into a narrow band of
 *   spatial points centered on the strike position.
 * - Store a pendingStrike event for sketch.js to forward to the sound observer.
 *
 * NOT allowed to:
 * - Draw anything.
 * - Advance time.
 * - Read or modify string parameters.
 *
 * -------------------------------------------------------------------
 * Physics model: velocity impulse
 *
 * A hammer strike injects transverse velocity into a spatial band of width
 * hammerWidth (fraction of L). All spatial points within that band receive
 * an equal velocity increment of strikeV (m/s), added to whatever velocity
 * the string currently has at those points.
 *
 * This approximates a short-duration contact force:
 *   impulse = integral F dt = m * delta_v
 * The impulse is spread across the hammer width, so a narrow hammer
 * concentrates energy in high-frequency modes.
 *
 * Strike velocity sign convention:
 *   v0 > 0  --> string moves upward (positive transverse direction)
 *   v0 < 0  --> string moves downward
 *
 * v0 is derived from mouse position at pointer-down time:
 *   v0 = (yCenter - screenY) / yScale
 * Clicking above yCenter gives upward velocity; below gives downward.
 * -------------------------------------------------------------------
 */

class StrikeTool {

  /**
   * constructor
   *
   * @param {Object} opts
   * @param {number} opts.hammerWidth -- hammer contact width as fraction of L.
   *                                     Default 0.05 (5% of string length).
   *                                     Narrower --> more high-frequency content.
   */
  constructor(opts = {}) {

    // Hammer contact width as a fraction of string length L.
    // Physical width = hammerWidth * L (meters).
    this.hammerWidth = opts.hammerWidth || 0.05;

    // True while the user is holding the pointer down after a valid strike start.
    // False after pointerUp or if pointerDown did not land on the string.
    this.isStriking = false;

    // Physical x position of this strike along the string (meters).
    // Set in pointerDown, read in pointerUp.
    this.strikeX = 0;

    // Impulse velocity to inject (m/s). Positive = upward.
    // Set in pointerDown based on mouse y offset from yCenter.
    this.strikeV = 0;

    // Pending event for sketch.js to consume and forward to sound observer.
    // Set in pointerUp, cleared by consumeStrikeEvent().
    // null = no pending event.
    this.pendingStrike = null;
  }

  // ------------------------------------------------------------------
  // pointerDown -- record strike position and velocity.
  //
  // Converts screen coordinates to physical string position (meters) and
  // computes the impulse velocity from the pointer's distance above yCenter.
  //
  // @param {number} screenX   -- mouse x (canvas pixels)
  // @param {number} screenY   -- mouse y (canvas pixels)
  // @param {Object} stringDef -- StringDefinition (for L)
  // @param {Object} screenGeom -- { xLeft, Lx, yCenter, yScale }
  // @returns {boolean} -- true if the click is within the string's x-span
  // ------------------------------------------------------------------
  pointerDown(screenX, screenY, stringDef, screenGeom) {

    // Convert pixel x to physical position along the string.
    // Linear map: screenX=xLeft --> ksi=0, screenX=xRight --> ksi=L.
    const ksi = (screenX - screenGeom.xLeft) / screenGeom.Lx * stringDef.L;

    // Reject clicks outside the string span (x < 0 or x > L).
    if (ksi < 0 || ksi > stringDef.L) {
      this.isStriking = false;
      return false;
    }

    // Impulse velocity: proportional to how far the click is from yCenter.
    //
    // Sign convention: clicking BELOW center (screenY > yCenter) gives a
    // positive (upward) velocity -- the string moves away from the hammer,
    // which is physically correct for a struck string.
    //
    // Base formula: v0 = (screenY - yCenter) / yScale
    // (screenY increases downward in canvas coords, so below-center clicks
    //  give positive v0, mapping to upward displacement via sy = yCenter - disp*yScale)
    //
    // velocityGain: optional multiplier in screenGeom (default 1.0).
    // String world sets this to ~20 so that a 100px click gives ~10 m/s,
    // producing a visible wave (amplitude ~ v0 * hammerWidth / (2c)).
    const gain = screenGeom.velocityGain || 1.0;
    const rawV = (screenY - screenGeom.yCenter) / screenGeom.yScale * gain;

    // Minimum-force floor: clicking very close to the equilibrium line still
    // produces a gentle tap rather than near-silence.
    // V_MIN applies only when the click has a non-zero direction (rawV != 0);
    // a click exactly on yCenter (rawV == 0) stays silent because there is
    // no directional information to determine which way to push the string.
    //
    //   rawV = 0      --> v0 = 0       (exactly on equilibrium, no direction)
    //   |rawV| < V_MIN --> v0 = +/-V_MIN (close click floored to minimum tap)
    //   |rawV| >= V_MIN --> v0 = rawV    (normal distance-proportional scaling)
    const V_MIN = 1.5;   // m/s: minimum impulse for any directional click
    const v0    = rawV === 0 ? 0 : Math.sign(rawV) * Math.max(Math.abs(rawV), V_MIN);

    // Store for use in pointerUp.
    this.strikeX    = ksi;
    this.strikeV    = v0;
    this.isStriking = true;

    return true;
  }

  // ------------------------------------------------------------------
  // pointerUp -- inject the velocity impulse into ModalState.
  //
  // Reads current displacements and velocities, adds strikeV to every
  // spatial point within half a hammer-width of strikeX, then writes
  // the modified state back via setPhysicalState().
  //
  // Also stores a pendingStrike event for sketch.js to pick up.
  //
  // @param {ModalState}       modalState -- current physics state (modified)
  // @param {StringDefinition} stringDef  -- for Nx, spatialX, L
  // ------------------------------------------------------------------
  pointerUp(modalState, stringDef) {

    // Nothing to do if pointerDown didn't land on the string.
    if (!this.isStriking) return;

    // Read current physical state (both returned arrays are fresh copies).
    const x = modalState.getDisplacements();   // length Nx
    const v = modalState.getVelocities();       // length Nx

    // Hammer half-width in meters.
    // Points within this distance of strikeX receive the impulse.
    const hw = (this.hammerWidth * stringDef.L) / 2;

    // Add velocity impulse at each spatial point within the hammer contact zone.
    // stringDef.spatialX[i] is the physical x-coordinate of interior point i (m).
    // freeToGlobal[i] = i for strings (identity mapping), so v[i] indexes correctly.
    for (let i = 0; i < stringDef.Nx; i++) {
      if (Math.abs(stringDef.spatialX[i] - this.strikeX) < hw) {
        v[i] += this.strikeV;   // add impulse; existing velocity is preserved
      }
    }

    // Write modified state back. setPhysicalState() projects x and v into the
    // modal basis: q = Phi^T * M * x, qdot = Phi^T * M * v.
    modalState.setPhysicalState(x, v);

    // Store event for sketch.js to forward to the sound observer.
    // ksi = strike position (m), v0 = impulse velocity (m/s).
    this.pendingStrike = { ksi: this.strikeX, v0: this.strikeV };

    // Reset for next interaction.
    this.isStriking = false;
  }

  // ------------------------------------------------------------------
  // cancel -- abort an in-progress strike without firing a sound event.
  //
  // Called by StringInteractionController.pointerMove() when the gesture
  // transitions from a quick-click to a pluck drag (hold > 200ms).
  // Clears isStriking so pointerUp() becomes a no-op for this gesture.
  // ------------------------------------------------------------------
  cancel() {
    this.isStriking    = false;
    this.pendingStrike = null;
  }

  // ------------------------------------------------------------------
  // consumeStrikeEvent -- retrieve and clear the pending strike event.
  //
  // Called by sketch.js once per frame (or after pointerUp).
  // Returns the event object { ksi, v0 } if one is pending, else null.
  // Clears the pending event so it is only consumed once.
  //
  // @returns {{ ksi: number, v0: number } | null}
  // ------------------------------------------------------------------
  consumeStrikeEvent() {
    const e = this.pendingStrike;
    this.pendingStrike = null;
    return e;
  }
}
