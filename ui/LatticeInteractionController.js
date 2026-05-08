/**
 * LatticeInteractionController.js  (Step 4)
 *
 * Handles all user interaction with the WEBGL lattice canvas:
 *   - Strike (click on a node)       -- add displacement impulse
 *   - Mass drag (drag on a node)     -- vertical drag changes node mass
 *   - Stiffness drag (drag on edge)  -- vertical drag changes edge stiffness
 *
 * Hit-testing strategy:
 *   p5's screenX(x,y,z) / screenY(x,y,z) project 3D world coordinates to
 *   2D screen pixels using the current model-view matrix.  updateProjections()
 *   must be called from draw() AFTER all transforms (orbitControl, rotateX)
 *   are applied.  The stored projected positions are then valid for the rest
 *   of the frame and for the next mouse event.
 *
 * Orbit / interaction separation:
 *   lattice-sketch.js calls orbitControl() ONLY when this.mode === 'none'.
 *   When a node or edge is grabbed, orbit is suppressed so the drag is
 *   unambiguously ours.
 *
 * Mass mapping:
 *   Drag down (+dy in screen space) = heavier.  Drag up = lighter.
 *   Log scale: 150 pixels per decade.  Range: defaultMass/3 to defaultMass*3.
 *
 * Stiffness mapping:
 *   Drag up (-dy) = stiffer.  Drag down = softer.
 *   5 stiffness units per pixel.  Range: 1 (minimum coupling) to 2000 (near-rigid).
 *
 * NOT in this file (future steps):
 *   - Sound triggering (Step 6)
 *   - Axis-stiffness slider wiring (Step 5)
 */

class LatticeInteractionController {
  /**
   * @param {LatticeDefinition} latticeDef - owns masses, stiffness, eigenpairs
   * @param {ModalState}        modalState - owns modal coordinates and time evolution
   * @param {number}            zScale     - pixels per unit displacement; must match sketch
   */
  constructor(latticeDef, modalState, zScale) {
    this.latticeDef = latticeDef;
    this.modalState = modalState;
    this.zScale     = zScale;

    const N = latticeDef.size();
    const E = latticeDef.edges.length;

    // --- Projected 2D positions, updated every draw() call ---
    // nodeProj[i].sx / .sy  = screen pixel coordinates of node i's sphere center
    // edgeProj[e].sx / .sy  = screen pixel coordinates of edge e's midpoint
    this.nodeProj = Array.from({ length: N }, () => ({ sx: 0, sy: 0 }));
    this.edgeProj = Array.from({ length: E }, () => ({ sx: 0, sy: 0 }));

    // --- Hit-testing thresholds (pixels) ---
    // NODE_HIT_R is larger than the rendered NODE_RADIUS (12) for forgiving clicks.
    this.NODE_HIT_R  = 28;
    this.EDGE_HIT_R  = 16;  // midpoint proximity for edge selection

    // --- Drag discrimination ---
    // Mouse must move more than DRAG_THRESH pixels from press point to
    // enter drag mode.  Below the threshold on release = strike.
    this.DRAG_THRESH = 7;

    // --- Interaction state machine ---
    // mode: 'none'             -- no interaction, hover updates active
    //        'pending'         -- button pressed but haven't moved DRAG_THRESH yet
    //        'drag-mass'       -- dragging on a node to change its mass
    //        'drag-stiffness'  -- dragging on an edge to change its stiffness
    this.mode     = 'none';
    this.hitNode  = -1;   // node index under mouse at press, or -1
    this.hitEdge  = -1;   // edge list index under mouse at press, or -1
    this.pressX   = 0;    // mouse x at mousePressed
    this.pressY   = 0;    // mouse y at mousePressed

    // Saved parameter values at drag start (used as reference for relative drag)
    this.initialMass = 1;   // latticeDef.masses[hitNode] at drag start
    this.initialK    = 0;   // edge stiffness at drag start

    // --- Hover state (read by lattice-sketch.js for visual highlight) ---
    this.hoverNode = -1;   // node index currently under cursor, or -1
    this.hoverEdge = -1;   // edge list index currently under cursor, or -1

    // --- Active tool ---
    // 'pointer': default -- click strikes, drag changes mass or stiffness
    // 'hold':    click toggles a node between fixed (1000x mass) and free
    this.currentTool = 'pointer';
  }

  // ---------------------------------------------------------------------------
  // setTool(name)
  // Switch the active interaction tool. Called by window.vpSetTool in sketch.
  // ---------------------------------------------------------------------------
  setTool(name) {
    if (name === 'pointer' || name === 'hold') {
      this.currentTool = name;
    }
  }

