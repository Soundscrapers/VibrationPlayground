/**
 * MassLayout.js
 *
 * Single source of truth for where every mass appears on screen.
 * Physics owns the mass data. MassLayout owns the visual geometry.
 *
 * -----------------------------------------------------------------------
 * Geometry: dual large-radius arcs, no center mass
 * -----------------------------------------------------------------------
 *
 * All masses are arcs -- there is no special "center mass" vertical line.
 *
 * The innermost pair of arcs sit just left and right of canvas center,
 * separated by one radiusGap:
 *   innermost right equilibrium: canvasMidX + radiusGap/2
 *   innermost left  equilibrium: canvasMidX - radiusGap/2
 *
 * All arcs start with a very large radius (INNER_RADIUS = 2 * canvasWidth)
 * so they look nearly straight near center. Each step outward the radius
 * decreases by RADIUS_DECREMENT pixels, making outer arcs progressively
 * more curved.
 *
 *   INNER_RADIUS = 2 * canvasWidth  (tunable constant below)
 *   step         = dims.radiusGap  (inherited from sketch.js dims)
 *
 * Since all right arcs share one center (rightCenter) and all left arcs
 * share one center (leftCenter), the equilibrium x of arc k from center is:
 *
 *   Right arc k:  eq_x = rightCenter.x - radius_k
 *                       = canvasMidX + radiusGap/2 + k * RADIUS_DECREMENT
 *
 *   Left arc k:   eq_x = leftCenter.x + radius_k
 *                       = canvasMidX - radiusGap/2 - k * RADIUS_DECREMENT
 *
 * Centers are placed so that the innermost arc equilibrium lands correctly:
 *   rightCenter.x = canvasMidX + radiusGap/2 + INNER_RADIUS
 *   leftCenter.x  = canvasMidX - radiusGap/2 - INNER_RADIUS
 *
 * -----------------------------------------------------------------------
 * Visual order and physics index assignment
 * -----------------------------------------------------------------------
 *
 * For N masses:
 *   nRight = ceil(N / 2)  -- right-side arcs (physics indices 0 .. nRight-1)
 *   nLeft  = floor(N / 2) -- left-side arcs (physics indices nRight .. N-1)
 *
 *   Physics index 0 is always the innermost right arc.
 *   Physics index nRight is always the innermost left arc.
 *
 * visualOrder (left-to-right on screen):
 *   [outermost-left ... innermost-left, innermost-right ... outermost-right]
 *   = [N-1, ..., nRight, 0, ..., nRight-1]
 *
 * Example, N = 4:  nRight = 2, nLeft = 2
 *   visualOrder = [3, 2, 0, 1]
 *                  left   right
 *
 * Example, N = 6:  nRight = 3, nLeft = 3
 *   visualOrder = [5, 4, 3, 0, 1, 2]
 *                  left      right
 *
 * -----------------------------------------------------------------------
 * Entry schema (returned by get())
 * -----------------------------------------------------------------------
 *
 *   side        -- 'left' | 'right'
 *   visualIndex -- index in visualOrder (0 = leftmost on screen)
 *   centerX     -- x of the arc's circle center
 *   centerY     -- y of the arc's circle center
 *   radius      -- arc radius in pixels
 */

// Arc radius schedule -- in reference pixels (multiply by dims.s for actual pixels).
// s=1 corresponds to a 1000px-wide reference canvas.
// Innermost arc is nearly flat; radius decreases linearly outward.
// Adjust these two numbers to tune the curvature spread.
const INNER_RADIUS_S = 3200;  // innermost arc radius (very flat, near-vertical line)
const OUTER_RADIUS_S =  800;  // outermost arc radius (noticeably curved)

class MassLayout {

  // --------------------------------------------------
  // constructor(dims)
  //
  //   dims: object from sketch.js setup().
  //   Required fields: radiusGap, canvasWidth, canvasHeight.
  // --------------------------------------------------
  constructor(dims) {
    this.dims = dims;

    // Canvas midpoint -- used in _rebuildEntries() to place equilibria.
    this.canvasMidX = dims.canvasWidth / 2;

    // physics indices ordered left-to-right on screen
    this.visualOrder = [];

    // per-mass geometry, keyed by physics index
    this.entries = {};

    // stored after rebuild() so _rebuildEntries() knows the split point
    this._nLeft = 0;
  }

