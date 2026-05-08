/**
 * KinematicTool.js
 *
 * Responsibility:
 * - Track which masses are being forced and their forcing parameters
 * - Overwrite forced mass displacements and velocities each frame
 * - Handle pointer events for toggling masses and adjusting parameters
 *
 * NOT allowed to:
 * - Draw anything
 * - Advance time
 * - Store visual state
 *

 * Renamed from ForcingTool. Kinematic excitation = prescribed displacement.
 * Distinct from modal forcing (ModalState.setForcing) = applied force vector.
 *   Kinematic ('k' key): x(t) = A·sin(Ω·t). Mass prescribed, not free.
 *   Modal ('f' key):     F·sin(Ω·t) in modal equations. Mass remains free.
 * getForcingState() kept for MassMassVisualObserver/MassMassSoundObserver compatibility.
 *
 * v0.13.1: maxDisplacement → 1.0. Click 1 stores amplitude. Click 2 + drag
 *          oscillates x(t) = A·sin(Ω·t) about equilibrium.
 *
 * v0.13.2: Drag accumulates from current omega (dragStartOmega + delta).
 *          nudgeOmega(deltaHz) for arrow-key fine control.
 *
 * v0.13.3: Three-condition release check in pointerUp.
 *          Previously, any click 2 with drag < 5px released the mass, making
 *          it impossible to use arrow-key nudging without also dragging the mouse.
 *          Now the mass is only released if ALL THREE conditions are true:
 *            1. drag distance < 5px      (no spatial movement)
 *            2. hold duration < 1000ms   (short tap, not a sustained hold)
 *            3. omega unchanged          (no frequency was set via drag or arrow keys)
 *          Any one of these being false means the user did something intentional
 *          during the session and the mass stays forced.
 *
 * v0.17: Click 1 now immediately starts oscillation at mdof.omega[0] (the lowest
 *        natural frequency of the current system) instead of holding statically.
 *        Drag mode begins immediately on click 1 so frequency can be adjusted
 *        right away. The omega=0 static-hold state no longer exists.
 *        Removed the dead omega===0 branch from pointerMove.
 *
 * Physics:
 *   Oscillating:  x(t) = amplitude · sin(Ω · t + phaseOffset)
 *                 v(t) = amplitude · Ω · cos(Ω · t + phaseOffset)
 *
 *   omega is in rad/s throughout. Hz <--> rad/s: Omega = 2*pi * f
 */

class KinematicTool {
  constructor(opts) {
    // opts kept for backward compatibility; geometry now comes from window.massLayout.
    this.s            = opts.s;
    this.radiusGap    = opts.radiusGap;
    this.canvasWidth  = opts.canvasWidth;
    this.canvasHeight = opts.canvasHeight;

    // Must match MassVisualObserver.clipBuffer so hit areas align with drawn arcs.
    this.clipBuffer = -50 * this.s;

    // Map of mass index → { amplitude, omega, phaseOffset, offset }
    // amplitude:   peak displacement (set by click 1, never changed after)
    // omega:       angular frequency in rad/s (0 = static, >0 = oscillating)
    // phaseOffset: accumulated phase shift (rad) that keeps the waveform
    //              continuous when omega changes.  Updated whenever omega
    //              is set so that sin(omega*t + phaseOffset) is unchanged
    //              at the moment of the change.
    // offset:      always 0 — oscillation is centered on equilibrium
    this.forcedMasses = new Map();

    // Last forcingTime seen in applyKinematic -- used by pointerMove and
    // nudgeOmega to compute phase continuity when omega changes.
    this._lastForcingTime = 0;

    // Full physical range, matching HoldTool.
    this.maxDisplacement = 1.0;

    // Drag state — populated on click 2
    this.isDragging = false;
    this.dragMassIndex = -1;
    this.dragStartX = 0;
    this.dragStartY = 0;
    this.dragStartOmega = 0;  // omega at click-2 moment, for accumulation AND release check

    // v0.13.3: wall-clock time (ms) when click 2 landed
    this.dragStartTime = 0;

    // True when the current drag session was started by a click-1 (new mass).
    // The three-condition release check in pointerUp must NOT fire on click-1
    // sessions -- a quick tap that starts forcing should keep the mass forced.
    // It only fires on click-2 (adjusting an already-forced mass), where a
    // quick tap with no change signals intent to release.
    this._dragIsFirstClick = false;

    // How long (ms) the pointer must be held for the duration check to block release.
    this.RELEASE_THRESHOLD_MS = 1000;

    // Physics index of the mass that modal forcing ('f' key) owns.
    // KinematicTool skips this mass in pointerDown so kinematic drag cannot
    // override the dynamically-free modally-forced mass.
    // Set to -1 when modal forcing is inactive.
    this.forcingTargetIdx = -1;
  }

