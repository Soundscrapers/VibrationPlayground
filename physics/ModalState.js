/**
 * ModalState.js
 *
 * Owns:
 * - q, qdot (modal coordinates and velocities)
 * - damped modal time-stepping (homogeneous + particular)
 * - automatic sync with mdof when topology changes
 * - optional harmonic modal forcing (new in v0.14)
 *
 * NOT allowed to:
 * - Perform eigenanalysis
 * - Render
 * - Make sound
 *
 * ------------------------------------------------------------
 * v0.14 addition: modal forced response
 *
 * The physical equation of motion under harmonic forcing is:
 *
 *   M·ẍ + C·ẋ + K·x = f · sin(ω·t)
 *
 * where f is a physical force vector (N values, one per mass).
 * After modal projection (using mass-normalized modes), each
 * modal equation becomes an independently forced oscillator:
 *
 *   q̈ₙ + 2ζₙωₙq̇ₙ + ωₙ²qₙ = pₙ · sin(ω·t)
 *
 * where pₙ = Φₙᵀ · f  (scalar modal force amplitude).
 *
 * The general solution is:
 *   qₙ(t) = qₙ_homogeneous(t) + qₙ_particular(t)
 *
 * Particular (steady-state) solution:
 *   qₙ_part(t) = Dₙ · sin(ω·t + φₙ)
 *
 *   Dₙ = pₙ / √((ωₙ²-ω²)² + (2ζₙωₙω)²)    [amplitude]
 *   φₙ = -atan2(2ζₙωₙω, ωₙ²-ω²)             [phase lag]
 *
 * The homogeneous part (transient) decays at rate ζₙωₙ.
 *
 * Implementation: at each step, subtract the particular solution
 * from the current state to get "homogeneous-only" ICs, run the
 * existing exact homogeneous stepper on those ICs, then add the
 * particular solution back at the new time. This is algebraically
 * exact — no splitting error.
 *
 * When ω changes (e.g. slider moved), recompute Dₙ and φₙ.
 * The q₀* mechanism absorbs the discontinuity: the total q is
 * continuous because we repartition the same state into a new
 * homogeneous + particular split. No phase jumps.
 *
 * Kinematic forcing (ForcingTool) is unaffected — it overwrites
 * physical state before step() runs, as in all prior versions.
 * Both forcing mechanisms can coexist.
 * ------------------------------------------------------------
 */

class ModalState {
  constructor(mdof) {
    this.mdof = mdof;

    // --- Index mapping (mirrors mdof, updated by rebuild) ---
    this.totalN = 0;                     // total mass count: free + fixed
    this.freeToGlobal = [];              // local free index --> global physics index
    this.fixedDisplacements = new Map(); // global index --> stored displacement for fixed masses

    // --- Forcing state (null = no forcing active) ---
    this.forcingVector = null;  // physical force amplitudes, length N (free DOFs)
    this.forcingOmega  = 0;     // driving angular frequency (rad/s)
    this.forcingTime   = 0;     // internal time -- advances in step(), independent of sketch's forcingTime

    // Per-mode derived quantities (recomputed when forcing or topology changes)
    this.modalForces = [];  // pₙ = Φₙᵀ · f
    this.steadyD     = [];  // steady-state amplitude Dₙ
    this.steadyPhi   = [];  // steady-state phase φₙ (radians)

    this.rebuild(mdof);
  }