  // ---------------------------------------------------------------------------
  // updateProjections(disp)
  //
  // Project each node and edge-midpoint from 3D world space to 2D screen space.
  // MUST be called from draw() AFTER orbitControl() and rotateX() are applied,
  // and BEFORE any push()/pop() that changes the transform.
  //
  // p5's screenX(wx, wy, wz) uses the current model-view-projection stack,
  // so calling it here (with rotateX active) gives the same projected position
  // that the rendered sphere center will occupy on screen.
  //
  // @param {number[]} disp - current physical displacements, length N
  // ---------------------------------------------------------------------------
  updateProjections(disp, renderer, cw, ch) {
    const pos   = this.latticeDef.nodePositions;
    const edges = this.latticeDef.edges;
    const zs    = this.zScale;

    // Project each 3D world point to 2D canvas pixels manually.
    //
    // p5's screenX/screenY functions do not exist in this build of p5.js --
    // they are absent from p5.prototype entirely.  Even if they existed, they
    // could not be bound to window in global mode because window.screenX and
    // window.screenY are read-only browser built-ins (the position of the
    // browser window on the monitor).
    //
    // We replicate the three-step MVP projection using the matrices that p5
    // maintains on the renderer:
    //
    //   renderer.uModelMatrix -- model transforms (rotateX, push/pop stack)
    //   renderer.uViewMatrix  -- camera / orbitControl
    //   renderer.uPMatrix     -- perspective projection matrix
    //
    // NOTE: renderer.uMVMatrix is only computed inside _setMatrixUniforms(),
    // which p5 calls when drawing geometry.  Reading it before any draw call
    // gives the value from the PREVIOUS frame, which does not include the
    // current frame's rotateX() or orbit state.  The two matrices above are
    // the live sources; chain them manually.
    //
    // Matrix API:
    //   .multiplyPoint({x,y,z})              --> applies with w=1, returns p5.Vector
    //   .multiplyAndNormalizePoint({x,y,z})  --> applies, then divides by w (persp divide)
    //
    // After uPMatrix + perspective divide we have NDC:
    //   ndcX in [-1, +1], ndcY in [-1, +1]  (+1 = right/top, -1 = left/bottom)
    //
    // p5 WEBGL canvas has y=0 at the TOP, so:
    //   canvasX = (ndcX + 1) / 2 * cw
    //   canvasY = (1 - ndcY) / 2 * ch    (y axis inverted)

    for (let i = 0; i < pos.length; i++) {
      const p = pos[i];
      const z = disp[i] * zs;
      // World coord matches draw(): x = p.screenX, y = -p.screenY (r-axis UP), z = disp*zScale
      //
      // uMVMatrix is only computed inside _setMatrixUniforms() (called when drawing
      // geometry), so it is stale when updateProjections() runs before draw calls.
      // Instead chain the two live matrices explicitly:
      //   uModelMatrix: model transforms (rotateX, any push/pop transforms)
      //   uViewMatrix:  camera / orbitControl
      // Then project through uPMatrix with perspective divide.
      const v1 = renderer.uModelMatrix.multiplyPoint({ x: p.screenX, y: -p.screenY, z: z });
      const v2 = renderer.uViewMatrix.multiplyPoint(v1);
      const c  = renderer.uPMatrix.multiplyAndNormalizePoint(v2);
      this.nodeProj[i].sx = (c.x + 1) / 2 * cw;
      this.nodeProj[i].sy = (1 - c.y) / 2 * ch;
    }

    for (let e = 0; e < edges.length; e++) {
      const edge = edges[e];
      const ni   = pos[edge.i];
      const nj   = pos[edge.j];
      const mx   = (ni.screenX + nj.screenX) * 0.5;
      const my   = (-ni.screenY + -nj.screenY) * 0.5;   // -y flip to both
      const mz   = (disp[edge.i] + disp[edge.j]) * 0.5 * zs;
      const v1 = renderer.uModelMatrix.multiplyPoint({ x: mx, y: my, z: mz });
      const v2 = renderer.uViewMatrix.multiplyPoint(v1);
      const c  = renderer.uPMatrix.multiplyAndNormalizePoint(v2);
      this.edgeProj[e].sx = (c.x + 1) / 2 * cw;
      this.edgeProj[e].sy = (1 - c.y) / 2 * ch;
    }
  }