  /**
   * setForcingTarget(idx)
   * Called by sketch.js whenever modal forcing is toggled or its target changes.
   * @param {number} idx - physics index to block from kinematic drag; -1 = none
   */
  setForcingTarget(idx) {
    this.forcingTargetIdx = idx;
  }

  /**
   * Compute visible arc bounds for a circle of radius r against the canvas edges.
   * Four-edge clipping — must stay in sync with MassVisualObserver.getVisibleArcBounds().
   * arcTop and arcBottom are angles in [0, 2π] spanning through π (left = equilibrium).
   */
  // --------------------------------------------------
  // _arcAngle(px, py, layout)
  // Returns arc angle theta (0..2pi) for a pointer position.
  // For right arcs: atan2(py-cy, px-cx).
  // For left arcs:  atan2(py-cy, cx-px)  (x-axis flipped so equilibrium = pi).
  // --------------------------------------------------
  _arcAngle(px, py, layout) {
    const dx = layout.side === 'right'
      ? px - layout.centerX
      : layout.centerX - px;
    const dy = py - layout.centerY;
    let angle = Math.atan2(dy, dx);
    if (angle < 0) angle += 2 * Math.PI;
    return angle;
  }

  // --------------------------------------------------
  // _computeArcBounds(r)
  // Uses window.massLayout.rightCenter as reference (valid for both sides
  // by symmetry). clipBuffer = 0: arcs stop exactly at canvas edge.
  // --------------------------------------------------
  _computeArcBounds(cx, cy, r) {
    const buf = this.clipBuffer;
    const cw  = this.canvasWidth;
    const ch  = this.canvasHeight;

    let arcTop = 0.05 * Math.PI;
    let arcBottom = 1.95 * Math.PI;

    const cosR = (cw + buf - cx) / r;
    if (cosR > -1 && cosR < 1) {
      const t = Math.acos(cosR);
      arcTop = Math.max(arcTop, t);
      arcBottom = Math.min(arcBottom, 2 * Math.PI - t);
    }

    const cosL = (-buf - cx) / r;
    if (cosL >= -1) {
      const t = Math.acos(cosL);
      arcTop = Math.max(arcTop, t);
      arcBottom = Math.min(arcBottom, 2 * Math.PI - t);
    }

    const sinB = (ch + buf - cy) / r;
    if (sinB > 0 && sinB < 1) {
      arcTop = Math.max(arcTop, Math.PI - Math.asin(sinB));
    }

    const sinT = (-buf - cy) / r;
    if (sinT > -1 && sinT < 0) {
      arcBottom = Math.min(arcBottom, Math.PI - Math.asin(sinT));
    }

    arcTop = Math.min(arcTop, Math.PI - 0.01);
    arcBottom = Math.max(arcBottom, Math.PI + 0.01);

    return { arcTop, arcBottom };
  }

  // --------------------------------------------------
  // _angleToDisplacement(angle, massIndex)
  // Converts arc angle (0..2pi) to physical displacement.
  // Reads radius from massLayout; uses _computeArcBounds for the scale.
  // Returns approximately [-1, 1]: 0 at equilibrium (theta = pi).
  // --------------------------------------------------
  _angleToDisplacement(angle, massIndex) {
    const layout = window.massLayout.get(massIndex);
    if (!layout) return 0;
    const bounds = this._computeArcBounds(layout.centerX, layout.centerY, layout.radius);
    const scale  = Math.min(
      Math.PI - bounds.arcTop,
      bounds.arcBottom - Math.PI
    );
    if (scale <= 0) return 0;
    return (Math.PI - angle) / scale;
  }

