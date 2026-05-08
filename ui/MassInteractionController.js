/**
 * MassInteractionController.js
 * 
 * Responsibility:
 * - Route pointer events to appropriate tools
 * - Manage tool selection and priority
 * - Handle audio context unlocking
 * - Call applyHold and applyKinematic each frame for continuous updates
 * 
 * Tool priority (when currentTool === 'pointer'):
 * 1. CouplingTool - handles clicks in gaps between arcs
 * 2. HoldTool - handles clicks on arcs themselves
 * 
 * Tool modes:
 * - 'pointer': default - add mass on empty space, toggle coupling in gaps, hold on arcs
 * - 'hold': only hold tool active
 * - 'delete': delete mass on click
 * - 'kinematic': only kinematic excitation tool active
 */
class MassInteractionController {
  constructor(opts) {
    this.mdof = opts.mdof;
    this.modalState = opts.modalState;
    this.soundObserver = opts.soundObserver || null;  // used to init audio on first gesture
    this.audioStarted = false;
    
    // Tool selection state
    this.currentTool = 'pointer';  // 'pointer', 'hold', 'delete', 'kinematic'
    
    // Track pointer position for hold updates
    this.pointerX = 0;
    this.pointerY = 0;
    
    // Store geometry for empty space detection and ground-spring hit zone
    this.centerX     = opts.centerX;
    this.centerY     = opts.centerY;
    this.baseRadius  = opts.baseRadius;
    this.radiusGap   = opts.radiusGap;
    this.s           = opts.s;
    this.canvasHeight = opts.canvasHeight;
    
    this.tools = {
      coupling: new CouplingTool({
        padding:      6  * opts.s,
        yBuffer:      40 * opts.s,   // half-height of the coupling hit band
        defaultK:     opts.defaultK,
        canvasHeight: opts.canvasHeight,
      }),
      // HoldTool and KinematicTool need canvas dimensions for per-ring arc bounds
      hold: new HoldTool(opts),
      kinematic: new KinematicTool(opts)
    };

    // Pointer-mode drag state: set in pointerDown, cleared in pointerUp.
    // Allows dragging a mass to set its displacement in pointer mode,
    // without fixing it as a boundary condition (that is hold mode's job).
    this._pointerDrag = null;   // { massIndex, hemisphere } or null

    // Double-click detection for pointer tool delete gesture.
    // Records which mass was last clicked and when (wall-clock ms).
    // A second click on the same outermost mass within DBLCLICK_MS deletes it.
    this._lastClickInfo = { massIndex: -1, time: 0 };

    // Hover states: set in pointerMove, read by VisualObserver each frame.
    this.couplingHoverPair   = null;
    this.addMassHoverSide    = null;   // 'left' | 'right' | null
    this.groundSpringHoverIdx = -1;    // physics index of arc whose base is hovered, or -1

    // _lastPointerAction: records the specific action taken in the most recent
    // pointerDown so mouseReleased in 2D-sketch.js can set _lastAction correctly.
    // 'couple' when a coupling was added or removed; null otherwise.
    // Cleared at the top of each pointerDown so it never carries over.
    this._lastPointerAction = null;
  }
  
  /**
   * Set current tool
   * @param {string} toolName - 'pointer', 'hold', 'delete', or 'kinematic'
   */
  setTool(toolName) {
    if (['pointer', 'hold', 'delete', 'kinematic'].includes(toolName)) {
      this.currentTool = toolName;
      this.clearHover();  // clear stale hovers on tool switch
    }
  }

  // --------------------------------------------------
  // clearHover()
  //
  // Clears all hover indicators.  Called on tool switch and when the
  // mouse leaves the canvas (mouseMoved in sketch.js).
  // --------------------------------------------------
  clearHover() {
    this.couplingHoverPair    = null;
    this.addMassHoverSide     = null;
    this.groundSpringHoverIdx = -1;
  }
  
  /**
   * Get current tool for cursor rendering
   * @returns {string} current tool name
   */
  getTool() {
    return this.currentTool;
  }
  
