/**
 * HoldTool.js
 *
 * Responsibility:
 * - Click a mass to fix it in place (boundary condition for eigenanalysis).
 * - Click a fixed mass again to release it.
 * - Each frame, write stored displacements of fixed masses to ModalState.
 *
 * NOT allowed to:
 * - Draw anything
 * - Advance time
 * - Call mdof.fixMass() or releaseMass() directly -- those calls happen in
 *   InteractionController so the whole physics chain can be coordinated.
 *
 * v0.17 changes (replaces v0.16 drag behavior):
 * - No drag. Single click toggles fix/release.
 * - State is a Map: global index --> { displacement }
 * - applyHold(modalState) writes stored displacements to modalState each frame.
 * - pointerDown returns an action object { action, massIndex } or null.
 * - removeMass(index) and swapMasses(i, j) keep the map consistent when
 *   topology changes.
 */

class HoldTool {
  constructor(opts) {
    this.s            = opts.s;
    this.radiusGap    = opts.radiusGap;
    this.canvasHeight = opts.canvasHeight;

    // Map of currently fixed masses.
    // Key: global physics index.  Value: { displacement } (stored value passed
    // to ModalState.setFixedDisplacement each frame).
    this.fixedMasses = new Map();
  }

  // --------------------------------------------------
  // pointerDown(x, y, mdof)
  //
  // Hit-test every mass via massLayout (same radial-distance test as before).
  // If the clicked mass is already fixed --> return { action:'release', massIndex }.
  // If it is free --> return { action:'fix', massIndex }.
  // If no mass hit --> return null.
  //
  // The caller (InteractionController) reads the return value and calls
  // mdof.fixMass() / releaseMass() + modalState.rebuild() accordingly.
  // --------------------------------------------------
  pointerDown(x, y, mdof) {
    const ml   = window.massLayout;
    const N    = mdof.size();
    const half = this.radiusGap / 2;

    // Edge buffer exclusion: the region within 70*s of canvas top/bottom
    // is reserved for the ground-spring toggle.  No mass hit-testing there.
    const edgeZone = 70 * this.s;
    if (y < edgeZone || y > this.canvasHeight - edgeZone) return null;

    for (let i = 0; i < N; i++) {
      const layout = ml.get(i);
      if (!layout) continue;

      const dx   = x - layout.centerX;
      const dy   = y - layout.centerY;
      const rHit = Math.sqrt(dx * dx + dy * dy);

      if (Math.abs(rHit - layout.radius) < half) {
        if (this.fixedMasses.has(i)) {
          // Mass is already fixed -- release it
          this.fixedMasses.delete(i);
          return { action: 'release', massIndex: i };
        } else {
          // Mass is free -- fix it.  Click coordinates are passed so the caller
          // can set the fixed displacement to where the user actually clicked
          // on the arc (not just wherever the mass happened to be).
          return { action: 'fix', massIndex: i, clickX: x, clickY: y };
        }
      }
    }

    return null;  // no mass hit
  }

  // --------------------------------------------------
  // addFixed(massIndex, displacement)
  //
  // Called by InteractionController after mdof.fixMass() + modalState.rebuild()
  // to record the displacement at which the mass is being held.
  // --------------------------------------------------
  addFixed(massIndex, displacement) {
    this.fixedMasses.set(massIndex, { displacement });
  }

  // --------------------------------------------------
  // applyHold(modalState)
  //
  // Called every frame.  Writes the stored displacement of each fixed mass
  // to ModalState so they stay pinned even as the free masses oscillate.
  // --------------------------------------------------
  applyHold(modalState) {
    for (const [gi, params] of this.fixedMasses) {
      modalState.setFixedDisplacement(gi, params.displacement);
    }
  }

  // --------------------------------------------------
  // getHoldState()
  //
  // Returns the fixedMasses Map (non-empty) or null (nothing fixed).
  // Used by sketch.js for visual feedback and sound muting.
  // --------------------------------------------------
  getHoldState() {
    return this.fixedMasses.size === 0 ? null : this.fixedMasses;
  }

  // --------------------------------------------------
  // releaseAll()
  //
  // Clear all fixed masses (e.g. on 'r' key reset).
  // Caller must also call mdof.releaseMass() for each index and rebuild().
  // --------------------------------------------------
  releaseAll() {
    this.fixedMasses.clear();
  }

  // --------------------------------------------------
  // removeMass(massIndex)
  //
  // Called when a mass is deleted from the system.  Masses with indices
  // below the removed one are unchanged; indices above shift down by 1.
  // The removed mass is dropped from the map.
  // --------------------------------------------------
  removeMass(massIndex) {
    const newMap = new Map();
    for (const [i, params] of this.fixedMasses) {
      if (i < massIndex) {
        newMap.set(i, params);
      } else if (i > massIndex) {
        newMap.set(i - 1, params);
      }
      // i === massIndex is dropped
    }
    this.fixedMasses = newMap;
  }

  // --------------------------------------------------
  // swapMasses(i, j)
  //
  // Called by InteractionController._swapPhysicsIndices before a delete,
  // so the map stays consistent after physics data is swapped.
  // --------------------------------------------------
  swapMasses(i, j) {
    const pi = this.fixedMasses.has(i) ? this.fixedMasses.get(i) : null;
    const pj = this.fixedMasses.has(j) ? this.fixedMasses.get(j) : null;

    if (pi !== null) this.fixedMasses.set(j, pi);
    else             this.fixedMasses.delete(j);

    if (pj !== null) this.fixedMasses.set(i, pj);
    else             this.fixedMasses.delete(i);
  }

  // --------------------------------------------------
  // pointerMove / pointerUp -- no-ops.
  //
  // Kept so InteractionController can call them unconditionally.
  // --------------------------------------------------
  pointerMove(x, y, mdof) {}
  pointerUp(x, y, mdof)   {}
}