  // ---------------------------------------------------------------------------
  // pointerDown(mx, my)
  // Called on mousePressed. Finds the hit target and enters 'pending' state.
  // ---------------------------------------------------------------------------
  pointerDown(mx, my) {
    this.pressX = mx;
    this.pressY = my;

    // Nodes have priority over edges (nodes sit on top in the rendered view).
    this.hitNode = this._findNodeAt(mx, my);

    // Fixed nodes are immune to pointer-mode interaction (no strike, no mass drag).
    // The hold tool is the only way to release them.
    if (this.hitNode !== -1 && this.currentTool !== 'hold'
        && this.latticeDef.fixedMasses.has(this.hitNode)) {
      this.hitNode = -1;   // treat as a miss -- fall through to edge / orbit
    }

    if (this.hitNode !== -1) {
      this.hitEdge     = -1;
      this.initialMass = this.latticeDef.masses[this.hitNode];
      this.mode        = 'pending';
      this._setCursor('grabbing');
      return;
    }

    this.hitEdge = this._findEdgeAt(mx, my);
    if (this.hitEdge !== -1) {
      const edge    = this.latticeDef.edges[this.hitEdge];
      this.initialK = this.latticeDef.stiffness[edge.i][edge.j];
      this.mode     = 'pending';
      this._setCursor('ns-resize');
      return;
    }

    // Click on empty space: let orbit control handle it.
    this.mode = 'none';
  }

  // ---------------------------------------------------------------------------
  // pointerMove(mx, my)
  // Called on both mouseMoved (no button) and mouseDragged (button held).
  //
  // When mode = 'none':    update hover highlights, no physics change.
  // When mode = 'pending': check if DRAG_THRESH exceeded; if so, classify drag.
  // When mode = 'drag-*':  apply physics change based on vertical displacement.
  // ---------------------------------------------------------------------------
  pointerMove(mx, my) {
    if (this.mode === 'none') {
      // Hover: find node/edge under cursor for visual highlight.
      this.hoverNode = this._findNodeAt(mx, my);
      this.hoverEdge = (this.hoverNode === -1) ? this._findEdgeAt(mx, my) : -1;
      // Update cursor
      if      (this.hoverNode !== -1) this._setCursor('grab');
      else if (this.hoverEdge !== -1) this._setCursor('ns-resize');
      else                            this._setCursor('default');
      return;
    }

    // Compute drag displacement from press point.
    // verticalDy > 0 means dragged DOWN (heavier / softer).
    const totalDist  = Math.hypot(mx - this.pressX, my - this.pressY);
    const verticalDy = my - this.pressY;

    // Transition from 'pending' to drag mode once threshold is crossed.
    // Hold tool: never enter drag -- all interaction is click-only (toggle fix/release).
    if (this.mode === 'pending' && totalDist > this.DRAG_THRESH && this.currentTool !== 'hold') {
      if      (this.hitNode !== -1) { this.mode = 'drag-mass';       this._setCursor('ns-resize'); }
      else if (this.hitEdge !== -1) { this.mode = 'drag-stiffness';  this._setCursor('ns-resize'); }
    }

    if      (this.mode === 'drag-mass')       this._applyMassDrag(verticalDy);
    else if (this.mode === 'drag-stiffness')  this._applyStiffnessDrag(verticalDy);
  }

  // ---------------------------------------------------------------------------
  // pointerUp(mx, my)
  // Called on mouseReleased. Quick click (still 'pending') = strike.
  // ---------------------------------------------------------------------------
  pointerUp(mx, my) {
    if (this.mode === 'pending' && this.hitNode !== -1) {
      if (this.currentTool === 'hold') {
        // Hold tool: toggle the node between fixed (1000x mass) and free.
        this._toggleHold(this.hitNode);
      } else {
        // Pointer tool: inject a displacement impulse (strike).
        this._strike(this.hitNode);
      }
    }

    // Clear stiffness readout if it was showing.
    const readout = document.getElementById('stiffness-readout');
    if (readout) readout.textContent = '';

    // Reset interaction state.
    this.mode    = 'none';
    this.hitNode = -1;
    this.hitEdge = -1;

    // Refresh hover at release position.
    this.hoverNode = this._findNodeAt(mx, my);
    this.hoverEdge = (this.hoverNode === -1) ? this._findEdgeAt(mx, my) : -1;

    // Cursor: back to hover state or default.
    if      (this.hoverNode !== -1) this._setCursor('grab');
    else if (this.hoverEdge !== -1) this._setCursor('ns-resize');
    else                            this._setCursor('default');
  }