  /**
   * isInAddMassZone(x, y)
   *
   * Returns 'left', 'right', or false.
   *
   * The add zone is the region beyond the outermost arc on each side,
   * extending one radiusGap further out. Clicking there adds a mass on
   * that side.
   *
   * For right side: x > outermost-right equilibrium + radiusGap/2
   *   and x < outermost-right equilibrium + 2.5*radiusGap  (depth limit)
   * For left side:  mirror image.
   *
   * Equilibrium x for a right arc = layout.centerX - layout.radius
   * Equilibrium x for a left arc  = layout.centerX + layout.radius
   */
  isInAddMassZone(x, y) {
    const ml = window.massLayout;
    const vo = ml.visualOrder;
    if (vo.length === 0) return false;

    const rg = this.radiusGap;

    // Outermost right arc = last in visualOrder
    const outerRightLayout = ml.get(vo[vo.length - 1]);
    if (outerRightLayout && outerRightLayout.side === 'right') {
      const rightEq   = outerRightLayout.centerX - outerRightLayout.radius;
      const zoneStart = rightEq + rg / 2;
      const zoneEnd   = rightEq + 2.5 * rg;
      if (x > zoneStart && x < zoneEnd) return 'right';
    }

    // Outermost left arc = first in visualOrder
    const outerLeftLayout = ml.get(vo[0]);
    if (outerLeftLayout && outerLeftLayout.side === 'left') {
      const leftEq    = outerLeftLayout.centerX + outerLeftLayout.radius;
      const zoneStart = leftEq - 2.5 * rg;
      const zoneEnd   = leftEq - rg / 2;
      if (x > zoneStart && x < zoneEnd) return 'left';
    }

    return false;
  }

  /**
   * findMassAtPoint(x, y)
   *
   * Returns the physics index of the mass whose arc the pointer is on,
   * or -1 if none. Reads geometry from massLayout; works for both sides.
   */
  findMassAtPoint(x, y) {
    const ml   = window.massLayout;
    const N    = this.mdof.size();
    const half = this.radiusGap / 2;

    // Exclude the edge buffer zone -- reserved for ground-spring toggle.
    const edgeZone = 70 * this.s;
    if (y < edgeZone || y > this.canvasHeight - edgeZone) return -1;

    for (let i = 0; i < N; i++) {
      const layout = ml.get(i);
      if (!layout) continue;
      const dx   = x - layout.centerX;
      const dy   = y - layout.centerY;
      const rHit = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(rHit - layout.radius) < half) return i;
    }