  // ----------------------------------------------------------
  // rebuild — called when topology changes (mass added/removed,
  // coupling changed, eigenvalues updated).
  //
  // Preserves physical state by projecting into the new basis.
  // If forcing is active, recomputes modal forces and steady-state
  // amplitudes for the new mode shapes and natural frequencies.
  // ----------------------------------------------------------
  rebuild(mdof) {
    this.mdof = mdof;

    // Snapshot FULL physical state before the basis changes.
    // getDisplacements() returns totalN-length array (free + fixed spliced).
    // We need this before overwriting Phi / omega / freeToGlobal.
    let xPhys = null;
    let vPhys = null;
    if (this.Phi && this.omega && this.q && this.qdot) {
      xPhys = this.getDisplacements();
      vPhys = this.getVelocities();
    }

    // Pull new eigendata from definition.
    // mdof.omega and mdof.Phi are for the FREE masses only when fixedMasses.size > 0.
    this.Phi   = mdof.Phi;
    this.omega = mdof.omega;
    this.zeta  = mdof.zeta || this.omega.map(() => 0.02);

    // N = number of free modes (= free DOFs; may be smaller than mdof.masses.length)
    this.N         = this.omega.length;
    this.totalN    = mdof.masses.length;        // total count including fixed
    this.freeToGlobal = mdof.freeToGlobal;     // local free index --> global index

    // Store displacement for each fixed mass (for splicing back in getDisplacements).
    this.fixedDisplacements = new Map();
    for (const gi of mdof.fixedMasses) {
      // Use the snapshotted value if available; otherwise the mass starts at rest.
      const d = (xPhys && gi < xPhys.length) ? xPhys[gi] : 0;
      this.fixedDisplacements.set(gi, d);
    }

    // Edge case: all masses are fixed --> no free DOFs, nothing to integrate.
    if (this.N === 0) {
      this.q    = [];
      this.qdot = [];
      // Reset forcing (cannot force a zero-DOF system).
      this.forcingVector = null;
      this.forcingOmega  = 0;
      this.forcingTime   = 0;
      this.modalForces   = [];
      this.steadyD       = [];
      this.steadyPhi     = [];
      return;
    }

    if (xPhys && vPhys) {
      // Pad if totalN grew (a mass was just added).
      // New masses not yet in xPhys get a small random displacement so they
      // don't start exactly at the superposition of existing modal coordinates
      // and then appear to jump.
      const oldTotal = xPhys.length;
      for (let i = oldTotal; i < this.totalN; i++) {
        xPhys.push(random(-0.05, 0.05));
        vPhys.push(0);
      }

      // Project FREE masses into the new modal basis:
      //   q_n = sum_li  Phi[li][n] * m[gi] * xPhys[gi]
      //   where li = local free index, gi = freeToGlobal[li]
      //
      // Nspatial = number of spatial DOFs summed over in the projection.
      // For MDOF: Nspatial = N (free mass count = mode count, Phi is square).
      // For strings: Nspatial = Nx >> N (Phi is rectangular: Nx rows, N columns).
      // freeToGlobal.length is always the correct spatial DOF count for both cases.
      const Nspatial = this.freeToGlobal.length;
      this.q    = new Array(this.N).fill(0);
      this.qdot = new Array(this.N).fill(0);
      for (let i = 0; i < this.N; i++) {                // mode index
        for (let li = 0; li < Nspatial; li++) {         // spatial DOF index (was this.N)
          const gi = this.freeToGlobal[li];             // global physics index
          const m  = mdof.masses[gi];
          this.q[i]    += this.Phi[li][i] * m * xPhys[gi];
          this.qdot[i] += this.Phi[li][i] * m * vPhys[gi];
        }
      }
    } else {
      // First initialization: zero ICs
      this.q    = new Array(this.N).fill(0);
      this.qdot = new Array(this.N).fill(0);
    }

    // If forcing is active, resize forcingVector to the new free-DOF count,
    // then recompute derived forcing quantities.
    // Caller (sketch.js) should call setForcing() immediately after rebuild()
    // when topology changes, so this resize just keeps things consistent.
    if (this.forcingVector !== null) {
      if (this.forcingVector.length !== this.N) {
        const fOld = this.forcingVector;
        this.forcingVector = new Array(this.N).fill(0);
        for (let j = 0; j < Math.min(fOld.length, this.N); j++) {
          this.forcingVector[j] = fOld[j];
        }
      }
      this._recomputeModalForces();
      this._recomputeSteadyState();
    }
  }

  // ----------------------------------------------------------
  // setForcing — engage harmonic modal forcing.
  //
  // @param {number[]} forceVector  physical force amplitudes (length N)
  //                                e.g. [100, 0] = 100 N on mass 0, none on mass 1
  // @param {number}   omega        driving frequency in rad/s
  //
  // forcingTime is NOT reset here — continuity of the time axis
  // is what prevents phase jumps when omega changes mid-run.
  // ----------------------------------------------------------
  setForcing(forceVector, omega) {
    this.forcingVector = forceVector.slice();  // defensive copy
    this.forcingOmega  = omega;
    this._recomputeModalForces();
    this._recomputeSteadyState();
  }

