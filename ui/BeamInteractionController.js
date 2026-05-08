/**
 * BeamInteractionController.js
 *
 * Handles all user interaction with the WEBGL beam canvas:
 *   - Side strike (click near beam body) --> Gaussian bending impulse
 *   - End strike  (click near beam end)  --> half-cosine extensional impulse
 *   - Hold   (mouse down, hold mode)     --> pin nearest bending point to zero
 *   - End-strike toggle (E key)          --> override: next click is always end strike
 *
 * Hit-testing strategy:
 *   The Nx centerline points (at y=0, z=0 of cross-section) are projected
 *   from 3D world space to 2D canvas pixels via manual MVP multiplication,
 *   same technique as MembraneInteractionController.
 *   updateProjections() is called from beam-sketch.js draw() AFTER all
 *   WEBGL transforms (orbitControl, rotateX) and BEFORE any push()/pop().
 *   The cached projections are then used by onMousePressed().
 *
 * Side vs. end detection:
 *   Clicks in the outer END_ZONE fraction of beam length (default 0.15 = 15% from
 *   each end) automatically fire extensional strikes. Clicks on the beam body
 *   (middle 70%) fire bending strikes. This matches the physical intuition: a
 *   strike on the end face compresses the bar axially.
 *   endStrikeMode (E key or button) is a persistent override that forces the next
 *   click -- anywhere on the beam -- to fire extensional. It resets after firing.
 *
 * Side strike:
 *   Gaussian velocity impulse on bendingState:
 *     v[i] += v0 * exp( -((spatialX[i] - xc)^2) / (2 * w^2) )
 *   w = L/8 (narrow enough to excite many modes).
 *   v0 = 5.0 m/s.
 *
 * End strike:
 *   Half-cosine axial impulse on extensionalState:
 *     left end:  v[i] += v0 * cos(0.5 * pi * spatialX[i] / L)
 *     right end: v[i] += v0 * cos(0.5 * pi * (L - spatialX[i]) / L)
 *   Strongest at the struck end, decays smoothly to zero at far end.
 *
 * Hold constraint:
 *   On press: capture nearestIdx (closest bending centerline point).
 *   Each frame: zero disp and vel at nearestIdx in bendingState.
 *   On release: natural dynamics resume. Orbit suppressed during hold.
 *   Hold does NOT affect extensionalState (you can't grab a compression wave).
 */

class BeamInteractionController {
  /**
   * @param {Object} cfg
   * @param {BeamBendingDefinition}     cfg.bendingDef      -- y-bending: owns L, spatialX, Nx
   * @param {BeamBendingDefinition}     cfg.bendingDefZ     -- z-bending: same L/Nx, different I
   * @param {BeamExtensionalDefinition} cfg.extensionalDef  -- (unused directly, for completeness)
   * @param {ModalState}                cfg.bendingState    -- y-bending modal coordinates
   * @param {ModalState}                cfg.bendingStateZ   -- z-bending modal coordinates
   * @param {ModalState}                cfg.extensionalState -- extensional modal coordinates
   * @param {number}                    cfg.bendScale       -- world units per meter bending
   * @param {number}                    cfg.extScale        -- world units per meter extensional
   * @param {number}                    cfg.cw              -- canvas width (pixels)
   * @param {number}                    cfg.ch              -- canvas height (pixels)
   */
  constructor(cfg) {
    this.bendingDef       = cfg.bendingDef;
    this.bendingDefZ      = cfg.bendingDefZ;
    this.extensionalDef   = cfg.extensionalDef;
    this.bendingState     = cfg.bendingState;
    this.bendingStateZ    = cfg.bendingStateZ;
    this.extensionalState = cfg.extensionalState;
    this.bendScale        = cfg.bendScale || 120;
    this.extScale         = cfg.extScale  || 80;
    this.cw               = cfg.cw;
    this.ch               = cfg.ch;

    const Nx = this.bendingDef.Nx;

    // --- Projected 2D positions of beam centerline points ---
    // Updated every frame in updateProjections().
    // projX[i] / projY[i] = canvas pixel coordinates of centerline slice i.
    this.projX = new Float32Array(Nx);
    this.projY = new Float32Array(Nx);

    // --- Cached world positions of centerline points ---
    // Used by _strikeDirection to project local y/z test vectors.
    this.worldX = new Float32Array(Nx);
    this.worldY = new Float32Array(Nx);

    // --- Cached renderer and beam scale from last updateProjections() ---
    // Needed by _projectToScreen() which is called from onMousePressed().
    this._renderer = null;
    this._S        = 1.0;

    // --- Hit-testing parameters ---
    // POINT_HIT_R: max pixel distance from click to nearest centerline projection
    // to count as a beam hit.
    this.POINT_HIT_R = 35;

    // END_ZONE: fraction of beam length (from each end) that auto-triggers extensional.
    // 0.05 = outer 5cm of each end on a 1m beam.
    // Clicks within this zone are treated as end-face strikes regardless of face geometry.
    this.END_ZONE = 0.05;

    // --- Strike parameters ---
    this.strikeVelocity = 1.25;   // m/s impulse amplitude for both strike types (5.0 / 4)

    // --- Interaction state ---
    // mode: 'none' | 'holding'
    this.mode = 'none';

    // Tool: 'strike' (default) or 'hold'
    this.tool = 'strike';

    // nearestIdx: bending slice index being held (-1 if none)
    this.nearestIdx = -1;

    // endStrikeMode: when true, next click forces an extensional (end) strike
    // regardless of where on the beam it lands.
    // Toggled with the E key.
    this.endStrikeMode = false;
  }