    return -1;
  }

  // --------------------------------------------------
  // findGroundBaseAtPoint(x, y)
  //
  // Returns the physics index of the mass whose arc base the pointer
  // is hovering over, or -1 if none.
  //
  // The "base" of an arc is its two endpoints where it reaches the canvas
  // edge (top or bottom).  The hit zone requires BOTH conditions:
  //   1. y is within edgeZone pixels of the canvas top or bottom edge.
  //   2. The pointer is on the arc (circle-distance check, same tolerance
  //      as findMassAtPoint: half a radiusGap).
  //
  // edgeZone = 50 * s matches VisualObserver.clipBuffer (-50*s) so the
  // hover zone aligns with where arc endpoints actually appear.  A larger
  // value pushes the zone closer to the menu tabs at the canvas boundary.
  // --------------------------------------------------
  findGroundBaseAtPoint(x, y) {
    const ml       = window.massLayout;
    const N        = this.mdof.size();
    const ch       = this.canvasHeight;
    const edgeZone = 50 * this.s;
    const half     = this.radiusGap / 2;

    // Only activate near the canvas top or bottom.
    const nearBottom = y >= ch - edgeZone;
    const nearTop    = y <= edgeZone;
    if (!nearBottom && !nearTop) return -1;

    for (let i = 0; i < N; i++) {
      const layout = ml.get(i);
      if (!layout) continue;
      const dx   = x - layout.centerX;
      const dy   = y - layout.centerY;
      const rHit = Math.sqrt(dx * dx + dy * dy);
      if (Math.abs(rHit - layout.radius) < half) return i;
    }

    return -1;
  }

  // Returns the currently hovered ground-spring base physics index (or -1).
  getGroundSpringHoverIdx() { return this.groundSpringHoverIdx; }

  // Default kGround (N/m) applied when toggling a free mass to grounded.
  static get DEFAULT_K_GROUND() { return 10; }

  // --------------------------------------------------
  // addMass(side)
  //
  // Smart add-mass with property inheritance from the adjacent (outermost)
  // existing mass.  Returns the new physics index on success, -1 on failure.
  //
  // Inheritance rules:
  //   kGround   -- copied directly from adjacent.  If adjacent has kGround=0,
  //                new mass starts free (no ground spring).
  //   coupling  -- if adjacent is coupled to its inner visual neighbor
  //                (the pair that will flank the new mass), the new mass
  //                gets the same coupling stiffness to the adjacent.
  //   free mass -- if new mass has neither kGround nor coupling, its initial
  //                displacement is forced to zero so it does not drift away.
  //
  // The adjacent mass is:
  //   right side: current outermost right = visualOrder[last]
  //   left  side: current outermost left  = visualOrder[0]
  //
  // The inner neighbor is the next element inward in visualOrder
  // (undefined when only one mass exists -- no coupling in that case).
  // --------------------------------------------------
  addMass(side) {
    const ml = window.massLayout;
    const vo = ml.visualOrder;
    if (vo.length === 0) return -1;

    // Identify adjacent and its inner visual neighbor BEFORE adding,
    // since massLayout.addMass() will modify visualOrder.
    const adjIdx   = (side === 'right') ? vo[vo.length - 1] : vo[0];
    const innerIdx = (side === 'right') ? vo[vo.length - 2] : vo[1];
    // innerIdx may be undefined when there is only one mass in the system.

    // --- Rule 1: inherit ground spring from adjacent ---
    const kG_new = this.mdof.kGround[adjIdx];   // 0 if adjacent is free

    // --- Rule 2: inherit coupling from the adjacent -> inner pair ---
    // Only check the direct visual neighbor pair; arbitrary long-range coupling
    // is not inherited (would be confusing for the user).
    let kCoup_new = 0;
    if (innerIdx !== undefined) {
      kCoup_new = this.mdof.stiffness[adjIdx][innerIdx];  // 0 if not coupled
    }

    // --- Add mass with inherited ground spring (calls mdof.addMass internally) ---
    const newIdx = ml.addMass(side, this.mdof, 1, kG_new);
    if (newIdx === -1) return -1;

    // --- Apply coupling to adjacent if the inner pair was coupled ---
    // setCoupling sets both stiffness[newIdx][adjIdx] and stiffness[adjIdx][newIdx],
    // then calls mdof.recompute() to update eigenpairs.
    if (kCoup_new > 0) {
      this.mdof.setCoupling(newIdx, adjIdx, kCoup_new);
    }

    // --- Rebuild modal state with updated eigenpairs ---
    this.modalState.rebuild(this.mdof);

    // --- Rule 3: zero displacement for fully free masses ---
    // A mass with no kGround and no coupling has no restoring force.
    // The small random displacement assigned by rebuild() would cause it
    // to drift indefinitely, so we reset it to zero.
    if (kG_new === 0 && kCoup_new === 0) {
      const x = this.modalState.getDisplacements();
      const v = this.modalState.getVelocities();
      x[newIdx] = 0;
      v[newIdx] = 0;
      this.modalState.setPhysicalState(x, v);
    }

    return newIdx;
  }

  pointerDown(x, y) {
    this.ensureAudioStarted();
    this._lastPointerAction = null;   // clear before each press

    this.pointerX = x;
    this.pointerY = y;

    // Tool-specific behavior
    if (this.currentTool === 'pointer') {
      // Pointer tool: try coupling, then hold, then add mass in designated zone

      // Try CouplingTool first (gaps between arcs)
      if (this.tools.coupling.pointerDown(x, y, this.mdof)) {
        // Coupling was added or removed: recompute stiffness matrix eigenpairs
        // and rebuild the modal basis so the physics reflects the new topology.
        this.mdof.recompute();
        this.modalState.rebuild(this.mdof);
        this._lastPointerAction = 'couple';
        return true;
      }

      // Ground spring toggle: click at the base of an arc (near canvas edge)
      // to toggle kGround between 0 (free) and DEFAULT_K_GROUND (grounded).
      // Takes priority over hold so edge clicks don't accidentally grab a mass.
      const gIdx = this.findGroundBaseAtPoint(x, y);
      if (gIdx >= 0) {
        const kg = this.mdof.kGround[gIdx];
        // Toggle: if already grounded set to 0; if free restore default.
        this.mdof.kGround[gIdx] = (kg > 0)
          ? 0
          : MassInteractionController.DEFAULT_K_GROUND;
        this.mdof.recompute();
        this.modalState.rebuild(this.mdof);
        return true;
      }

      // Click on an arc in pointer mode: start dragging the mass to set its
      // displacement.  Does NOT fix the mass as a boundary condition -- that
      // is the 'hold' tool's job.  Skip already-fixed masses (they are owned
      // by HoldTool and must be released there before being draggable).
      //
      // Double-click exception: if the same outermost mass is clicked twice
      // within DBLCLICK_MS, delete it instead of starting a drag.
      const DBLCLICK_MS = 400;
      const hitMass = this.findMassAtPoint(x, y);
      if (hitMass >= 0 && !this.mdof.isFixed(hitMass)) {
        const now    = performance.now();
        const ml     = window.massLayout;
        const vo2    = ml.visualOrder;
        const layout = ml.get(hitMass);

        // Check for double-click on the same mass.
        if (hitMass === this._lastClickInfo.massIndex &&
            now - this._lastClickInfo.time < DBLCLICK_MS) {
          // Only delete if this mass is the outermost on its side and N > 1.
          const isOutermost = hitMass === vo2[0] || hitMass === vo2[vo2.length - 1];
          if (isOutermost && this.mdof.size() > 1 && layout) {
            this.removeMassAtSide(layout.side);
            this._lastClickInfo = { massIndex: -1, time: 0 };
            return true;
          }
        }

        // Single click: record for double-click detection and start drag.
        this._lastClickInfo = { massIndex: hitMass, time: now };

        if (layout) {
          // Record which hemisphere was clicked so clamping stays on one side.
          const angle      = this.tools.kinematic._arcAngle(x, y, layout);
          const hemisphere = angle <= Math.PI ? 'top' : 'bottom';
          this._pointerDrag = { massIndex: hitMass, hemisphere };
          return true;
        }
      }
      
      // If in add mass zone, use addMass() which handles property inheritance.
      const addSide = this.isInAddMassZone(x, y);
      if (addSide) {
        const newIdx = this.addMass(addSide);
        if (newIdx !== -1) {
          // Clear hover so the ghost doesn't jump to the next slot.
          this.addMassHoverSide = null;
          return true;
        }
      }
      
      return false;
    }
    
    else if (this.currentTool === 'hold') {
      const holdResult = this.tools.hold.pointerDown(x, y, this.mdof);
      if (holdResult) {
        this._processHoldResult(holdResult);
        return true;
      }
      return false;
    }

    else if (this.currentTool === 'kinematic') {
      // If the clicked mass is currently fixed, release the fix first so
      // kinematic forcing can take over immediately.
      const hitIdx = this.findMassAtPoint(x, y);
      if (hitIdx >= 0 && this.tools.hold.fixedMasses.has(hitIdx)) {
        this.tools.hold.fixedMasses.delete(hitIdx);
        this.mdof.releaseMass(hitIdx);
        this.modalState.rebuild(this.mdof);
      }
      return this.tools.kinematic.pointerDown(x, y, this.mdof);
    }
    
    else if (this.currentTool === 'delete') {
      // Delete tool: allow removing the outermost arc on either side.
      //
      // mdof.removeMass() only pops the LAST physics index (N-1). Right arcs
      // start at physics index 0 in the initial layout, so they are never N-1.
      // To handle this, we swap the target mass's physics data with the last
      // mass, update all references, and then let removeMass() pop as usual.
      const N = this.mdof.size();
      if (N <= 1) return false;

      const clickedMass = this.findMassAtPoint(x, y);
      if (clickedMass < 0) return false;

      // Only the outermost arc on each side is deletable (first and last in visualOrder).
      const ml             = window.massLayout;
      const vo             = ml.visualOrder;
      const outermostRight = vo[vo.length - 1];  // rightmost on screen = outermost right
      const outermostLeft  = vo[0];               // leftmost on screen  = outermost left
      if (clickedMass !== outermostRight && clickedMass !== outermostLeft) return false;

      const last = N - 1;

      // If the mass is currently fixed, release it before deletion so
      // mdof.fixedMasses stays consistent (removeMass only clears index N-1).
      if (this.tools.hold.fixedMasses.has(clickedMass)) {
        this.tools.hold.fixedMasses.delete(clickedMass);
        this.mdof.releaseMass(clickedMass);
        // No rebuild here -- we are about to remove the mass entirely.
      }

      // If the target is not already the last physics index, swap it there
      // so that mdof.removeMass() removes the correct mass.
      if (clickedMass !== last) {
        this._swapPhysicsIndices(clickedMass, last);

        // Mirror the swap in visualOrder so positions stay consistent.
        for (let vi2 = 0; vi2 < vo.length; vi2++) {
          if      (vo[vi2] === clickedMass) vo[vi2] = last;
          else if (vo[vi2] === last)        vo[vi2] = clickedMass;
        }

        // Mirror the swap in both tool maps.
        this.tools.kinematic.swapMasses(clickedMass, last);
        this.tools.hold.swapMasses(clickedMass, last);
      }

      // Now remove the last physics index (which holds the clicked-mass data).
      const success = this.mdof.removeMass();
      if (!success) return false;

      // Drop any tool params that were on the deleted mass.
      this.tools.kinematic.removeMass(last);
      this.tools.hold.removeMass(last);

      // Splice `last` from visualOrder, adjusting _nLeft if it was on the left.
      const viDel = ml.visualOrder.indexOf(last);
      if (viDel !== -1) {
        if (viDel < ml._nLeft) ml._nLeft--;
        ml.visualOrder.splice(viDel, 1);
        ml._rebuildEntries();
      }

      this.modalState.rebuild(this.mdof);
      return true;
    }
    
    return false;
  }
  
  pointerMove(x, y) {
    this.pointerX = x;
    this.pointerY = y;

    // Update hover indicators (pointer tool only; clear otherwise).
    if (this.currentTool === 'pointer') {
      this.couplingHoverPair = this.tools.coupling.findHoveredPair(x, y, this.mdof);

      // Ground spring base hover: checked before add-mass zone so edge
      // clicks don't inadvertently show both indicators at once.
      const gHover = this.findGroundBaseAtPoint(x, y);
      this.groundSpringHoverIdx = gHover;

      // Add-mass ghost: only when NOT in coupling zone or ground-spring zone.
      this.addMassHoverSide = (this.couplingHoverPair || gHover >= 0)
        ? null
        : this.isInAddMassZone(x, y);
    } else {
      this.couplingHoverPair    = null;
      this.addMassHoverSide     = null;
      this.groundSpringHoverIdx = -1;
    }

    // Forward to tools that care about move
    this.tools.hold.pointerMove(x, y, this.mdof);
    this.tools.kinematic.pointerMove(x, y, this.mdof);
  }

  // Called by sketch.js each frame so VisualObserver can draw the indicators.
  getCouplingHoverPair() { return this.couplingHoverPair; }
  getAddMassHoverSide()  { return this.addMassHoverSide;  }
  
  pointerUp(x, y) {
    this.pointerX = x;
    this.pointerY = y;

    this._pointerDrag = null;
    this.tools.hold.pointerUp(x, y, this.mdof);
    this.tools.kinematic.pointerUp(x, y, this.mdof);
  }
  
  /**
   * update - Called every frame from sketch.js
   * Applies continuous tool effects like hold and forcing
   * 
   * @param {object} modalState - Current modal state to modify
   * @param {number} forcingTime - Clock for KinematicTool sinusoidal trajectories
   */
  update(modalState, forcingTime) {
    this._applyPointerDrag(modalState);
    this.tools.hold.applyHold(modalState);
    this.tools.kinematic.applyKinematic(forcingTime, modalState);
  }
  
  /**
   * Get hold state for visual feedback
   * @returns {object|null} {massIndex, hemisphere} or null
   */
  getHoldState() {
    return this.tools.hold.getHoldState();
  }
  
  /**
   * Get forcing state for visual feedback
   * @returns {Map|null} Map of forced masses or null
   */
  getForcingState() {
    return this.tools.kinematic.getForcingState();
  }
  
  /**
   * Get forcing drag state for diagnostic display
   * @returns {object} { isDragging, dragMassIndex }
   */
  getForcingDragState() {
    return this.tools.kinematic.getForcingDragState();
  }
  
  /**
   * Change mass size of currently held mass
   * Mass values: 0.125, 0.25, 0.5, 1, 2, 4, 8 (powers of 2)
   * 
   * @param {number} direction - +1 to increase, -1 to decrease
   * @returns {boolean} true if mass was changed
   */
  changeMassSize(direction) {
    const holdState = this.tools.hold.getHoldState();
    // holdState is now a Map (global index --> params) or null.
    // Mass-size editing while a mass is fixed is deferred to a later step.
    if (!holdState || holdState instanceof Map) return false;

    const massIndex = holdState.massIndex;
    const currentMass = this.mdof.masses[massIndex];
    
    // Convert current mass to step index (-3 to +3)
    // mass = 2^step, so step = log2(mass)
    const currentStep = Math.round(Math.log2(currentMass));
    const newStep = Math.max(-3, Math.min(3, currentStep + direction));
    
    // No change if already at limit
    if (newStep === currentStep) return false;
    
    // Calculate new mass
    const newMass = Math.pow(2, newStep);
    
    // Update mass in definition
    this.mdof.masses[massIndex] = newMass;
    
    // Recompute eigenpairs and rebuild modal state
    this.mdof.recompute();
    this.modalState.rebuild(this.mdof);
    
    return true;
  }
  
  // --------------------------------------------------
  // removeMassAtSide(side)
  //
  // Remove the outermost visual mass on the given side ('left' or 'right').
  // Returns true on success, false if N <= 1 or the side has nothing removable.
  //
  // Strategy: mdof.removeMass() always pops the LAST physics index (N-1).
  // The outermost visual mass is not necessarily the last physics index, so
  // we swap it there first, mirror the swap in visualOrder and KinematicTool,
  // then let removeMass() pop it as usual.
  //
  // This is the same swap-then-pop logic used by the delete-tool pointerDown,
  // extracted so vpRemoveMass() in sketch.js can call it without knowing the
  // internal swap mechanism.
  // --------------------------------------------------
  removeMassAtSide(side) {
    const N = this.mdof.size();
    if (N <= 1) return false;

    const ml = window.massLayout;
    const vo = ml.visualOrder;

    // Outermost right = last in visualOrder; outermost left = first.
    const targetPhysIdx = (side === 'right')
      ? vo[vo.length - 1]
      : vo[0];

    const last = N - 1;

    // If the mass is currently fixed, release it before deletion.
    if (this.tools.hold.fixedMasses.has(targetPhysIdx)) {
      this.tools.hold.fixedMasses.delete(targetPhysIdx);
      this.mdof.releaseMass(targetPhysIdx);
      // No rebuild here -- we are about to remove the mass entirely.
    }

    // If target is not already the last physics index, swap it there.
    if (targetPhysIdx !== last) {
      this._swapPhysicsIndices(targetPhysIdx, last);

      // Mirror swap in visualOrder.
      for (let vi = 0; vi < vo.length; vi++) {
        if      (vo[vi] === targetPhysIdx) vo[vi] = last;
        else if (vo[vi] === last)          vo[vi] = targetPhysIdx;
      }

      // Mirror swap in both tool maps.
      this.tools.kinematic.swapMasses(targetPhysIdx, last);
      this.tools.hold.swapMasses(targetPhysIdx, last);
    }

    // Remove the last physics index (now holds the target mass's data).
    const success = this.mdof.removeMass();
    if (!success) return false;

    // Drop any tool params that were on the deleted mass.
    this.tools.kinematic.removeMass(last);
    this.tools.hold.removeMass(last);

    // Splice `last` from visualOrder; adjust _nLeft if it was on the left.
    const viDel = ml.visualOrder.indexOf(last);
    if (viDel !== -1) {
      if (viDel < ml._nLeft) ml._nLeft--;
      ml.visualOrder.splice(viDel, 1);
      ml._rebuildEntries();
    }

    this.modalState.rebuild(this.mdof);
    return true;
  }

  // --------------------------------------------------
  // _swapPhysicsIndices(i, j)
  //
  // Swaps all physics data for indices i and j in mdof:
  //   masses, kGround, and the stiffness matrix (rows AND columns).
  // After the swap, mdof.removeMass() will pop index j's original data
  // if j is the last index (N-1).
  //
  // Row swap is done first; column swap then touches the already-swapped rows,
  // which correctly permutes the full symmetric matrix.
  // --------------------------------------------------
  _swapPhysicsIndices(i, j) {
    const md = this.mdof;

    // Swap scalar arrays
    const tmpM        = md.masses[i];
    md.masses[i]      = md.masses[j];
    md.masses[j]      = tmpM;

    const tmpK        = md.kGround[i];
    md.kGround[i]     = md.kGround[j];
    md.kGround[j]     = tmpK;

    // Swap stiffness rows
    const tmpRow      = md.stiffness[i];
    md.stiffness[i]   = md.stiffness[j];
    md.stiffness[j]   = tmpRow;

    // Swap stiffness columns (operates on already-swapped rows -- correct)
    const N = md.size();
    for (let k = 0; k < N; k++) {
      const tmpC          = md.stiffness[k][i];
      md.stiffness[k][i]  = md.stiffness[k][j];
      md.stiffness[k][j]  = tmpC;
    }

    // Recompute eigenpairs with the updated physical layout.
    md.recompute();
  }

  // --------------------------------------------------
  // _applyPointerDrag(modalState)
  //
  // Called every frame while _pointerDrag is set (pointer tool, mass grabbed).
  // Converts the current pointer position to a physical displacement and writes
  // it to modalState -- same as the old HoldTool drag behavior.
  //
  // Clamping: 60% of the visible arc half-span on the grabbed hemisphere.
  // Crossing the equator (theta = pi) snaps to equilibrium so the user can
  // easily release a mass to rest.
  //
  // Borrows _arcAngle, _computeArcBounds, _angleToDisplacement from
  // KinematicTool -- those helpers already exist and are kept in sync with
  // VisualObserver's arc geometry.
  // --------------------------------------------------
  _applyPointerDrag(modalState) {
    if (!this._pointerDrag) return;

    const { massIndex, hemisphere } = this._pointerDrag;
    const layout = window.massLayout.get(massIndex);
    if (!layout) return;

    const kt     = this.tools.kinematic;
    const px     = this.pointerX;
    const py     = this.pointerY;

    // Arc angle: equilibrium = pi, top hemisphere in [0, pi], bottom in [pi, 2pi].
    const angle  = kt._arcAngle(px, py, layout);

    // Visible arc bounds for clamping.
    const bounds = kt._computeArcBounds(layout.centerX, layout.centerY, layout.radius);
    const clamp  = 0.6;   // fraction of visible half-span
    const topClamp    = Math.PI - clamp * (Math.PI - bounds.arcTop);
    const bottomClamp = Math.PI + clamp * (bounds.arcBottom - Math.PI);

    let clampedAngle;
    if (hemisphere === 'top') {
      clampedAngle = angle > Math.PI
        ? Math.PI                                          // crossed equator: snap to rest
        : Math.max(topClamp, Math.min(Math.PI, angle));
    } else {
      clampedAngle = angle < Math.PI
        ? Math.PI                                          // crossed equator: snap to rest
        : Math.max(Math.PI, Math.min(bottomClamp, angle));
    }

    // Convert clamped angle to physical displacement: 0 at equilibrium, +/-1 at arc ends.
    const scale = Math.min(Math.PI - bounds.arcTop, bounds.arcBottom - Math.PI);
    const disp  = (scale <= 0) ? 0 : (Math.PI - clampedAngle) / scale;

    // Write to physics.
    const xArr = modalState.getDisplacements();
    const vArr = modalState.getVelocities();
    xArr[massIndex] = disp;
    vArr[massIndex] = 0;
    modalState.setPhysicalState(xArr, vArr);
  }

  // --------------------------------------------------
  // _processHoldResult(holdResult)
  //
  // Shared logic for both 'pointer' and 'hold' tool modes when
  // HoldTool.pointerDown returns a non-null action object.
  //
  // 'fix':     snapshot current displacement, store it in HoldTool,
  //            tell mdof to fix the mass, rebuild ModalState.
  //            Also clear kinematic forcing on this mass (the two
  //            tools are mutually exclusive per-mass).
  //
  // 'release': tell mdof to release the mass, rebuild ModalState.
  //            HoldTool.pointerDown already deleted the entry from
  //            fixedMasses before returning this action.
  // --------------------------------------------------
  _processHoldResult(holdResult) {
    const idx = holdResult.massIndex;

    if (holdResult.action === 'fix') {
      // Clear kinematic forcing on this mass (mutually exclusive).
      if (this.tools.kinematic.forcedMasses.has(idx)) {
        this.tools.kinematic.forcedMasses.delete(idx);
      }

      // Compute displacement from the click position on the arc.
      // Uses the same arc-angle conversion as _applyPointerDrag so the mass
      // jumps to where the user clicked, not where it happened to be.
      // Falls back to current displacement if geometry is unavailable.
      const layout = window.massLayout.get(idx);
      let disp = this.modalState.getDisplacements()[idx];  // fallback
      if (layout && holdResult.clickX !== undefined) {
        const kt    = this.tools.kinematic;
        const angle = kt._arcAngle(holdResult.clickX, holdResult.clickY, layout);
        const raw   = kt._angleToDisplacement(angle, idx);
        disp = Math.max(-1, Math.min(1, raw));
      }

      // Move the mass to the clicked displacement BEFORE rebuild so that
      // ModalState.rebuild()'s snapshot captures the intended position.
      const xArr = this.modalState.getDisplacements();
      const vArr = this.modalState.getVelocities();
      xArr[idx] = disp;
      vArr[idx] = 0;
      this.modalState.setPhysicalState(xArr, vArr);

      // Store in HoldTool and fix in mdof.
      this.tools.hold.fixedMasses.set(idx, { displacement: disp });
      this.mdof.fixMass(idx);
      this.modalState.rebuild(this.mdof);

    } else if (holdResult.action === 'release') {
      // HoldTool already deleted the entry from fixedMasses.
      // Just update the physics side.
      this.mdof.releaseMass(idx);
      this.modalState.rebuild(this.mdof);
    }
  }

  ensureAudioStarted() {
    if (this.audioStarted) return;
    if (window.Tone) {
      // iOS requires Tone.start() to be called from a user gesture.
      // ensureAudioGraph() is called here (once) instead of every frame
      // in SoundObserver.update(), which caused repeated Tone.start() calls.
      Tone.start().then(() => {
        console.log("Audio context started, state:", Tone.context.state);
        Tone.Destination.mute = isMuted;
        this.audioStarted = true;
        if (this.soundObserver) {
          this.soundObserver.ensureAudioGraph();
        }
      }).catch(err => {
        console.error("Failed to start audio:", err);
      });
    } else {
      this.audioStarted = true;
    }
  }
}