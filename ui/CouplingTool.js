/**
 * CouplingTool
 *
 * Responsibility:
 * - Hit-test the coupling zone between visually adjacent masses
 * - Report hover state so MassVisualObserver can draw the <--> indicator
 * - Add coupling on single click (uncoupled gaps only)
 * - Remove coupling on double-click (coupled gaps only)
 *
 * NOT allowed to:
 * - Draw anything
 * - Advance time
 * - Store modal or visual state
 *
 * Coupling hit zone:
 *   X: between the two arcs' equilibrium x-positions (inset by padding).
 *   Y: within yBuffer pixels of canvas centre (y = canvasHeight / 2).
 *
 * The Y restriction means only hovering/clicking near the equilibrium
 * crossing interacts with coupling, not anywhere in the gap.
 *
 * Hover arrows are suppressed for gaps that already have a coupling spring --
 * they only appear as an invitation to add a coupling where none exists yet.
 * Removing a coupling requires double-clicking the gap within DBLCLICK_MS.
 */

const COUPLING_DBLCLICK_MS = 400;

class CouplingTool {
  constructor(opts) {
    // padding: inset from each arc's equilibrium edge.
    this.padding     = opts.padding  ?? 6;
    this.defaultK    = opts.defaultK ?? 50;

    // yBuffer: half-height of the coupling hit zone centred on canvasHeight/2.
    // Only pointer positions within this band trigger the coupling indicator.
    this.yBuffer      = opts.yBuffer      ?? 40;
    this.canvasHeight = opts.canvasHeight ?? 600;

    // Double-click tracking for coupled-gap deletion.
    // pairKey: canonical string "minIdx_maxIdx" of the last-clicked coupled pair.
    this._lastClickInfo = { pairKey: null, time: 0 };
  }

  // --------------------------------------------------
  // _findPairAtPoint(x, y)
  //
  // Internal. Returns the first adjacent pair whose coupling hit zone
  // contains (x, y), regardless of whether a coupling spring exists.
  //
  // Return value: { iA, iB, midX, midY } or null.
  //   iA / iB  -- physics indices of the two masses (left, then right in visualOrder)
  //   midX     -- x centre of the gap (for indicator placement)
  //   midY     -- y centre (canvasHeight / 2)
  // --------------------------------------------------
  _findPairAtPoint(x, y) {
    const midY = this.canvasHeight / 2;

    // Y must be near the equilibrium horizontal.
    if (Math.abs(y - midY) > this.yBuffer) return null;

    const ml  = window.massLayout;
    const vo  = ml.visualOrder;
    const pad = this.padding;

    for (let vi = 0; vi < vo.length - 1; vi++) {
      const iA = vo[vi];
      const iB = vo[vi + 1];
      const lA = ml.get(iA);
      const lB = ml.get(iB);
      if (!lA || !lB) continue;

      // Equilibrium x for each arc:
      //   Right arc: eq_x = centerX - radius
      //   Left  arc: eq_x = centerX + radius
      const eqA = lA.side === 'right' ? lA.centerX - lA.radius
                                      : lA.centerX + lA.radius;
      const eqB = lB.side === 'right' ? lB.centerX - lB.radius
                                      : lB.centerX + lB.radius;

      if (x > eqA + pad && x < eqB - pad) {
        return { iA, iB, midX: (eqA + eqB) / 2, midY };
      }
    }

    return null;
  }

  // --------------------------------------------------
  // findHoveredPair(x, y, mdof)
  //
  // Public. Used by MassVisualObserver to draw the <--> hover arrow.
  // Returns a pair only when the gap is UNCOUPLED -- the arrow is an
  // invitation to add a spring, so it is suppressed when one already exists.
  //
  // mdof is required to check coupling state.
  // --------------------------------------------------
  findHoveredPair(x, y, mdof) {
    const pair = this._findPairAtPoint(x, y);
    if (!pair) return null;

    // Suppress hover indicator if a coupling spring already exists here.
    if (mdof && mdof.hasCoupling(pair.iA, pair.iB)) return null;

    return pair;
  }

  // --------------------------------------------------
  // pointerDown(x, y, mdof)
  //
  // Single click on uncoupled gap  --> add coupling immediately.
  // First  click on coupled gap    --> record timestamp, consume event, wait.
  // Second click on coupled gap    --> remove coupling (double-click confirmed).
  //
  // Returns true if the click was inside any coupling zone (so the event
  // is not forwarded to mass-drag logic), false if the point missed all gaps.
  // --------------------------------------------------
  pointerDown(x, y, mdof) {
    const pair = this._findPairAtPoint(x, y);
    if (!pair) return false;

    if (!mdof.hasCoupling(pair.iA, pair.iB)) {
      // Uncoupled gap: single click adds the spring.
      mdof.setCoupling(pair.iA, pair.iB, this.defaultK);
      this._lastClickInfo = { pairKey: null, time: 0 };  // reset double-click tracker
      return true;
    }

    // Coupled gap: require double-click to remove.
    // Canonical key is "smaller_larger" so pair order doesn't matter.
    const lo  = Math.min(pair.iA, pair.iB);
    const hi  = Math.max(pair.iA, pair.iB);
    const key = `${lo}_${hi}`;
    const now = performance.now();

    if (key === this._lastClickInfo.pairKey &&
        now - this._lastClickInfo.time < COUPLING_DBLCLICK_MS) {
      // Double-click confirmed: remove the coupling spring.
      mdof.clearCoupling(pair.iA, pair.iB);
      this._lastClickInfo = { pairKey: null, time: 0 };
    } else {
      // First click on this coupled gap: record and wait for the second.
      this._lastClickInfo = { pairKey: key, time: now };
    }

    return true;  // consume the click regardless -- user is in the coupling zone
  }
}