  // ------------------------------------------------------------------
  // updateProjections -- project beam centerline to canvas pixel space.
  //
  // Must be called from draw() AFTER orbitControl() and rotateX(),
  // and BEFORE any push()/pop() that changes the transform stack.
  //
  // Uses the same manual MVP projection as MembraneInteractionController:
  //   renderer.uModelMatrix -- current model transforms (rotateX, etc.)
  //   renderer.uViewMatrix  -- camera / orbitControl state
  //   renderer.uPMatrix     -- perspective projection matrix
  //
  // NDC to canvas pixels (y-axis inverted in canvas space):
  //   canvasX = (ndcX + 1) / 2 * cw
  //   canvasY = (1 - ndcY) / 2 * ch
  //
  // Projects the centerline (world_y = wBend[i]*bendScale, world_z = 0).
  // Using z=0 for hit-testing means we project the mid-plane of the cross-section,
  // which is a good proxy for any click on the beam face.
  //
  // @param {number[]} wBend   -- bending displacements (m)
  // @param {number[]} uExt    -- extensional displacements (m)
  // @param {number}   S       -- beam scale (world units per meter)
  // @param {object}   renderer -- p5 WEBGL renderer (this._renderer in sketch)
  // @param {number}   cw      -- canvas width (pixels)
  // @param {number}   ch      -- canvas height (pixels)
  // ------------------------------------------------------------------
  updateProjections(wBend, uExt, S, renderer, cw, ch) {
    const def = this.bendingDef;
    const Nx  = def.Nx;
    const L   = def.L;

    // Cache renderer and S for use by _strikeDirection() in onMousePressed().
    this._renderer = renderer;
    this._S        = S;

    for (let i = 0; i < Nx; i++) {
      // Centerline world coordinates:
      //   world_x = (spatialX[i] - L/2) * S + uExt[i] * extScale
      //   world_y = wBend[i] * bendScale
      //   world_z = 0  (project at mid-plane; z-bending offset is small vs. hit radius)
      const wx = (def.spatialX[i] - L / 2) * S + uExt[i] * this.extScale;
      const wy = wBend[i] * this.bendScale;
      const wz = 0;

      // Cache world positions for test-vector projection in _strikeDirection().
      this.worldX[i] = wx;
      this.worldY[i] = wy;

      // Manual MVP projection: model -> view -> perspective -> NDC -> pixels.
      const v1 = renderer.uModelMatrix.multiplyPoint({ x: wx, y: wy, z: wz });
      const v2 = renderer.uViewMatrix.multiplyPoint(v1);
      const c  = renderer.uPMatrix.multiplyAndNormalizePoint(v2);

      // Convert NDC to canvas pixels (y-axis inverted).
      this.projX[i] = (c.x + 1) / 2 * cw;
      this.projY[i] = (1 - c.y) / 2 * ch;
    }
  }

