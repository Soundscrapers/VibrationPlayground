/**
 * MembraneInteractionController.js
 *
 * Handles all user interaction with the WEBGL membrane canvas:
 *   - Strike (click on surface) -- Gaussian velocity impulse at clicked point
 *   - Hold   (mouse down)       -- pin the nearest grid point to zero each frame
 *   - Boundary toggle           -- click within 30px of canvas edge to flip that edge's BC
 *
 * Hit-testing strategy:
 *   All Nx*Ny interior spatial points are projected from 3D world space to
 *   2D screen pixels via screenX()/screenY() in updateProjections(), called
 *   from draw() AFTER all WEBGL transforms (orbitControl, rotateX) are applied.
 *   The cached projections are then used by mousePressed() and other event handlers.
 *
 * Gaussian impulse (strike):
 *   v_impulse[k] = v0 * exp( -((x_k - x_click)^2 + (y_k - y_click)^2) / (2 * w^2) )
 *   where (x_click, y_click) is the physical position of the nearest grid point,
 *   w = Lx/10 (default strike width), v0 = 5 m/s (strike velocity).
 *   Narrow w --> many modes excited (bright/metallic); wide w --> few (warm).
 *
 * Hold constraint:
 *   On press: find nearest grid point index (nearestIdx).
 *   Each frame: read full state, zero disp[nearestIdx] and vel[nearestIdx],
 *   write back via setPhysicalState(). On release: natural dynamics resume.
 *
 * Boundary toggle:
 *   The 4 boundary corners are projected to canvas pixels each frame in
 *   updateProjections(). onMousePressed() checks the click distance against
 *   each of the 4 projected boundary segments using _ptSegDist(). If within
 *   EDGE_HIT_PX pixels: call membraneDef.toggleBoundary(edge), modalState.rebuild().
 *
 * Orbit suppression:
 *   membrane-sketch.js calls orbitControl() only when this.mode === 'none'.
 *   During hold, orbit is suppressed so the camera doesn't move while pinning.
 */