  /**
   * pointerDown -- two-click interaction:
   *
   *   Click 1 (mass not yet forced):
   *     Reads click angle --> displacement --> amplitude A.
   *     Immediately begins oscillation at mdof.omega[0] (lowest system frequency).
   *     Immediately enters drag mode so the user can steer frequency right away.
   *     pointerUp releases ONLY if the session was a quick tap with no omega change.
   *
   *   Click 2 (mass already forced):
   *     Begins a new drag/hold session anchored to the current omega.
   *     pointerMove sets omega = dragStartOmega + drag delta.
   *     pointerUp decides whether to release using the three-condition check.
   */
  pointerDown(x, y, mdof) {
    const ml   = window.massLayout;
    const N    = mdof.size();
    const half = this.radiusGap / 2;

    for (let i = 0; i < N; i++) {
      // Skip the mass owned by modal forcing -- it must remain dynamically free.
      if (i === this.forcingTargetIdx) continue;

      const layout = ml.get(i);
      if (!layout) continue;

      // Radial distance from this arc's own center
      const dx   = x - layout.centerX;
      const dy   = y - layout.centerY;
      const rHit = Math.sqrt(dx * dx + dy * dy);

      if (Math.abs(rHit - layout.radius) < half) {

        if (!this.forcedMasses.has(i)) {
          // --- CLICK 1: engage forcing ---
          // Compute arc angle using the side-aware formula, then convert to displacement.
          const angle = this._arcAngle(x, y, layout);
          const raw   = this._angleToDisplacement(angle, i);
          const A = Math.max(-this.maxDisplacement, Math.min(this.maxDisplacement, raw));

          // Start oscillating immediately at the lowest natural frequency of the system.
          // phaseOffset is chosen so that sin(omega*t + phaseOffset) = 1 at t = _lastForcingTime,
          // meaning the mass begins at its full amplitude (the click position) and immediately moves.
          // Fallback to 0.5 Hz if no eigenvalues are available yet.
          const startOmega = (mdof.omega && mdof.omega.length > 0)
            ? mdof.omega[0]
            : 2 * Math.PI * 0.5;

          this.forcedMasses.set(i, {
            amplitude:   A,
            omega:       startOmega,
            phaseOffset: Math.PI / 2 - startOmega * this._lastForcingTime,
            offset:      0
          });

          // Immediately enter drag mode so the user can adjust frequency right away.
          this.isDragging        = true;
          this.dragMassIndex     = i;
          this.dragStartX        = x;
          this.dragStartY        = y;
          this.dragStartOmega    = startOmega;
          this.dragStartTime     = Date.now();
          this._dragIsFirstClick = true;   // block release-on-quick-tap for this session

        } else {
          // --- CLICK 2: begin drag/hold session ---
          const params = this.forcedMasses.get(i);

          this.isDragging        = true;
          this.dragMassIndex     = i;
          this.dragStartX        = x;
          this.dragStartY        = y;
          this.dragStartOmega    = params.omega;
          this.dragStartTime     = Date.now();
          this._dragIsFirstClick = false;  // quick-tap on click-2 means release
        }

        return true;
      }
    }

    return false;
  }