  // ------------------------------------------------------------------
  // onMousePressed -- route a mouse click to the appropriate action.
  //
  // Logic:
  //   1. Find nearest projected centerline point.
  //   2. If within POINT_HIT_R: determine side vs. end, then strike or hold.
  //
  // @param {number} mx -- mouseX (canvas pixel)
  // @param {number} my -- mouseY (canvas pixel)
  // @param {number} S  -- current beam scale (world units per meter)
  // @returns {string|null} 'strike_bending', 'strike_extensional', 'hold', or null
  // ------------------------------------------------------------------
  onMousePressed(mx, my, S) {
    const nearest = this._findNearest(mx, my);
    if (nearest.idx < 0 || nearest.dist > this.POINT_HIT_R) {
      return null;   // click missed the beam entirely
    }

    const def    = this.bendingDef;
    const physX  = def.spatialX[nearest.idx];   // physical x of nearest slice (m)
    const L      = def.L;

    this.nearestIdx = nearest.idx;

    if (this.tool === 'hold') {
      // Hold mode: pin the nearest bending slice to zero each frame.
      this.mode = 'holding';
      this._zeroPinnedPoint();
      return 'hold';
    }

    // Determine whether this click is an extensional (end) or bending (side) strike.
    //
    // Extensional if EITHER:
    //   (a) endStrikeMode is on (E key or button -- explicit user override from anywhere), OR
    //   (b) click landed in the end zone (outer END_ZONE fraction of beam length).
    //
    // End-zone detection: physX / L gives normalized position (0 = left, 1 = right).
    // The outer 15% on each side is treated as an end-face hit, matching physical
    // intuition: you're striking the tip of the bar axially, not its side surface.
    const endFrac   = physX / L;
    const inEndZone = endFrac < this.END_ZONE || endFrac > 1 - this.END_ZONE;

    if (this.endStrikeMode || inEndZone) {
      // Determine which end is closer (left or right) to shape the impulse correctly.
      const strikeLeft = physX <= L / 2;   // left half = left-end strike, right half = right
      this._strikeExtensional(strikeLeft);
      this.endStrikeMode = false;   // single-use: reset after firing
      return 'strike_extensional';
    } else {
      // Body hit: bending strike. Direction (y vs. z plane) determined by click
      // position relative to the projected beam centerline.
      const dir = this._strikeDirection(nearest, mx, my);
      this._strikeBending(physX, dir.dyNorm, dir.dzNorm);
      return 'strike_bending';
    }
  }

  // ------------------------------------------------------------------
  // onMouseReleased -- exit hold mode.
  // ------------------------------------------------------------------
  onMouseReleased() {
    this.mode       = 'none';
    this.nearestIdx = -1;
  }

  // ------------------------------------------------------------------
  // holdStep -- called from draw() each frame when mode === 'holding'.
  //
  // Zeroes the held bending slice each frame, implementing the soft
  // constraint used in all other worlds (membrane, string).
  // ------------------------------------------------------------------
  holdStep() {
    if (this.mode !== 'holding') return;
    if (this.nearestIdx < 0) return;
    this._zeroPinnedPoint();
  }

  // ------------------------------------------------------------------
  // strikeCenter -- apply a bending strike at the beam center (L/2).
  //
  // Used for the initial excitation on page load.
  // A center strike excites all odd-numbered modes (which have antinodes
  // at center) and none of the even modes (which have nodes at center).
  // ------------------------------------------------------------------
  strikeCenter() {
    // Initial strike in the y-direction only, so the familiar bending plane is excited.
    // dyNorm=1.0 (full downward impulse), dzNorm=0.0 (no lateral bending).
    this._strikeBending(this.bendingDef.L / 2, 1.0, 0.0);
  }