  // ---------------------------------------------------------------------------
  // clearHover()
  // Call when the mouse leaves the canvas. Clears all hover highlights.
  // ---------------------------------------------------------------------------
  clearHover() {
    this.hoverNode = -1;
    this.hoverEdge = -1;
    this._setCursor('default');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  // Find the first node within NODE_HIT_R pixels of (mx, my).
  // Returns node index, or -1 if none.
  _findNodeAt(mx, my) {
    const R2 = this.NODE_HIT_R * this.NODE_HIT_R;
    for (let i = 0; i < this.nodeProj.length; i++) {
      const dx = mx - this.nodeProj[i].sx;
      const dy = my - this.nodeProj[i].sy;
      if (dx * dx + dy * dy < R2) return i;
    }
    return -1;
  }

  // Find the first edge whose midpoint is within EDGE_HIT_R pixels of (mx, my).
  // Returns edge list index, or -1 if none.
  _findEdgeAt(mx, my) {
    const R2 = this.EDGE_HIT_R * this.EDGE_HIT_R;
    for (let e = 0; e < this.edgeProj.length; e++) {
      const dx = mx - this.edgeProj[e].sx;
      const dy = my - this.edgeProj[e].sy;
      if (dx * dx + dy * dy < R2) return e;
    }
    return -1;
  }

  // Inject a displacement impulse at nodeIdx.
  // Adds 0.5 units to the node's current displacement, preserving all other state.
  // The energy spreads outward from the struck node through the coupling network.
  _strike(nodeIdx) {
    const x = this.modalState.getDisplacements();
    const v = this.modalState.getVelocities();
    x[nodeIdx] += 0.5;
    this.modalState.setPhysicalState(x, v);
  }

  // Apply mass change from vertical drag (dy = current mouse y - press y, pixels).
  // Drag up (-dy) = heavier (mass increases). Drag down (+dy) = lighter.
  // Negated so that pulling UP feels like adding mass (lifting it higher).
  // Log scale: 150 pixels per decade.
  // Range: defaultMass/4 (light) to defaultMass*4 (heavy).
  //   log10(4) ~= 0.602, so ~90px of drag reaches either limit from default mass.
  _applyMassDrag(dy) {
    const PIXELS_PER_DECADE = 150;
    const M_MIN = this.latticeDef.defaultMass / 4;
    const M_MAX = this.latticeDef.defaultMass * 4;
    const decades    = -dy / PIXELS_PER_DECADE;   // negate: up = increase mass
    const logCurrent = Math.log10(this.initialMass) + decades;
    const logClamped = Math.max(Math.log10(M_MIN), Math.min(Math.log10(M_MAX), logCurrent));
    this.latticeDef.masses[this.hitNode] = Math.pow(10, logClamped);
    // recompute() rebuilds K, M and solves eigenproblem with new mass.
    // rebuild() projects current physical state into the new modal basis.
    this.latticeDef.recompute();
    this.modalState.rebuild(this.latticeDef);
  }

  // Apply stiffness change from vertical drag.
  // Drag up (-dy) = stiffer.  Drag down (+dy) = softer.
  // 5 stiffness units per pixel so the full range 1..2000 is reachable in
  // roughly 400px of drag (screen height is typically 600-900px).
  // Range: 1 (minimum; keeps nodes coupled, prevents free-mass condition)
  //        to 2000 (near-rigid; much stiffer than the default 150, making the
  //        two nodes behave as a nearly fixed pair).
  _applyStiffnessDrag(dy) {
    const K_MIN           = 1;
    const K_MAX           = 2000;
    const UNITS_PER_PIXEL = 5;
    const newK  = Math.max(K_MIN, Math.min(K_MAX, this.initialK - dy * UNITS_PER_PIXEL));
    const edge  = this.latticeDef.edges[this.hitEdge];
    // setCoupling() calls recompute() internally; just need to rebuild modal state.
    this.latticeDef.setCoupling(edge.i, edge.j, newK);
    this.modalState.rebuild(this.latticeDef);
    // Show current stiffness in the canvas overlay.
    const readout = document.getElementById('stiffness-readout');
    if (readout) readout.textContent = 'k = ' + Math.round(newK);
  }

  // Toggle a node between fixed (1000x mass) and free.
  // Zeroes the node's velocity before fixing so it does not carry momentum
  // into the new eigenbasis. Both fixMass/releaseMass call recompute() internally;
  // modalState.rebuild() re-projects the physical state into the new modal basis.
  _toggleHold(nodeIdx) {
    const def = this.latticeDef;
    if (def.fixedMasses.has(nodeIdx)) {
      // Already fixed: release it back to default mass.
      def.releaseMass(nodeIdx);
    } else {
      // Not fixed: zero velocity then fix at 1000x mass.
      const x = this.modalState.getDisplacements();
      const v = this.modalState.getVelocities();
      v[nodeIdx] = 0;
      this.modalState.setPhysicalState(x, v);
      def.fixMass(nodeIdx);
    }
    // Rebuild modal coordinates into the updated eigenbasis.
    this.modalState.rebuild(this.latticeDef);
  }

  // Set the CSS cursor on the canvas element.
  // Guards against redundant DOM writes (only updates if style changed).
  _setCursor(style) {
    const canvas = document.querySelector('#canvas-container canvas');
    if (canvas && canvas.style.cursor !== style) {
      canvas.style.cursor = style;
    }
  }
}