  // --------------------------------------------------
  // rebuild(mdof)
  //
  // Full reset. Computes visualOrder from scratch, then geometry.
  // Call on: preset load, reset, any full topology change.
  // --------------------------------------------------
  rebuild(mdof) {
    const N = mdof.size();

    // Split: right gets the larger half when N is odd
    const nRight = Math.ceil(N / 2);
    const nLeft  = N - nRight;
    this._nLeft  = nLeft;

    // Left group in visualOrder: outermost first
    //   Physics indices: nRight (innermost) ... N-1 (outermost)
    //   Visual order: N-1 (outermost) ... nRight (innermost)
    const leftGroup = [];
    for (let i = N - 1; i >= nRight; i--) {
      leftGroup.push(i);
    }

    // Right group in visualOrder: innermost first
    //   Physics indices: 0 (innermost) ... nRight-1 (outermost)
    const rightGroup = [];
    for (let i = 0; i < nRight; i++) {
      rightGroup.push(i);
    }

    // Assemble visual order: all left arcs then all right arcs
    this.visualOrder = [...leftGroup, ...rightGroup];

    this._rebuildEntries();
  }

  // --------------------------------------------------
  // _rebuildEntries()
  //
  // Derives this.entries from this.visualOrder and this._nLeft.
  // The first _nLeft entries are left-side arcs; the rest are right-side.
  //
  // Radius assignment:
  //   k = steps from the innermost arc of that side (k=0 innermost)
  //   radius_k = INNER_RADIUS * canvasWidth - k * RADIUS_DECREMENT
  //
  //   Left arcs:  visualOrder[0 .. nLeft-1], k = nLeft-1-vi (outermost vi=0 is k=nLeft-1)
  //   Right arcs: visualOrder[nLeft .. end], k = vi - nLeft  (innermost vi=nLeft is k=0)
  // --------------------------------------------------
  _rebuildEntries() {
    this.entries = {};
    const s      = this.dims.s;
    const rg     = this.dims.radiusGap;
    const ch     = this.dims.canvasHeight;
    const cap    = this.dims.maxPerSide;   // max masses per side (= maxMasses/2)
    const midX   = this.canvasMidX;
    const nLeft  = this._nLeft;

    // Radius endpoints in actual pixels (scaled by s).
    const rInner = INNER_RADIUS_S * s;
    const rOuter = OUTER_RADIUS_S * s;

    for (let vi = 0; vi < this.visualOrder.length; vi++) {
      const physIdx = this.visualOrder[vi];

      // k = steps outward from innermost (k=0 innermost, k=cap-1 outermost).
      // t = interpolation factor: 0 at innermost, 1 at outermost.
      // Using cap-1 as denominator keeps the schedule consistent regardless
      // of how many masses are currently present -- adding a mass reveals
      // the next pre-computed slot rather than rescaling everything.
      const k      = (vi < nLeft) ? (nLeft - 1 - vi) : (vi - nLeft);
      const t      = k / Math.max(cap - 1, 1);
      const radius = Math.max(rInner + t * (rOuter - rInner), 50);

      // Equilibrium x position (uniform radiusGap spacing, independent of radius):
      //   Right arc k:  eq_x = midX + rg/2 + k*rg
      //   Left  arc k:  eq_x = midX - rg/2 - k*rg
      //
      // Arc center derived from equilibrium + radius:
      //   Right: eq_x = centerX - radius  -->  centerX = eq_x + radius
      //   Left:  eq_x = centerX + radius  -->  centerX = eq_x - radius
      let centerX;
      if (vi < nLeft) {
        const eqX = midX - rg / 2 - k * rg;
        centerX   = eqX - radius;
        this.entries[physIdx] = {
          side: 'left', centerX, centerY: ch / 2, radius, visualIndex: vi
        };
      } else {
        const eqX = midX + rg / 2 + k * rg;
        centerX   = eqX + radius;
        this.entries[physIdx] = {
          side: 'right', centerX, centerY: ch / 2, radius, visualIndex: vi
        };
      }
    }
  }