  // ------------------------------------------------------------------
  // _strikeBending -- apply a directed Gaussian velocity impulse to both
  // bending states (y and z planes).
  //
  // Impulse profile: v[i] += v0 * norm * exp(-((spatialX[i] - xc)^2) / (2 * w^2))
  // Centered at physX = xc, width w = L/8.
  //
  // dyNorm / dzNorm are signed unit-vector components in the cross-section plane:
  //   positive dyNorm --> impulse in +y (downward) direction
  //   positive dzNorm --> impulse in +z direction
  // They satisfy dyNorm^2 + dzNorm^2 = 1 (normalized by _strikeDirection).
  // strikeCenter() uses dyNorm=1, dzNorm=0 for a purely downward y-strike.
  //
  // @param {number} xc     -- physical x of strike center (m)
  // @param {number} dyNorm -- y-component of normalized strike direction
  // @param {number} dzNorm -- z-component of normalized strike direction
  // ------------------------------------------------------------------
  _strikeBending(xc, dyNorm, dzNorm) {
    const def = this.bendingDef;
    const Nx  = def.Nx;
    const L   = def.L;
    const w   = L / 8;         // strike width (m): narrower = more modes excited
    const w2  = 2 * w * w;     // 2 * w^2: denominator in Gaussian exponent
    const v0  = this.strikeVelocity;

    // Y-bending: apply dyNorm fraction of impulse to bendingState.
    if (Math.abs(dyNorm) > 1e-6 && this.bendingState) {
      const disp = this.bendingState.getDisplacements();
      const vel  = this.bendingState.getVelocities();
      for (let i = 0; i < Nx; i++) {
        const dx = def.spatialX[i] - xc;
        vel[i] += v0 * dyNorm * Math.exp(-(dx * dx) / w2);
      }
      this.bendingState.setPhysicalState(disp, vel);
    }

    // Z-bending: apply dzNorm fraction of impulse to bendingStateZ.
    if (Math.abs(dzNorm) > 1e-6 && this.bendingStateZ && this.bendingDefZ) {
      const defZ = this.bendingDefZ;
      const disp = this.bendingStateZ.getDisplacements();
      const vel  = this.bendingStateZ.getVelocities();
      for (let i = 0; i < Nx; i++) {
        const dx = defZ.spatialX[i] - xc;
        vel[i] += v0 * dzNorm * Math.exp(-(dx * dx) / w2);
      }
      this.bendingStateZ.setPhysicalState(disp, vel);
    }
  }

  // ------------------------------------------------------------------
  // _strikeExtensional -- apply a half-cosine velocity impulse to extensionalState.
  //
  // Impulse strongest at the struck end, decays smoothly to zero at far end.
  //   Left end strike:  v[i] += v0 * cos(0.5 * pi * spatialX[i] / L)
  //   Right end strike: v[i] += v0 * cos(0.5 * pi * (L - spatialX[i]) / L)
  //
  // Only modifies extensionalState (bendingState is unchanged).
  //
  // @param {boolean} leftEnd -- true = left end struck, false = right end struck
  // ------------------------------------------------------------------
  _strikeExtensional(leftEnd) {
    const def = this.extensionalDef;
    const ms  = this.extensionalState;
    const Nx  = def.Nx;
    const L   = def.L;
    const v0  = this.strikeVelocity;
    const pi  = Math.PI;

    const disp = ms.getDisplacements();
    const vel  = ms.getVelocities();

    for (let i = 0; i < Nx; i++) {
      // Physical x from the struck end: 0 at struck end, L at far end.
      const xFromEnd = leftEnd ? def.spatialX[i] : (L - def.spatialX[i]);
      // Half-cosine ramp: 1 at struck end, 0 at far end.
      vel[i] += v0 * Math.cos(0.5 * pi * xFromEnd / L);
    }

    ms.setPhysicalState(disp, vel);
  }