  /**
   * pointerMove — maps drag distance to an omega DELTA added to dragStartOmega.
   *
   * newOmega = clamp(dragStartOmega + delta, 0, 20 rad/s)
   * amplitude is never touched here.
   */
  pointerMove(x, y, mdof) {
    if (!this.isDragging || this.dragMassIndex < 0) return;

    const params = this.forcedMasses.get(this.dragMassIndex);
    if (!params) return;

    const dx = x - this.dragStartX;
    const dy = y - this.dragStartY;
    const dragDistance = Math.sqrt(dx * dx + dy * dy);  // used only for release check

    // Horizontal drag controls frequency: +x increases, -x decreases.
    // At sensitivity 0.13: 100px right ≈ +13 rad/s, 100px left ≈ -13 rad/s.
    const omegaSensitivity = 0.13;
    const rawDelta = dx * omegaSensitivity;  // signed

    // Dead zone: small horizontal movements near centre snap to zero.
    const omegaDelta = Math.abs(rawDelta) < 0.5 ? 0 : rawDelta;

    const newOmega = Math.max(0, Math.min(20, this.dragStartOmega + omegaDelta));

    // Compute phaseOffset so the waveform is continuous at this moment.
    // omega * t + phaseOffset must equal the same value before and after
    // the omega change, so the mass position does not jump.
    const t = this._lastForcingTime;
    let phaseOffset;
    if (newOmega > 0) {
      // Preserve total phase across the omega change.
      const oldPhase = params.omega * t + params.phaseOffset;
      phaseOffset = oldPhase - newOmega * t;
    } else {
      phaseOffset = 0;  // dragged back to zero (dead zone)
    }

    this.forcedMasses.set(this.dragMassIndex, {
      amplitude:   params.amplitude,  // unchanged
      omega:       newOmega,
      phaseOffset: phaseOffset,
      offset:      0
    });
  }

  /**
   * pointerUp — decide whether to release the mass or keep it forced.
   *
   * Release ONLY if all three conditions are true:
   *   1. drag distance < 5px             — no spatial movement
   *   2. hold duration < RELEASE_THRESHOLD_MS  — short tap, not a sustained hold
   *   3. current omega === dragStartOmega — no frequency change via drag or arrow keys
   *
   * If any condition is false, the user did something intentional during the
   * session (set a frequency by dragging, nudged with arrow keys, or held down
   * long enough to signal intent) and the mass stays forced.
   */
  pointerUp(x, y, mdof) {
    if (this.isDragging) {
      const dx = x - this.dragStartX;
      const dy = y - this.dragStartY;
      const dragDistance = Math.sqrt(dx * dx + dy * dy);

      const holdDuration = Date.now() - this.dragStartTime;

      // Read the omega that was actually committed during this session
      const params = this.forcedMasses.get(this.dragMassIndex);
      const currentOmega = params ? params.omega : this.dragStartOmega;

      const noMovement   = dragDistance < 5;
      const shortTap     = holdDuration < this.RELEASE_THRESHOLD_MS;
      const omegaUnchanged = currentOmega === this.dragStartOmega;

      // Release only on click-2 quick-taps with nothing changed.
      // Click-1 sessions (_dragIsFirstClick) always keep the mass forced --
      // the user just activated kinematic mode and a quick tap should not undo it.
      if (!this._dragIsFirstClick && noMovement && shortTap && omegaUnchanged) {
        this.forcedMasses.delete(this.dragMassIndex);
      }
      // Any other case: keep forcing with current params.

      this.isDragging = false;
      this.dragMassIndex = -1;
      this.dragStartOmega = 0;
      this.dragStartTime = 0;
    }
  }

  /**
   * nudgeOmega — fine-tune frequency for all currently oscillating forced masses.
   *
   * Called from sketch.js keyPressed() on UP_ARROW (+deltaHz) / DOWN_ARROW (-deltaHz).
   * Converts Hz to rad/s internally: Δ(Ω) = 2π · ΔHz.
   *
   * Only affects masses where omega > 0 (already oscillating).
   * Static-hold masses (omega = 0) are skipped — no frequency has been set yet.
   *
   * Clamped to [0.5, 20] rad/s — floor prevents nudging to a stop accidentally.
   *
   * @param {number} deltaHz  step size in Hz, e.g. +0.01 or -0.01
   */
  nudgeOmega(deltaHz) {
    const deltaRad = deltaHz * 2 * Math.PI;

    for (const [i, params] of this.forcedMasses) {
      if (params.omega === 0) continue;

      const newOmega = Math.max(0.5, Math.min(20, params.omega + deltaRad));

      // Preserve phase continuity across the nudge.
      const t = this._lastForcingTime;
      const oldPhase  = params.omega * t + params.phaseOffset;
      const phaseOffset = oldPhase - newOmega * t;

      this.forcedMasses.set(i, {
        amplitude:   params.amplitude,
        omega:       newOmega,
        phaseOffset: phaseOffset,
        offset:      0
      });
    }
  }