  // ----------------------------------------------------------
  // clearForcing — remove harmonic forcing, return to free vibration.
  // ----------------------------------------------------------
  clearForcing() {
    this.forcingVector = null;
    this.forcingOmega  = 0;
    this.forcingTime   = 0;
    this.modalForces   = [];
    this.steadyD       = [];
    this.steadyPhi     = [];
  }

  // ----------------------------------------------------------
  // _recomputeModalForces — project physical force vector onto modes.
  //
  // pₙ = Φₙᵀ · f
  //
  // Phi is stored column-major: Phi[spatialIndex][modeIndex].
  // So Φₙ (mode n as a column) has components Phi[j][n] for j=0..N-1.
  // ----------------------------------------------------------
  _recomputeModalForces() {
    const N = this.N;
    this.modalForces = new Array(N).fill(0);
    for (let n = 0; n < N; n++) {
      for (let j = 0; j < N; j++) {
        // Phi[j][n] = component of mode n at spatial DOF j
        this.modalForces[n] += this.Phi[j][n] * this.forcingVector[j];
      }
    }
  }

  // ----------------------------------------------------------
  // _recomputeSteadyState — compute per-mode particular solution
  // amplitude Dₙ and phase φₙ for the current forcing frequency.
  //
  // Dₙ = pₙ / √((ωₙ²-ω²)² + (2ζₙωₙω)²)
  // φₙ = -atan2(2ζₙωₙω, ωₙ²-ω²)
  //
  // Near-resonance (ω ≈ ωₙ) with low damping: denominator is small,
  // D is large. This is physically correct — large response near
  // resonance. Dₙ is finite as long as ζₙ > 0.
  // If ζₙ = 0 exactly and ω = ωₙ exactly, D → ∞. Guard: clamp
  // to a large but finite value. In practice the damping slider
  // minimum prevents this.
  // ----------------------------------------------------------
  _recomputeSteadyState() {
    const N   = this.N;
    const w   = this.forcingOmega;   // driving frequency
    const w2  = w * w;

    this.steadyD   = new Array(N).fill(0);
    this.steadyPhi = new Array(N).fill(0);

    for (let n = 0; n < N; n++) {
      const wn  = this.omega[n];
      const z   = this.zeta[n];
      const p   = this.modalForces[n];
      const wn2 = wn * wn;

      const re = wn2 - w2;               // real part of denominator
      const im = 2 * z * wn * w;         // imaginary part of denominator
      const denom = Math.sqrt(re*re + im*im);

      if (denom < 1e-10) {
        // Exact resonance with zero damping — clamp to large finite value.
        // Sign of p determines direction.
        this.steadyD[n]   = Math.sign(p) * 1e4;
        this.steadyPhi[n] = -Math.PI / 2;
      } else {
        this.steadyD[n]   = p / denom;
        this.steadyPhi[n] = -Math.atan2(im, re);
      }
    }
  }