  // ------------------------------------------------------------------
  // _zeroPinnedPoint -- zero the held bending point each frame in both planes.
  //
  // Zeros both y-bending and z-bending disp/vel at nearestIdx.
  // Extensional state is unaffected (you can't pin an axial wave).
  // ------------------------------------------------------------------
  _zeroPinnedPoint() {
    // Zero Y-bending at held point.
    const msY   = this.bendingState;
    const dispY = msY.getDisplacements();
    const velY  = msY.getVelocities();
    dispY[this.nearestIdx] = 0;
    velY[this.nearestIdx]  = 0;
    msY.setPhysicalState(dispY, velY);

    // Zero Z-bending at held point.
    if (this.bendingStateZ) {
      const msZ   = this.bendingStateZ;
      const dispZ = msZ.getDisplacements();
      const velZ  = msZ.getVelocities();
      dispZ[this.nearestIdx] = 0;
      velZ[this.nearestIdx]  = 0;
      msZ.setPhysicalState(dispZ, velZ);
    }
  }

  // ------------------------------------------------------------------
  // _projectToScreen -- project a world point to canvas pixel coordinates.
  //
  // Uses the cached renderer from the last updateProjections() call.
  // Same MVP path as updateProjections (model -> view -> perspective -> NDC -> pixels).
  //
  // @param {number} wx, wy, wz -- world coordinates
  // @returns {{ sx: number, sy: number }} canvas pixel position
  // ------------------------------------------------------------------
  _projectToScreen(wx, wy, wz) {
    const r  = this._renderer;
    const v1 = r.uModelMatrix.multiplyPoint({ x: wx, y: wy, z: wz });
    const v2 = r.uViewMatrix.multiplyPoint(v1);
    const c  = r.uPMatrix.multiplyAndNormalizePoint(v2);
    return {
      sx: (c.x + 1) / 2 * this.cw,
      sy: (1 - c.y) / 2 * this.ch
    };
  }