class MembraneInteractionController {
  /**
   * @param {MembraneDefinition} membraneDef -- owns geometry, eigenpairs
   * @param {ModalState}         modalState  -- owns modal coordinates, step()
   * @param {number}             cw          -- canvas width (pixels)
   * @param {number}             ch          -- canvas height (pixels)
   * @param {number}             zScale      -- pixels per unit displacement; must match sketch
   */
  constructor(membraneDef, modalState, cw, ch, zScale) {
    this.membraneDef = membraneDef;
    this.modalState  = modalState;
    this.cw          = cw;
    this.ch          = ch;
    this.zScale      = zScale;

    const Ntot = membraneDef.spatialSize();

    // --- Projected 2D positions, updated every frame in draw() ---
    // projX[k] / projY[k] = canvas pixel coordinates of spatial point k
    // (accounting for current displacement and WEBGL transforms)
    this.projX = new Float32Array(Ntot);
    this.projY = new Float32Array(Ntot);

    // --- Projected boundary corners (updated every frame in updateProjections) ---
    // The 4 corners of the membrane boundary rectangle, projected to canvas pixels.
    // cornerProj[0] = bottom-left (physX=0, physY=0)
    // cornerProj[1] = bottom-right (physX=Lx, physY=0)
    // cornerProj[2] = top-right    (physX=Lx, physY=Ly)
    // cornerProj[3] = top-left     (physX=0,  physY=Ly)
    this.cornerProj = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 }
    ];

    // outsetCornerProj: same 4 corners projected at EDGE_OUTSET_PX outside the true
    // membrane boundary (in world pixels). These are used for both the boundary toggle
    // hit test and hover detection so that the hit zone never reaches inside the mesh.
    // Initialized to zero; updated alongside cornerProj in updateProjections().
    this.outsetCornerProj = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 0, y: 0 }
    ];

    // --- Hit-testing and visual-offset parameters ---
    // EDGE_OUTSET_PX: how far outside the true membrane boundary the equilibrium lines
    // are drawn (and the hit zone is centered). Must match EDGE_OUTSET in
    // MembraneVisualObserver._drawBoundaryEdges().
    this.EDGE_OUTSET_PX = 4;

    // POINT_HIT_R: max pixel distance to count as a hit on a spatial point.
    this.POINT_HIT_R = 30;

    // EDGE_HIT_PX: max pixel distance from the OUTSET segment to trigger a boundary
    // toggle or hover. Equal to EDGE_OUTSET_PX so the inner edge of the hit zone
    // falls exactly at the true membrane boundary -- clicks inside the mesh never
    // trigger a boundary toggle.
    this.EDGE_HIT_PX = 12;

    // hoverEdge: which boundary edge the pointer is currently near, or null.
    // Updated each frame by updateHover(); read by MembraneVisualObserver to
    // highlight the hovered edge.
    this.hoverEdge = null;

    // --- Strike parameters ---
    // v0: velocity amplitude of Gaussian impulse (m/s)
    this.strikeVelocity = 5.0;
    // Strike width is computed as Lx/10 at strike time (so it adapts to Lx).

    // --- Interaction state ---
    // mode: 'none'    -- no interaction active
    //        'holding' -- mouse is down, pinning nearestIdx to zero each frame
    this.mode = 'none';

    // Index of the spatial point being held (set on press, used each frame in hold mode).
    this.nearestIdx = -1;

    // Tool setting: 'strike' (default) or 'hold'.
    // Determines what happens when the user clicks outside the edge-hit zone.
    this.tool = 'strike';
  }

  // ------------------------------------------------------------------
  // updateProjections -- project all spatial points to canvas pixel space.
  //
  // Must be called from draw() AFTER orbitControl() and any rotateX/Y/Z
  // transforms, and BEFORE any push()/pop() that changes the transform.
  //
  // p5's screenX/screenY functions do not exist in this build of p5.js.
  // They are absent from p5.prototype because window.screenX and
  // window.screenY are read-only browser built-ins (browser window position).
  //
  // We replicate the MVP projection manually using the live matrix stack:
  //   renderer.uModelMatrix -- current model transforms (rotateX, etc.)
  //   renderer.uViewMatrix  -- camera / orbitControl state
  //   renderer.uPMatrix     -- perspective projection matrix
  //
  // After perspective divide we have NDC coords, then convert to canvas pixels:
  //   canvasX = (ndcX + 1) / 2 * cw
  //   canvasY = (1 - ndcY) / 2 * ch   (y flipped: y=0 is at TOP in canvas space)
  //
  // @param {number[]} disp      -- current physical displacements (length Ntot)
  // @param {number}   meshScale -- pixels per physical meter (computed in draw())
  // @param {object}   renderer  -- p5 renderer (this._renderer from sketch draw())
  // @param {number}   cw        -- canvas width (pixels)
  // @param {number}   ch        -- canvas height (pixels)
  // ------------------------------------------------------------------
  updateProjections(disp, meshScale, renderer, cw, ch) {
    const def  = this.membraneDef;
    const Lx   = def.Lx;
    const Ly   = def.Ly;
    const Ntot = def.spatialSize();
    const Z    = this.zScale;
    const S    = meshScale;

    for (let k = 0; k < Ntot; k++) {
      // World-space coordinates from physical coordinates.
      // world_x = (physX - Lx/2) * S    (+x = right)
      // world_y = -(physY - Ly/2) * S   (flipped: physY=0 maps to +world_y = down)
      // world_z = disp[k] * Z           (+z = toward viewer)
      const wx = (def.spatialX[k] - Lx / 2) * S;
      const wy = -(def.spatialY[k] - Ly / 2) * S;
      const wz = disp[k] * Z;

      // Manual MVP projection:
      // 1. Apply model transform (rotateX, etc.)
      // 2. Apply view transform (camera, orbitControl)
      // 3. Apply perspective projection and divide by w
      const v1 = renderer.uModelMatrix.multiplyPoint({ x: wx, y: wy, z: wz });
      const v2 = renderer.uViewMatrix.multiplyPoint(v1);
      const c  = renderer.uPMatrix.multiplyAndNormalizePoint(v2);

      // NDC to canvas pixels (y-axis inverted: y=0 at top).
      this.projX[k] = (c.x + 1) / 2 * cw;
      this.projY[k] = (1 - c.y) / 2 * ch;
    }

    // --- Project the 4 boundary corners (always at world_z = 0) ---
    // cornerProj[i] tracks the screen position of each membrane corner
    // so onMousePressed can test clicks against the actual rendered edges.
    //
    // World coordinates of each corner:
    //   world_x = (physX - Lx/2) * S
    //   world_y = -(physY - Ly/2) * S   (y-axis flip: physY=0 is at bottom)
    //   world_z = 0  (boundary ring is always at the reference plane)
    const halfX = Lx / 2 * S;
    const halfY = Ly / 2 * S;
    const rawCorners = [
      { x: -halfX, y:  halfY, z: 0 },   // physX=0,  physY=0  (bottom-left)
      { x:  halfX, y:  halfY, z: 0 },   // physX=Lx, physY=0  (bottom-right)
      { x:  halfX, y: -halfY, z: 0 },   // physX=Lx, physY=Ly (top-right)
      { x: -halfX, y: -halfY, z: 0 }    // physX=0,  physY=Ly (top-left)
    ];
    for (let i = 0; i < 4; i++) {
      const rc = rawCorners[i];
      const v1 = renderer.uModelMatrix.multiplyPoint({ x: rc.x, y: rc.y, z: rc.z });
      const v2 = renderer.uViewMatrix.multiplyPoint(v1);
      const c2 = renderer.uPMatrix.multiplyAndNormalizePoint(v2);
      this.cornerProj[i].x = (c2.x + 1) / 2 * cw;
      this.cornerProj[i].y = (1 - c2.y) / 2 * ch;
    }

    // --- Project outset boundary corners (EDGE_OUTSET_PX outside true boundary) ---
    // Each corner is pushed outward from the membrane center by EDGE_OUTSET_PX in
    // world space. These match the equilibrium lines drawn in MembraneVisualObserver
    // and are used as the reference for both hover detection and boundary hit-testing.
    const outset = this.EDGE_OUTSET_PX;
    const outsetRawCorners = [
      { x: -(halfX + outset), y:  (halfY + outset), z: 0 },   // bottom-left
      { x:  (halfX + outset), y:  (halfY + outset), z: 0 },   // bottom-right
      { x:  (halfX + outset), y: -(halfY + outset), z: 0 },   // top-right
      { x: -(halfX + outset), y: -(halfY + outset), z: 0 }    // top-left
    ];
    for (let i = 0; i < 4; i++) {
      const rc = outsetRawCorners[i];
      const v1 = renderer.uModelMatrix.multiplyPoint({ x: rc.x, y: rc.y, z: rc.z });
      const v2 = renderer.uViewMatrix.multiplyPoint(v1);
      const c2 = renderer.uPMatrix.multiplyAndNormalizePoint(v2);
      this.outsetCornerProj[i].x = (c2.x + 1) / 2 * cw;
      this.outsetCornerProj[i].y = (1 - c2.y) / 2 * ch;
    }
  }

  // ------------------------------------------------------------------
  // onMousePressed -- called from p5's mousePressed().
  //
  // Logic:
  //   1. Check if click is within EDGE_HIT_PX of any canvas edge.
  //      If so: toggle that boundary condition and return early.
  //   2. Otherwise: find the nearest projected spatial point.
  //      If within POINT_HIT_R:
  //        tool='strike' --> strikeAt(physX, physY)
  //        tool='hold'   --> enter hold mode at nearestIdx
  //
  // @param {number} mx -- mouseX (canvas pixel coordinates)
  // @param {number} my -- mouseY (canvas pixel coordinates)
  // @param {number} meshScale -- current mesh scale (for physical coord conversion)
  // ------------------------------------------------------------------
  onMousePressed(mx, my, meshScale) {

    // --- Boundary edge hit test ---
    // Check whether the click is within EDGE_HIT_PX of any of the 4 projected
    // membrane boundary segments (not canvas borders -- the membrane is centered
    // in the canvas and its edges rarely fall near the canvas border).
    //
    // Segment definitions (using projected corner indices):
    //   bottom: cornerProj[0] -> cornerProj[1]  (physY=0,  boundaryBottom)
    //   right:  cornerProj[1] -> cornerProj[2]  (physX=Lx, boundaryRight)
    //   top:    cornerProj[2] -> cornerProj[3]  (physY=Ly, boundaryTop)
    //   left:   cornerProj[3] -> cornerProj[0]  (physX=0,  boundaryLeft)
    const edgeSegs = [
      { p: 0, q: 1, edge: 'bottom' },
      { p: 1, q: 2, edge: 'right'  },
      { p: 2, q: 3, edge: 'top'    },
      { p: 3, q: 0, edge: 'left'   }
    ];

    // Use outset corners for hit-testing: the hit zone is centered on the visual
    // equilibrium line (EDGE_OUTSET_PX outside the mesh), so clicks inside the
    // membrane surface never accidentally trigger a boundary toggle.
    for (const seg of edgeSegs) {
      const a = this.outsetCornerProj[seg.p];
      const b = this.outsetCornerProj[seg.q];
      if (this._ptSegDist(mx, my, a.x, a.y, b.x, b.y) < this.EDGE_HIT_PX) {
        this.membraneDef.toggleBoundary(seg.edge);
        this.modalState.rebuild(this.membraneDef);
        return 'boundary';
      }
    }

    // --- Find nearest projected spatial point ---
    const nearest = this._findNearest(mx, my);
    if (nearest.idx < 0 || nearest.dist > this.POINT_HIT_R) {
      // No point nearby -- click on empty canvas, do nothing.
      return null;
    }

    this.nearestIdx = nearest.idx;
    const def   = this.membraneDef;
    const physX = def.spatialX[nearest.idx];  // physical x of nearest point
    const physY = def.spatialY[nearest.idx];  // physical y of nearest point

    if (this.tool === 'strike') {
      // Apply a Gaussian velocity impulse centered at the nearest point.
      this._strikeAt(physX, physY);
      return 'strike';

    } else {
      // Hold mode: enter state machine, suppress orbit in sketch.
      this.mode = 'holding';
      // Zero this point immediately on press.
      this._zeroPinnedPoint();
      return 'hold';
    }
  }

  // ------------------------------------------------------------------
  // updateHover -- called each frame from draw() with current mouse position.
  //
  // Tests the pointer against each outset boundary segment and sets hoverEdge
  // to the name of the nearest edge within EDGE_HIT_PX, or null if none.
  // The visual observer reads hoverEdge to highlight the line under the cursor.
  //
  // @param {number} mx -- mouseX (canvas pixel x)
  // @param {number} my -- mouseY (canvas pixel y)
  // ------------------------------------------------------------------
  updateHover(mx, my) {
    const segs = [
      { p: 0, q: 1, edge: 'bottom' },
      { p: 1, q: 2, edge: 'right'  },
      { p: 2, q: 3, edge: 'top'    },
      { p: 3, q: 0, edge: 'left'   }
    ];
    this.hoverEdge = null;
    for (const seg of segs) {
      const a = this.outsetCornerProj[seg.p];
      const b = this.outsetCornerProj[seg.q];
      if (this._ptSegDist(mx, my, a.x, a.y, b.x, b.y) < this.EDGE_HIT_PX) {
        this.hoverEdge = seg.edge;
        return;
      }
    }
  }

  // ------------------------------------------------------------------
  // onMouseReleased -- called from p5's mouseReleased().
  // Exits hold mode; natural dynamics resume on next step().
  // ------------------------------------------------------------------
  onMouseReleased() {
    this.mode       = 'none';
    this.nearestIdx = -1;
  }

  // ------------------------------------------------------------------
  // holdStep -- called from draw() each frame when mode === 'holding'.
  //
  // Reads current physical state, zeroes the held point, writes back.
  // This is a soft constraint: the modal superposition will re-excite
  // the held point slightly on the next step, but zeroing every frame
  // keeps the residual sub-pixel.
  // ------------------------------------------------------------------
  holdStep() {
    if (this.mode !== 'holding') return;
    if (this.nearestIdx < 0) return;
    this._zeroPinnedPoint();
  }

  // ------------------------------------------------------------------
  // _zeroPinnedPoint -- zero the held point in physical state.
  //
  // Internal helper. Reads current displacements and velocities, zeros
  // the element at nearestIdx, writes back via setPhysicalState().
  // ------------------------------------------------------------------
  _zeroPinnedPoint() {
    const ms   = this.modalState;
    const disp = ms.getDisplacements();   // full physical displacement array
    const vel  = ms.getVelocities();      // full physical velocity array

    disp[this.nearestIdx] = 0;
    vel[this.nearestIdx]  = 0;

    ms.setPhysicalState(disp, vel);
  }

  // ------------------------------------------------------------------
  // _strikeAt -- apply a Gaussian velocity impulse at physical position (xc, yc).
  //
  // Impulse profile: v_impulse[k] = v0 * exp( -(r_k^2) / (2 * w^2) )
  //   where r_k = sqrt((x_k - xc)^2 + (y_k - yc)^2)
  //   w = Lx / 10   (strike width; narrower = brighter spectrum)
  //   v0 = strikeVelocity (m/s)
  //
  // Adds impulse to current velocity and writes back via setPhysicalState().
  // Preserves current displacement (only velocity is changed).
  //
  // @param {number} xc -- physical x of strike center (m)
  // @param {number} yc -- physical y of strike center (m)
  // ------------------------------------------------------------------
  _strikeAt(xc, yc) {
    const def  = this.membraneDef;
    const ms   = this.modalState;
    const Ntot = def.spatialSize();
    const w    = def.Lx / 10;      // strike width (m); tracks Lx so it adapts to domain
    const v0   = this.strikeVelocity;
    const w2   = 2 * w * w;        // denominator: 2 * w^2

    // Read current state.
    const disp = ms.getDisplacements();
    const vel  = ms.getVelocities();

    // Add Gaussian impulse to velocity at each spatial point.
    for (let k = 0; k < Ntot; k++) {
      const dx = def.spatialX[k] - xc;
      const dy = def.spatialY[k] - yc;
      const r2 = dx * dx + dy * dy;
      vel[k] += v0 * Math.exp(-r2 / w2);
    }

    // Write updated velocity back to modal state.
    ms.setPhysicalState(disp, vel);
  }

  // ------------------------------------------------------------------
  // _findNearest -- linear search over projected positions.
  //
  // Returns { idx, dist } where idx is the flat spatial index (0..Ntot-1)
  // of the nearest projected point, and dist is the pixel distance.
  // Returns { idx: -1, dist: Infinity } if spatialSize is 0.
  //
  // At 1600 points this is a cheap O(N) loop, fast even on click.
  //
  // @param {number} mx -- canvas pixel x
  // @param {number} my -- canvas pixel y
  // ------------------------------------------------------------------
  _findNearest(mx, my) {
    const Ntot = this.membraneDef.spatialSize();
    let   bestIdx  = -1;
    let   bestDist = Infinity;

    for (let k = 0; k < Ntot; k++) {
      const dx   = this.projX[k] - mx;
      const dy   = this.projY[k] - my;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx  = k;
      }
    }

    return { idx: bestIdx, dist: bestDist };
  }

  // ------------------------------------------------------------------
  // strikeAtCenter -- public helper called from sketch.js to apply an
  // initial strike at the membrane center (Lx/2, Ly/2).
  // ------------------------------------------------------------------
  strikeAtCenter() {
    const def = this.membraneDef;
    this._strikeAt(def.Lx / 2, def.Ly / 2);
  }

  // ------------------------------------------------------------------
  // _ptSegDist -- distance from point P to line segment AB in 2D.
  //
  // Projects P onto the line through A and B, clamps t to [0,1] to stay
  // within the segment, then returns the distance to the clamped point.
  //
  // @param {number} px, py -- query point
  // @param {number} ax, ay -- segment start
  // @param {number} bx, by -- segment end
  // @returns {number} distance (pixels)
  // ------------------------------------------------------------------
  _ptSegDist(px, py, ax, ay, bx, by) {
    const dx   = bx - ax;
    const dy   = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
      // Degenerate segment (A == B): return distance to point A.
      return Math.sqrt((px - ax) * (px - ax) + (py - ay) * (py - ay));
    }
    // t: scalar projection of AP onto AB, clamped to [0, 1].
    let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    // Closest point on segment.
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    return Math.sqrt((px - qx) * (px - qx) + (py - qy) * (py - qy));
  }
}