  // ----------------------------------------------------------
  // step — advance modal state by dt seconds.
  //
  // If forcing is active, uses the exact homogeneous + particular
  // decomposition. Otherwise runs the original homogeneous-only path.
  //
  // Forcing time advances internally here.
  // ----------------------------------------------------------
  step(dt) {
    // Auto-rebuild if topology changed (eigenvalues reference changed)
    if (this.omega !== this.mdof.omega) {
      this.rebuild(this.mdof);
    }

    if (dt === 0) return;

    const hasForcing = this.forcingVector !== null;
    const t    = this.forcingTime;        // time at START of this step
    const tnew = this.forcingTime + dt;   // time at END of this step
    const w    = this.forcingOmega;       // driving frequency

    for (let i = 0; i < this.N; i++) {
      const wn = this.omega[i];
      const z  = this.zeta[i];
      let   q  = this.q[i];
      let   qd = this.qdot[i];

      // --- Near-zero natural frequency: rigid body mode ---
      // No restoring force, no damping term. Simple integration.
      if (wn < 1e-6) {
        this.q[i] = q + qd * dt;
        // (qdot unchanged)
        continue;
      }

      if (hasForcing) {
        // --- Forced case ---
        //
        // Step 1: subtract particular solution at time t from current
        // state. This gives the "homogeneous-only" initial conditions
        // for this step. The homogeneous part is the transient —
        // the part that decays. We don't want to damp the steady state.
        const D   = this.steadyD[i];
        const phi = this.steadyPhi[i];

        const qp_t    = D * Math.sin(w * t    + phi);  // particular displacement at t
        const qdp_t   = D * w * Math.cos(w * t + phi); // particular velocity at t

        const q0star  = q  - qp_t;   // homogeneous IC: displacement
        const qd0star = qd - qdp_t;  // homogeneous IC: velocity

        // Step 2: run the exact homogeneous stepper on the transient ICs
        const [q_hom, qd_hom] = this._homogeneousStep(q0star, qd0star, wn, z, dt);

        // Step 3: add particular solution at the new time
        const qp_new  = D * Math.sin(w * tnew + phi);
        const qdp_new = D * w * Math.cos(w * tnew + phi);

        this.q[i]    = q_hom  + qp_new;
        this.qdot[i] = qd_hom + qdp_new;

      } else {
        // --- Unforced case (original path, unchanged) ---
        const [q_new, qd_new] = this._homogeneousStep(q, qd, wn, z, dt);
        this.q[i]    = q_new;
        this.qdot[i] = qd_new;
      }
    }

    // Advance internal forcing time AFTER the loop so t and tnew
    // are consistent within the loop above.
    if (hasForcing) {
      this.forcingTime = tnew;
    }
  }

  // ----------------------------------------------------------
  // _homogeneousStep — exact analytical solution for one timestep
  // of the underdamped free oscillator.
  //
  // q̈ + 2ζωq̇ + ω²q = 0
  //
  // Returns [q(t+dt), q̇(t+dt)] given initial [q, qd] at t=0.
  //
  // Extracted as a helper so it can be called for both the pure
  // homogeneous path and the forced path (on modified ICs).
  // ----------------------------------------------------------
  _homogeneousStep(q, qd, wn, z, dt) {
    const wd    = wn * Math.sqrt(1 - z * z);  // damped natural frequency
    const decay = Math.exp(-z * wn * dt);      // exponential decay envelope
    const cosWd = Math.cos(wd * dt);
    const sinWd = Math.sin(wd * dt);

    const q_new  = decay * (q * cosWd + ((qd + z * wn * q) / wd) * sinWd);
    const qd_new = decay * (qd * cosWd - ((wn * wn * q + z * wn * qd) / wd) * sinWd);

    return [q_new, qd_new];
  }

  // ----------------------------------------------------------
  // getDisplacements — reconstruct physical displacements from modal coords.
  //
  // Returns a full-length array of size totalN (all masses, free + fixed).
  // Free masses: x[gi] = sum_j  Phi[li][j] * q[j]   (li = local free index)
  // Fixed masses: x[gi] = fixedDisplacements.get(gi) (stored constant)
  //
  // x = Phi · q    (in local free-DOF space, then mapped to global indices)
  // ----------------------------------------------------------
  getDisplacements() {
    // Nspatial = number of spatial DOFs.
    // For MDOF: Nspatial = N (square Phi). For strings: Nspatial = Nx (rectangular Phi).
    // xFree has one entry per spatial DOF, reconstructed as x = Phi * q.
    const Nspatial = this.freeToGlobal.length;
    const xFree = new Array(Nspatial).fill(0);
    for (let li = 0; li < Nspatial; li++) {          // spatial DOF index (was this.N)
      for (let j = 0; j < this.N; j++) {             // mode index (unchanged)
        xFree[li] += this.Phi[li][j] * this.q[j];
      }
    }

    // Build full-length output and splice values in by global index
    const x = new Array(this.totalN).fill(0);
    for (let li = 0; li < Nspatial; li++) {          // spatial DOF index (was this.N)
      x[this.freeToGlobal[li]] = xFree[li];
    }
    for (const [gi, d] of this.fixedDisplacements) {
      x[gi] = d;
    }
    return x;
  }