  // --------------------------------------------------
  // get(physicsIndex)
  // Returns the layout entry for a physics index, or undefined.
  // --------------------------------------------------
  get(physicsIndex) {
    return this.entries[physicsIndex];
  }

  // --------------------------------------------------
  // previewNextMass(side)
  //
  // Returns the layout entry that the next mass on the given side
  // WOULD receive if addMass(side) were called, without modifying state.
  // Used by MassVisualObserver to draw the ghost arc hover preview.
  // Returns null if the side is already at capacity.
  // --------------------------------------------------
  previewNextMass(side) {
    const nLeft  = this._nLeft;
    const nRight = this.visualOrder.length - nLeft;
    const cap    = this.dims.maxPerSide;

    if (side === 'right' && nRight >= cap) return null;
    if (side === 'left'  && nLeft  >= cap) return null;

    const s      = this.dims.s;
    const rg     = this.dims.radiusGap;
    const ch     = this.dims.canvasHeight;
    const midX   = this.canvasMidX;
    const rInner = INNER_RADIUS_S * s;
    const rOuter = OUTER_RADIUS_S * s;

    // k = steps outward from innermost that this new mass would occupy.
    const k = (side === 'right') ? nRight : nLeft;
    const t = k / Math.max(cap - 1, 1);
    const radius = Math.max(rInner + t * (rOuter - rInner), 50);

    let centerX;
    if (side === 'right') {
      const eqX = midX + rg / 2 + k * rg;
      centerX   = eqX + radius;
      return { side: 'right', centerX, centerY: ch / 2, radius };
    } else {
      const eqX = midX - rg / 2 - k * rg;
      centerX   = eqX - radius;
      return { side: 'left', centerX, centerY: ch / 2, radius };
    }
  }

  // --------------------------------------------------
  // getVisualNeighbors(visualIndex)
  //
  // Returns the physics indices immediately left and right of a
  // given visual position. Used by CouplingTool.
  //
  // Returns: { left: physicsIndex|undefined, right: physicsIndex|undefined }
  // --------------------------------------------------
  getVisualNeighbors(visualIndex) {
    const left  = (visualIndex > 0)
      ? this.visualOrder[visualIndex - 1]
      : undefined;
    const right = (visualIndex < this.visualOrder.length - 1)
      ? this.visualOrder[visualIndex + 1]
      : undefined;
    return { left, right };
  }

  // --------------------------------------------------
  // addMass(side, mdof)
  //
  // Appends a new mass to the outermost position on the given side:
  //   'right' --> appended at the END of visualOrder (rightmost)
  //   'left'  --> prepended at the START of visualOrder (leftmost)
  //
  // Updates _nLeft so _rebuildEntries() assigns the correct side.
  //
  // Returns new physics index, or -1 if mdof.addMass() failed.
  // Caller must call modalState.rebuild(mdof) afterwards.
  // --------------------------------------------------
  // m, kG: mass (kg) and ground stiffness (N/m) for the new mass.
  // Callers that need inheritance logic pass these explicitly; the defaults
  // (m=1, kG=10) are kept only as a fallback for backward compatibility.
  addMass(side, mdof, m = 1, kG = 10) {
    // Each side is capped independently at dims.maxPerSide (= maxMasses / 2).
    const nLeft  = this._nLeft;
    const nRight = this.visualOrder.length - this._nLeft;
    const cap    = this.dims.maxPerSide;
    if (side === 'right' && nRight >= cap) return -1;
    if (side === 'left'  && nLeft  >= cap) return -1;

    const newPhysIdx = mdof.size();
    const success    = mdof.addMass(m, kG);
    if (!success) return -1;

    if (side === 'right') {
      this.visualOrder.push(newPhysIdx);
      // _nLeft unchanged; new arc is on the right
    } else {
      this.visualOrder.unshift(newPhysIdx);
      this._nLeft++;  // one more left arc
    }

    this._rebuildEntries();
    return newPhysIdx;
  }
}