  /**
   * applyKinematic — called every frame from InteractionController.update().
   * Overwrites position and velocity of each forced mass, then calls
   * setPhysicalState() to re-project into modal coordinates.
   *
   * Static (omega = 0):  x[i] = amplitude,  v[i] = 0
   * Oscillating:         x[i] = A·sin(Ω·t),  v[i] = A·Ω·cos(Ω·t)
   *
   * v[i] is the exact time-derivative of x[i] — necessary for a consistent
   * (x, v) pair so the free masses see a smooth boundary condition.
   */
  applyKinematic(forcingTime, modalState) {
    // Store time so pointerMove and nudgeOmega can compute phase offsets.
    this._lastForcingTime = forcingTime;

    if (this.forcedMasses.size === 0) return;

    const x = modalState.getDisplacements();
    const v = modalState.getVelocities();

    for (const [i, params] of this.forcedMasses) {
      if (i >= x.length) continue;

      if (params.omega === 0) {
        x[i] = params.amplitude;
        v[i] = 0;
      } else {
        // phaseOffset keeps the waveform continuous across omega changes.
        const phase = params.omega * forcingTime + params.phaseOffset;
        x[i] = params.amplitude * Math.sin(phase);
        v[i] = params.amplitude * params.omega * Math.cos(phase);

        // Safety clamp — only relevant near amplitude = maxDisplacement.
        x[i] = Math.max(-this.maxDisplacement, Math.min(this.maxDisplacement, x[i]));
      }
    }

    modalState.setPhysicalState(x, v);
  }

  // --- Accessors for MassVisualObserver / MassSoundObserver ---

  getForcingState() {
    if (this.forcedMasses.size === 0) return null;
    return this.forcedMasses;
  }

  getForcingDragState() {
    return {
      isDragging: this.isDragging,
      dragMassIndex: this.dragMassIndex
    };
  }

  // --- Lifecycle ---

  clearAll() {
    this.forcedMasses.clear();
    this.isDragging        = false;
    this.dragMassIndex     = -1;
    this.dragStartOmega    = 0;
    this.dragStartTime     = 0;
    this._dragIsFirstClick = false;
  }

  /**
   * removeMass — shift forcing map indices when a mass is deleted.
   * Masses below the removed index: unchanged.
   * Masses above: shift down by 1.
   * The removed mass itself is dropped.
   */
  removeMass(massIndex) {
    const newMap = new Map();
    for (const [i, params] of this.forcedMasses) {
      if (i < massIndex) {
        newMap.set(i, params);
      } else if (i > massIndex) {
        newMap.set(i - 1, params);
      }
    }
    this.forcedMasses = newMap;
  }

  /**
   * swapMasses — exchange forcing params between physics indices i and j.
   * Called by InteractionController._swapPhysicsIndices before a delete,
   * so the forcing map stays consistent after the physics data is swapped.
   * Also updates dragMassIndex if one of the swapped indices is being dragged.
   */
  swapMasses(i, j) {
    const pi = this.forcedMasses.has(i) ? this.forcedMasses.get(i) : null;
    const pj = this.forcedMasses.has(j) ? this.forcedMasses.get(j) : null;

    if (pi !== null) this.forcedMasses.set(j, pi);
    else             this.forcedMasses.delete(j);

    if (pj !== null) this.forcedMasses.set(i, pj);
    else             this.forcedMasses.delete(i);

    // Keep drag reference pointing at the same conceptual mass after the swap.
    if      (this.dragMassIndex === i) this.dragMassIndex = j;
    else if (this.dragMassIndex === j) this.dragMassIndex = i;
  }
}