  // ------------------------------------------------------------------
  // _strikeDirection -- compute the normalized strike direction (dyNorm, dzNorm)
  // in the beam cross-section plane from the click position.
  //
  // Algorithm:
  //   1. Project two test points (DELTA world units offset in y and z) to screen.
  //      This gives the screen-space representation of each cross-section axis:
  //        screen_per_y = (sx_y, sy_y) pixels per world unit in y
  //        screen_per_z = (sx_z, sy_z) pixels per world unit in z
  //
  //   2. Visibility check:
  //      In the default front view (rotateX -22.5 deg), the z-axis barely projects
  //      on screen. The 2x2 solve amplifies any horizontal screen offset into a large
  //      spurious z-component -- even a 2-pixel horizontal wiggle can appear as
  //      significant z-bending. The fix: if one direction is barely visible (less than
  //      VISIBILITY_MIN of the other's screen size), skip the 2x2 and use the visible
  //      direction only. This means z-bending can only be excited after orbiting to a
  //      view where the z-face is actually visible to the user.
  //
  //   3. Axis snap:
  //      When both directions are visible (after orbiting), solve the 2x2 and apply
  //      an angular snap: if the click direction is within SNAP_RATIO of a principal
  //      axis (off-axis component < SNAP_RATIO * on-axis), snap to that axis for a
  //      clean single-plane strike. Only truly diagonal clicks (~45 deg) produce
  //      mixed-plane excitation (valid for circle/tube sections).
  //
  //   4. Impulse negation:
  //      Click above centerline (a < 0 in world y) = struck from above = beam
  //      deflects downward = +y impulse. dyNorm = -a / mag (negate to flip to
  //      impulse direction away from click).
  //
  // @param {{ idx: number, dist: number }} nearest -- result from _findNearest
  // @param {number} mx, my -- canvas pixel coordinates of click
  // @returns {{ dyNorm: number, dzNorm: number }} normalized strike direction
  // ------------------------------------------------------------------
  _strikeDirection(nearest, mx, my) {
    if (!this._renderer) {
      return { dyNorm: 1.0, dzNorm: 0.0 };   // no projection data yet
    }

    const i  = nearest.idx;
    const wx = this.worldX[i];
    const wy = this.worldY[i];

    // Project test points: DELTA world units offset in y and z.
    const DELTA = 20;
    const py = this._projectToScreen(wx, wy + DELTA, 0);
    const pz = this._projectToScreen(wx, wy, DELTA);
    const p0 = { sx: this.projX[i], sy: this.projY[i] };

    // Screen-space direction vectors (pixels per world unit) for world +y and +z.
    const sy_y = (py.sy - p0.sy) / DELTA;
    const sx_y = (py.sx - p0.sx) / DELTA;
    const sy_z = (pz.sy - p0.sy) / DELTA;
    const sx_z = (pz.sx - p0.sx) / DELTA;

    // Screen-space magnitude of each world direction.
    // A small magnitude means the direction is nearly perpendicular to the screen --
    // the user is viewing that face edge-on and cannot click on it meaningfully.
    const mag_y_screen = Math.sqrt(sx_y * sx_y + sy_y * sy_y);
    const mag_z_screen = Math.sqrt(sx_z * sx_z + sy_z * sy_z);

    // Click offset from projected centerline (screen pixels).
    const dsx = mx - p0.sx;
    const dsy = my - p0.sy;

    // VISIBILITY_MIN: a direction must project at least this fraction of the other
    // direction's screen size before we can read bending intent in that plane.
    // Default front view: z barely shows (rotateX -22.5 deg makes mag_z < 0.15 * mag_y).
    // After orbiting ~90 deg sideways: y and z approach equal screen sizes.
    const VISIBILITY_MIN = 0.25;

    if (mag_z_screen < VISIBILITY_MIN * mag_y_screen) {
      // z-direction nearly invisible: y-bending only.
      // Sign from dot product of click offset with the y screen-direction vector.
      // Positive dot = click in +y world direction (below center) = push upward = -y impulse.
      const dot_y = sx_y * dsx + sy_y * dsy;
      return { dyNorm: dot_y >= 0 ? -1.0 : 1.0, dzNorm: 0.0 };
    }

    if (mag_y_screen < VISIBILITY_MIN * mag_z_screen) {
      // y-direction nearly invisible: z-bending only.
      const dot_z = sx_z * dsx + sy_z * dsy;
      return { dyNorm: 0.0, dzNorm: dot_z >= 0 ? -1.0 : 1.0 };
    }

    // Both directions visible: solve 2x2 to find world (a, b) from screen (dsx, dsy).
    // [sx_y  sx_z] [a]   [dsx]
    // [sy_y  sy_z] [b] = [dsy]
    const det = sx_y * sy_z - sx_z * sy_y;
    if (Math.abs(det) < 1e-4) {
      // Degenerate: y and z project to same screen direction (viewing from end-on).
      const dot_y = sx_y * dsx + sy_y * dsy;
      return { dyNorm: dot_y >= 0 ? -1.0 : 1.0, dzNorm: 0.0 };
    }

    const a = ( sy_z * dsx - sx_z * dsy) / det;   // world y-offset of click
    const b = (-sy_y * dsx + sx_y * dsy) / det;   // world z-offset of click
    const mag = Math.sqrt(a * a + b * b);

    if (mag < 0.5) {
      // Click within ~1 pixel of centerline projection -- default y-only.
      return { dyNorm: 1.0, dzNorm: 0.0 };
    }

    // Axis snap: if click direction is within ~27 deg of a principal axis, snap to
    // that axis. Prevents small off-axis components from exciting the other plane.
    // SNAP_RATIO = |minor| / |major| threshold: 0.5 = within arctan(0.5) ~ 27 deg.
    // Only truly diagonal clicks (~45 deg) pass through unsnapped -- for circle/tube
    // sections where any radial direction is physically meaningful.
    const SNAP_RATIO = 0.5;
    if (Math.abs(b) < SNAP_RATIO * Math.abs(a)) {
      // Predominantly y: snap to pure y-bending.
      return { dyNorm: a > 0 ? -1.0 : 1.0, dzNorm: 0.0 };
    } else if (Math.abs(a) < SNAP_RATIO * Math.abs(b)) {
      // Predominantly z: snap to pure z-bending.
      return { dyNorm: 0.0, dzNorm: b > 0 ? -1.0 : 1.0 };
    } else {
      // Diagonal: full direction (circle/tube at ~45 deg incidence).
      return { dyNorm: -a / mag, dzNorm: -b / mag };
    }
  }