  // ----------------------------------------------------------
  // getVelocities — reconstruct physical velocities.
  //
  // Returns full-length totalN array. Fixed masses have velocity = 0.
  // xdot = Phi · qdot   (local free-DOF space, then mapped to global)
  // ----------------------------------------------------------
  getVelocities() {
    // Nspatial = number of spatial DOFs (same reasoning as getDisplacements).
    // vFree has one entry per spatial DOF: vdot = Phi * qdot.
    const Nspatial = this.freeToGlobal.length;
    const vFree = new Array(Nspatial).fill(0);
    for (let li = 0; li < Nspatial; li++) {          // spatial DOF index (was this.N)
      for (let j = 0; j < this.N; j++) {             // mode index (unchanged)
        vFree[li] += this.Phi[li][j] * this.qdot[j];
      }
    }

    // Build full-length output
    const v = new Array(this.totalN).fill(0);
    for (let li = 0; li < Nspatial; li++) {          // spatial DOF index (was this.N)
      v[this.freeToGlobal[li]] = vFree[li];
    }
    // Fixed masses: velocity is 0 (they are held stationary)
    return v;
  }

  // ----------------------------------------------------------
  // setPhysicalState — set state from physical coordinates.
  //
  // Accepts full-length arrays (indexed by global physics index).
  // Updates stored displacements for fixed masses, then projects
  // the FREE mass values into the modal basis:
  //   q_n = sum_li  Phi[li][n] * m[gi] * x[gi]
  //   where li = local free index, gi = freeToGlobal[li]
  // ----------------------------------------------------------
  setPhysicalState(x, v) {
    // Update stored displacement for any fixed masses present in x.
    for (const [gi] of this.fixedDisplacements) {
      this.fixedDisplacements.set(gi, x[gi]);
    }

    // Project free masses into modal basis: q = Phi^T * M * x_free
    // Nspatial = spatial DOF count (= N for MDOF, = Nx for strings).
    const Nspatial = this.freeToGlobal.length;
    this.q    = new Array(this.N).fill(0);
    this.qdot = new Array(this.N).fill(0);
    for (let i = 0; i < this.N; i++) {                // mode index
      for (let li = 0; li < Nspatial; li++) {         // spatial DOF index (was this.N)
        const gi = this.freeToGlobal[li];             // global physics index
        const m  = this.mdof.masses[gi];
        this.q[i]    += this.Phi[li][i] * m * x[gi];
        this.qdot[i] += this.Phi[li][i] * m * v[gi];
      }
    }
  }

  // ----------------------------------------------------------
  // setFixedDisplacement — update the stored displacement of a fixed mass.
  //
  // Called by HoldTool when a mass is fixed at a non-zero position.
  // Has no effect if the mass is not currently in fixedDisplacements.
  // ----------------------------------------------------------
  setFixedDisplacement(globalIndex, displacement) {
    if (this.fixedDisplacements.has(globalIndex)) {
      this.fixedDisplacements.set(globalIndex, displacement);
    }
  }

  // ----------------------------------------------------------
  // getTotalEnergy — sum of kinetic + potential across all modes.
  // E = Σ [ (1/2)ωₙ²qₙ² + (1/2)q̇ₙ² ]
  // ----------------------------------------------------------
  getTotalEnergy() {
    let total = 0;
    for (let i = 0; i < this.N; i++) {
      total += 0.5 * this.omega[i] * this.omega[i] * this.q[i] * this.q[i]
             + 0.5 * this.qdot[i] * this.qdot[i];
    }
    return total;
  }

  // ----------------------------------------------------------
  // getModalEnergies — per-mode energy array.
  // Used by MassSoundObserver for disorder metric.
  // ----------------------------------------------------------
  getModalEnergies() {
    const energies = [];
    for (let i = 0; i < this.N; i++) {
      energies.push(
        0.5 * this.omega[i] * this.omega[i] * this.q[i] * this.q[i]
      + 0.5 * this.qdot[i] * this.qdot[i]
      );
    }
    return energies;
  }
}