  // ------------------------------------------------------------------
  // getHoverIdx -- return the centerline slice index under the mouse cursor,
  // or -1 if the cursor is not within POINT_HIT_R of any slice.
  //
  // Called from beam-sketch.js draw() each frame to drive the hover ring.
  //
  // @param {number} mx, my -- canvas pixel coordinates (mouseX, mouseY)
  // @returns {number} slice index, or -1 if no hover
  // ------------------------------------------------------------------
  getHoverIdx(mx, my) {
    const nearest = this._findNearest(mx, my);
    return (nearest.idx >= 0 && nearest.dist <= this.POINT_HIT_R) ? nearest.idx : -1;
  }

  // ------------------------------------------------------------------
  // getHoverInfo -- return hover descriptor for the mouse cursor,
  // or null if the cursor is not within POINT_HIT_R of any slice.
  //
  // Returns one of two shapes:
  //   End zone (outer END_ZONE fraction of beam):
  //     { idx: 0 or Nx-1, isEndFace: true }
  //     idx snapped to the actual beam tip; no viewY/viewZ (not needed for axial disk).
  //   Body zone (middle of beam):
  //     { idx, isEndFace: false, viewY, viewZ }
  //     viewY/viewZ: outward normal of the struck face, from negating _strikeDirection.
  //
  // Using _strikeDirection for body zone ensures face detection uses the same
  // screen-space 2x2 solve and visibility checks as the actual strike.
  //
  // @param {number} mx, my -- canvas pixel coordinates (mouseX, mouseY)
  // @returns {{ idx: number, isEndFace: boolean, viewY?: number, viewZ?: number } | null}
  // ------------------------------------------------------------------
  getHoverInfo(mx, my) {
    const nearest = this._findNearest(mx, my);
    if (nearest.idx < 0 || nearest.dist > this.POINT_HIT_R) return null;

    const def     = this.bendingDef;
    const physX   = def.spatialX[nearest.idx];
    const L       = def.L;
    const endFrac = physX / L;

    if (endFrac < this.END_ZONE || endFrac > 1 - this.END_ZONE) {
      // End zone: snap hover to the beam tip (slice 0 or Nx-1) and flag as end face.
      // The visual observer draws an axial-face disk (orange) rather than a side-face
      // disk (cyan), showing the user they will get an extensional hit, not bending.
      const endIdx = endFrac <= 0.5 ? 0 : def.Nx - 1;
      return { idx: endIdx, isEndFace: true };
    }

    // Body zone: compute face direction for side-face disk (bending hit).
    // _strikeDirection returns the impulse direction (opposite to face normal).
    // Negate to get the outward face normal pointing toward the mouse cursor.
    const strike = this._strikeDirection(nearest, mx, my);
    return { idx: nearest.idx, isEndFace: false, viewY: -strike.dyNorm, viewZ: -strike.dzNorm };
  }

  // ------------------------------------------------------------------
  // _findNearest -- linear search over projected centerline positions.
  //
  // Returns { idx, dist } for the nearest centerline point, or
  // { idx: -1, dist: Infinity } if Nx is 0.
  //
  // @param {number} mx, my -- canvas pixel coordinates of click
  // ------------------------------------------------------------------
  _findNearest(mx, my) {
    const Nx = this.bendingDef.Nx;
    let bestIdx  = -1;
    let bestDist = Infinity;

    for (let i = 0; i < Nx; i++) {
      const dx   = this.projX[i] - mx;
      const dy   = this.projY[i] - my;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx  = i;
      }
    }
    return { idx: bestIdx, dist: bestDist };
  }
}
