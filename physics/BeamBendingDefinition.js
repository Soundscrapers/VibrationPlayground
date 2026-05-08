/**
 * BeamBendingDefinition.js
 *
 * Responsibility:
 *   Provide analytical eigenpairs (omega, Phi) for the Euler-Bernoulli
 *   free-free bending beam. Duck-types the ModalState interface so
 *   ModalState can drive bending without modification.
 *
 * NOT allowed to:
 *   Advance time, store modal coordinates, render, or make sound.
 *
 * -------------------------------------------------------------------
 * Interface contract with ModalState:
 *
 *   this.omega        -- length N_elastic -- frequencies (rad/s), all > 0
 *   this.Phi          -- Nx x N_elastic -- mode shapes Phi[spatialIdx][modeIdx]
 *   this.zeta         -- length N_elastic -- modal damping ratios
 *   this.masses       -- length Nx -- lumped segment mass at each point (kg)
 *   this.freeToGlobal -- length Nx -- identity: [0, 1, ..., Nx-1]
 *   this.fixedMasses  -- Set -- always empty (no fixed-DOF masses here)
 *
 * Beam-specific extras (not required by ModalState):
 *   this.N_elastic    -- number of elastic bending modes retained
 *   this.N            -- total mode count = N_elastic (rigid body excluded)
 *   this.Nx           -- number of spatial sample points
 *   this.L            -- beam length (m)
 *   this.E, this.rho, this.h  -- physical parameters
 *   this.A            -- cross-section area = h^2 (m^2)
 *   this.I            -- second moment of area = h^4/12 (m^4)
 *   this.cb           -- sqrt(E*I / (rho*A)) (m^2/s) -- bending wave speed parameter
 *   this.spatialX     -- length Nx -- x-coordinate of each sample point (m)
 *   this.betaL        -- length N_elastic -- beta_n * L eigenvalues (dimensionless)
 * -------------------------------------------------------------------
 *
 * Physical model: Euler-Bernoulli beam equation (free-free)
 *
 *   EI * d^4w/dx^4 + rho*A * d^2w/dt^2 = 0
 *
 * Free-free boundary conditions (zero moment and shear at both ends):
 *   W''(0) = 0, W'''(0) = 0, W''(L) = 0, W'''(L) = 0
 *
 * Frequency equation (transcendental, no closed form):
 *   cos(beta_n * L) * cosh(beta_n * L) = 1
 *
 * Natural frequencies:
 *   omega_n = beta_n^2 * cb    where cb = sqrt(E*I / (rho*A))
 *
 * Frequencies scale as beta^2 ~ n^2 (dispersive, NOT harmonic).
 * This quadratic scaling is the physical reason bars sound metallic.
 *
 * Rigid-body modes:
 *   Free-free beam has TWO rigid-body modes at omega=0 (rigid translation and
 *   rigid rotation). These are EXCLUDED from the eigenpair arrays, following
 *   the same convention as MembraneDefinition: ModalState integrates omega=0
 *   modes as constant-velocity drift (q += qdot*dt), which causes the object
 *   to drift off-screen when any net impulse is applied. Filtering them out
 *   keeps the beam centered while retaining all elastic vibrational modes.
 *
 * Elastic mode shapes (n = 1, 2, ..., N_elastic):
 *   W_n(x) = [cosh(beta_n*x) + cos(beta_n*x)]
 *           - sigma_n * [sinh(beta_n*x) + sin(beta_n*x)]
 *
 *   sigma_n = (cosh(beta_n*L) - cos(beta_n*L)) / (sinh(beta_n*L) - sin(beta_n*L))
 *
 * Mass normalization:
 *   Phi^T * M * Phi = I  (mass-normalized modes)
 *   For each mode: sum_i W_n(x_i)^2 * dm = 1 after scaling by normFactor.
 *   Computed numerically (no closed-form for E-B modes unlike sin/cos strings).
 *
 * Numerical note:
 *   For N_elastic <= 12, beta_n * L <= ~40. cosh(40) ~ 1.2e17 -- within
 *   float64 range. Mode shape formula (cosh+cos) - sigma*(sinh+sin) involves
 *   near-cancellation at interior points for high modes, but residuals are
 *   small (O(e^(-betaL/2))) and sub-pixel after scaling. Visually fine at N<=12.
 */

class BeamBendingDefinition {
  /**
   * @param {Object} cfg
   * @param {number} cfg.length        -- beam length L (m), default 1.0
   * @param {number} cfg.E             -- Young's modulus (Pa), default 7.4e7
   *                                      (soft-plastic value for slow visual;
   *                                      gives bending f1 ~ 2 Hz at L=1m, h=0.02m)
   * @param {number} cfg.rho           -- density (kg/m^3), default 7800 (steel)
   * @param {CrossSection} cfg.crossSection -- cross-section object, default square h=0.02
   * @param {number} cfg.modes         -- elastic bending modes to retain, default 12
   *                                      (cap at 12: beyond this, cosh/sinh precision degrades)
   * @param {number} cfg.spatialPoints -- interior sample count Nx, default 100
   * @param {Object} cfg.damping       -- { base, freqScale }
   *                                      zeta_n = base + freqScale * n
   * @param {string} cfg.bendingAxis   -- 'y' (default) or 'z'.
   *                                      'y' = bending in the y-direction, uses crossSection.I
   *                                           (depth resists y-bending: tall bar is stiffer).
   *                                      'z' = bending in the z-direction, uses crossSection.I_lateral
   *                                           (width resists z-bending: wide bar is stiffer).
   *                                      For isotropic sections (square, circle, tube): I = I_lateral,
   *                                      so the two axes have identical frequencies.
   *                                      For rectangle: I != I_lateral -- two-axis bending produces
   *                                      distinct pitches for the strong and weak axes.
   */
  constructor(cfg = {}) {

    // --- Physical parameters ---
    this.L   = cfg.length        || 1.0;     // beam length (m)
    this.E   = cfg.E             || 7.4e7;   // Young's modulus (Pa)
    this.rho = cfg.rho           || 7800;    // density (kg/m^3)

    // bendingAxis: which plane this definition governs.
    // 'y' (default): vertical bending, uses I (depth-axis second moment).
    // 'z': lateral bending, uses I_lateral (width-axis second moment).
    this.bendingAxis = cfg.bendingAxis || 'y';

    // Cross-section: encapsulates A, I, I_lateral, and vertex geometry.
    // Defaults to a square solid with h=0.02m.
    this.crossSection = cfg.crossSection || new CrossSection('square', { h: 0.02 });
    this.A = this.crossSection.A;
    // Select I based on bending axis.
    this.I = (this.bendingAxis === 'z') ? this.crossSection.I_lateral : this.crossSection.I;

    // Number of ELASTIC bending modes to retain.
    // Total ModalState modes = N_elastic (rigid body excluded).
    this.N_elastic = cfg.modes         || 12;
    this.Nx        = cfg.spatialPoints || 100;

    // Damping: zeta_n = base + freqScale * n.
    // Larger freqScale --> higher modes decay faster (approx. structural damping).
    this._dampBase      = (cfg.damping && cfg.damping.base      != null) ? cfg.damping.base      : 0.01;
    this._dampFreqScale = (cfg.damping && cfg.damping.freqScale != null) ? cfg.damping.freqScale : 0.002;

    // --- Interface arrays (populated by recompute) ---
    this.omega        = [];   // length N_elastic (all elastic, no omega=0 entries)
    this.Phi          = [];   // Nx x N_elastic
    this.zeta         = [];   // length N_elastic
    this.masses       = [];   // length Nx, all equal to dm = rho*A*h_grid
    this.spatialX     = [];   // length Nx -- x-coordinates (m)
    this.freeToGlobal = [];   // identity [0, 1, ..., Nx-1]
    this.fixedMasses  = new Set();   // always empty

    // Computed beam constants (set by recompute):
    this.cb    = 0;   // bending wave parameter sqrt(EI/(rho*A)) (m^2/s)
    this.betaL = [];  // beta_n * L for each elastic mode (dimensionless)
    this.N     = 0;   // total mode count = N_elastic

    this.recompute();
  }

  // ------------------------------------------------------------------
  // spatialSize -- returns Nx (total spatial DOF count).
  // Mirrors the interface used by interaction controllers and observers.
  // ------------------------------------------------------------------
  spatialSize() {
    return this.Nx;
  }

  // ------------------------------------------------------------------
  // size -- returns N (total elastic mode count).
  // ------------------------------------------------------------------
  size() {
    return this.N;
  }

  // ------------------------------------------------------------------
  // setDamping -- update base damping and rewrite this.zeta in place.
  //
  // Does NOT recompute eigenpairs -- omega and Phi are unchanged.
  // ModalState.step() reads this.zeta each frame, so new values take
  // effect immediately on the next physics step.
  // ------------------------------------------------------------------
  setDamping(base) {
    this._dampBase = Math.max(0, base);
    for (let n = 0; n < this.zeta.length; n++) {
      this.zeta[n] = this._dampBase + this._dampFreqScale * n;
    }
  }

  // ------------------------------------------------------------------
  // setCrossSection -- swap to a new cross-section and recompute.
  //
  // Updates this.A and this.I from the new CrossSection, then calls
  // recompute() to rebuild omega and Phi with new frequencies.
  // Mode shapes are unchanged (beta_n values depend on L only, not A/I).
  // Only the frequencies change: omega_n = beta_n^2 * sqrt(EI/(rho*A)).
  //
  // Caller (beam-sketch.js _onCrossSectionChange) must reset both
  // ModalStates to rest after this call.
  //
  // @param {CrossSection} cs -- new cross-section object
  // ------------------------------------------------------------------
  setCrossSection(cs) {
    this.crossSection = cs;
    this.A = cs.A;
    // Use I or I_lateral depending on which bending axis this definition governs.
    this.I = (this.bendingAxis === 'z') ? cs.I_lateral : cs.I;
    this.recompute();
  }

  // ------------------------------------------------------------------
  // recompute -- rebuild all derived quantities from current parameters.
  //
  // Call after changing: L, E, rho, h, N_elastic, Nx, or damping.
  //
  // IMPORTANT: replaces omega, Phi, zeta arrays (new references).
  // ModalState.step() checks `this.omega !== this.mdof.omega` to detect
  // changes and triggers auto-rebuild. A new array reference fires it.
  // ------------------------------------------------------------------
  recompute() {
    const L         = this.L;
    const E         = this.E;
    const rho       = this.rho;
    const N_elastic = this.N_elastic;
    const Nx        = this.Nx;
    // N_total = elastic modes only. Rigid body modes (omega=0) are excluded
    // to prevent the beam from drifting off-screen under impulse loading.
    // See MembraneDefinition._modeList() for the same design decision.
    const N_total   = N_elastic;

    this.N = N_total;

    // --- Cross-section constants from CrossSection object ---
    // A = cross-section area (m^2), I = second moment of area (m^4).
    // cb = sqrt(E*I / (rho*A)) (m^2/s): bending wave speed parameter.
    //   omega_n = beta_n^2 * cb.
    // A and I depend on cross-section type and parameters (set by setCrossSection).
    const A  = this.A;
    const I  = this.I;
    const cb = Math.sqrt(E * I / (rho * A));

    this.A  = A;
    this.I  = I;
    this.cb = cb;

    // --- Spatial grid: Nx interior points uniformly spaced in (0, L) ---
    // x_i = (i+1) * h_grid,  h_grid = L / (Nx+1)
    // Same convention as StringDefinition: open endpoints (x=0 and x=L excluded).
    const h_grid   = L / (Nx + 1);   // spacing between interior points (m)
    const spatialX = new Array(Nx);
    for (let i = 0; i < Nx; i++) {
      spatialX[i] = (i + 1) * h_grid;
    }
    this.spatialX = spatialX;

    // Identity mapping: all Nx spatial points are free DOFs.
    this.freeToGlobal = Array.from({ length: Nx }, (_, i) => i);
    this.fixedMasses  = new Set();

    // --- Lumped segment masses ---
    // Each interior point represents a segment of length h_grid.
    // dm = rho * A * h_grid (kg): mass of one beam segment.
    const dm = rho * A * h_grid;
    this.masses = new Array(Nx).fill(dm);

    // --- Find beta_n * L eigenvalues via Newton-Raphson ---
    //
    // The frequency equation for free-free E-B beam:
    //   f(x) = cos(x) * cosh(x) - 1 = 0   where x = beta_n * L
    //
    // Derivative:
    //   f'(x) = -sin(x) * cosh(x) + cos(x) * sinh(x)
    //
    // Starting guesses:
    //   n=1: 4.7300 (known exact to 4 significant figures)
    //   n=2: 7.8532 (known exact to 4 significant figures)
    //   n>=3: (n + 0.5) * pi  (asymptotic, error < 0.01% for n>=3)
    const betaL_start = [4.7300, 7.8532];
    const betaL = new Array(N_elastic);

    for (let n = 0; n < N_elastic; n++) {
      // Initial guess: use hardcoded for n=0,1 (modes 1,2); asymptotic for rest.
      let x = (n < 2) ? betaL_start[n] : ((n + 1) + 0.5) * Math.PI;

      // Newton-Raphson: x_new = x - f(x) / f'(x), iterate until |dx| < 1e-12.
      for (let iter = 0; iter < 20; iter++) {
        const cosX  = Math.cos(x);
        const sinX  = Math.sin(x);
        const coshX = Math.cosh(x);
        const sinhX = Math.sinh(x);
        const f     = cosX * coshX - 1;              // should converge to 0
        const fp    = -sinX * coshX + cosX * sinhX;  // derivative
        const dx    = f / fp;
        x -= dx;
        if (Math.abs(dx) < 1e-12) break;             // converged to float64 precision
      }
      betaL[n] = x;
    }
    this.betaL = betaL;

    // --- Allocate output arrays ---
    // omega: length N_total = N_elastic (no rigid body modes)
    // Phi:   Nx rows x N_total columns -- Phi[spatialIdx][modeIdx]
    // Phi_dd: Nx rows x N_elastic columns -- second spatial derivative of each mode shape.
    //   Used by Rayleigh-Ritz to build the stiffness matrix for tapered beams.
    const omega  = new Array(N_total);
    const Phi    = new Array(Nx);
    const Phi_dd = new Array(Nx);
    for (let i = 0; i < Nx; i++) {
      Phi[i]    = new Array(N_total).fill(0);
      Phi_dd[i] = new Array(N_elastic).fill(0);
    }

    // --- Elastic bending modes n = 1, 2, ..., N_elastic ---
    // Stored at Phi column indices 0, 1, ..., N_elastic-1.
    // (No rigid body modes at index 0 or 1 -- they are excluded.)
    for (let n = 0; n < N_elastic; n++) {
      const bL    = betaL[n];        // beta_n * L (dimensionless)
      const beta  = bL / L;          // beta_n (rad/m): spatial wavenumber for mode n

      // Natural frequency: omega_n = beta_n^2 * cb (rad/s)
      // Scales as beta^2 ~ n^2 (dispersive, not harmonic)
      omega[n] = beta * beta * cb;

      // Sigma coefficient: ensures free-end boundary conditions are satisfied.
      //   sigma_n = (cosh(beta*L) - cos(beta*L)) / (sinh(beta*L) - sin(beta*L))
      // For large n: sigma_n --> 1 (coth(beta*L) -> 1 as beta*L -> infinity).
      const cBL   = Math.cos(bL);
      const sBL   = Math.sin(bL);
      const chBL  = Math.cosh(bL);
      const shBL  = Math.sinh(bL);
      const sigma = (chBL - cBL) / (shBL - sBL);

      // Mode shape at each interior point:
      //   W_n(x) = [cosh(beta*x) + cos(beta*x)] - sigma * [sinh(beta*x) + sin(beta*x)]
      //
      // The cosh + cos terms are symmetric about x=L/2.
      // The sinh + sin terms are antisymmetric.
      // sigma blends them to satisfy the free boundary conditions at x=L.
      const W    = new Array(Nx);
      const W_dd = new Array(Nx);   // second spatial derivative of W_n(x)
      for (let i = 0; i < Nx; i++) {
        const bx = beta * spatialX[i];   // beta_n * x_i (radians)
        W[i]    = (Math.cosh(bx) + Math.cos(bx)) - sigma * (Math.sinh(bx) + Math.sin(bx));
        // Second derivative of W_n(x):
        //   W_n''(x) = beta^2 * [(cosh(beta*x) - cos(beta*x))
        //                        - sigma*(sinh(beta*x) - sin(beta*x))]
        // Derived from d^2/dx^2 of cosh(beta*x) = beta^2*cosh(beta*x), etc.
        // Sign flip for cosine: d^2/dx^2 cos(beta*x) = -beta^2*cos(beta*x)
        // Sign flip for sine:   d^2/dx^2 sin(beta*x) = -beta^2*sin(beta*x)
        W_dd[i] = beta * beta * (
          (Math.cosh(bx) - Math.cos(bx)) - sigma * (Math.sinh(bx) - Math.sin(bx))
        );
      }

      // Numerical mass normalization: scale so sum_i W[i]^2 * dm = 1.
      // This satisfies Phi^T * M * Phi = I for this mode column.
      let sumSq = 0;
      for (let i = 0; i < Nx; i++) {
        sumSq += W[i] * W[i] * dm;
      }
      const normFac = 1.0 / Math.sqrt(sumSq);

      for (let i = 0; i < Nx; i++) {
        Phi[i][n]    = W[i]    * normFac;
        // Apply the same normalization factor to the second derivative.
        // Since W_dd is linear in W (same normFac scales both).
        Phi_dd[i][n] = W_dd[i] * normFac;
      }
    }

    // Store: assigning new array references triggers ModalState auto-rebuild.
    this.omega = omega;
    this.Phi   = Phi;

    // --- Modal damping ---
    // zeta_n = _dampBase + _dampFreqScale * n
    // All entries are elastic modes. n=0 is the first elastic mode (lowest frequency).
    const zeta = new Array(N_total);
    for (let n = 0; n < N_total; n++) {
      zeta[n] = this._dampBase + this._dampFreqScale * n;
    }
    this.zeta = zeta;

    // --- Cache uniform (prismatic) results for Rayleigh-Ritz ---
    // Rayleigh-Ritz uses the uniform mode shapes as trial functions.
    // We cache them here so _runRayleighRitz() can access them without
    // re-running the uniform calculation.
    this.Phi_uniform   = Phi;      // uniform (prismatic) mode shapes
    this.omega_uniform = omega;    // uniform natural frequencies
    this.Phi_dd        = Phi_dd;   // second spatial derivatives of uniform modes

    // --- Taper profile initialization ---
    // taperPoints: 5 control points along the normalized beam axis (xNorm = 0..1).
    // scale=1.0 everywhere means uniform (prismatic) beam -- no taper.
    // Only initialize if not already set (preserves user edits across recompute calls
    // triggered by material or cross-section changes).
    if (!this.taperPoints) {
      this.taperPoints = [
        { xNorm: 0.0,  scale: 1.0 },
        { xNorm: 0.25, scale: 1.0 },
        { xNorm: 0.5,  scale: 1.0 },
        { xNorm: 0.75, scale: 1.0 },
        { xNorm: 1.0,  scale: 1.0 }
      ];
    }

    // scaleProfile: per-slice linear interpolation of taperPoints.
    // scale[p] = cross-section scale factor at spatial index p.
    this.scaleProfile = new Array(Nx).fill(1.0);

    // A_profile and I_profile: scaled cross-section properties at each slice.
    // A_profile[p] = A * scale^2  (area scales as length^2)
    // I_profile[p] = I * scale^4  (second moment scales as length^4)
    this.A_profile = new Array(Nx).fill(A);
    this.I_profile = new Array(Nx).fill(I);

    // If taper is active, compute the tapered eigenpairs via Rayleigh-Ritz.
    // This overwrites this.omega and this.Phi with Ritz-corrected values.
    if (this._taperIsActive()) {
      this._recomputeProfiles();
      this._runRayleighRitz();
    }
  }

  // ------------------------------------------------------------------
  // _taperIsActive -- returns true if any taperPoint has scale != 1.0.
  //
  // Used to skip the (expensive) Rayleigh-Ritz step when the beam is uniform.
  // Threshold 1e-6 handles floating-point noise from slider drag.
  // ------------------------------------------------------------------
  _taperIsActive() {
    if (!this.taperPoints) return false;
    for (const pt of this.taperPoints) {
      if (Math.abs(pt.scale - 1.0) > 1e-6) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------
  // setTaperProfile -- update the taper control points and recompute.
  //
  // @param {Array} points -- array of { xNorm, scale } objects,
  //   sorted by xNorm from 0 to 1. Typically 5 points from the editor.
  //
  // Updates scaleProfile by linear interpolation, then either runs
  // Rayleigh-Ritz (if taper is active) or restores the uniform eigenpairs.
  // Assigning new omega and Phi references triggers ModalState auto-rebuild.
  // ------------------------------------------------------------------
  setTaperProfile(points) {
    this.taperPoints = points;
    const Nx = this.Nx;
    const L  = this.L;

    // Build scaleProfile: for each spatial index p, interpolate scale from taperPoints.
    for (let p = 0; p < Nx; p++) {
      // xNorm: normalized position of this spatial point (0 = left end, 1 = right end).
      // spatialX[p] runs from h_grid to (Nx)*h_grid inside (0, L).
      const xNorm = this.spatialX[p] / L;

      // Linear interpolation between adjacent control points.
      let s = 1.0;
      for (let j = 0; j < points.length - 1; j++) {
        if (xNorm <= points[j + 1].xNorm) {
          // This segment contains xNorm. Interpolate linearly.
          const t = (xNorm - points[j].xNorm) / (points[j + 1].xNorm - points[j].xNorm);
          s = points[j].scale + t * (points[j + 1].scale - points[j].scale);
          break;
        }
        // If we exhaust all but the last segment, clamp to last point.
        if (j === points.length - 2) s = points[points.length - 1].scale;
      }
      this.scaleProfile[p] = s;
    }

    if (this._taperIsActive()) {
      // Taper is active: recompute profiles and run Rayleigh-Ritz.
      this._recomputeProfiles();
      this._runRayleighRitz();
    } else {
      // All scales are 1.0: restore uniform (prismatic) eigenpairs.
      // Assign new array references to trigger ModalState auto-rebuild.
      this.omega     = this.omega_uniform.slice();
      this.Phi       = this.Phi_uniform.map(row => row.slice());
      this.N         = this.omega.length;
      this.A_profile = new Array(Nx).fill(this.A);
      this.I_profile = new Array(Nx).fill(this.I);
      this._updateMasses();
      // Rebuild zeta for the (restored) uniform mode count.
      const zeta = new Array(this.N);
      for (let n = 0; n < this.N; n++) {
        zeta[n] = this._dampBase + this._dampFreqScale * n;
      }
      this.zeta = zeta;
    }
  }

  // ------------------------------------------------------------------
  // _recomputeProfiles -- compute A_profile and I_profile from scaleProfile.
  //
  // A_profile[p] = A * scale^2  (area is proportional to length^2)
  // I_profile[p] = I * scale^4  (second moment is proportional to length^4)
  //
  // For a square cross-section scaled by s: side = h*s, A = (h*s)^2 = A*s^2,
  // I = (h*s)^4/12 = I*s^4.
  // For a circle scaled by s: A = pi*(r*s)^2 = A*s^2, I = pi*(r*s)^4/4 = I*s^4.
  // ------------------------------------------------------------------
  _recomputeProfiles() {
    const A  = this.A;
    const I  = this.I;
    const Nx = this.Nx;
    for (let p = 0; p < Nx; p++) {
      const s        = this.scaleProfile[p];
      const s2       = s * s;
      const s4       = s2 * s2;
      this.A_profile[p] = A * s2;
      this.I_profile[p] = I * s4;
    }
  }

  // ------------------------------------------------------------------
  // _updateMasses -- update lumped masses from A_profile.
  //
  // Each interior slice represents a segment of length h_grid.
  // dm_p = rho * A_profile[p] * h_grid.
  // Called after _runRayleighRitz() so the mass observer sees the tapered geometry.
  // ------------------------------------------------------------------
  _updateMasses() {
    const rho    = this.rho;
    const h_grid = this.L / (this.Nx + 1);
    for (let p = 0; p < this.Nx; p++) {
      this.masses[p] = rho * this.A_profile[p] * h_grid;
    }
  }

  // ------------------------------------------------------------------
  // _runRayleighRitz -- compute tapered beam eigenpairs via Rayleigh-Ritz.
  //
  // Uses the uniform (prismatic) mode shapes Phi_uniform as trial functions.
  // Builds reduced stiffness K and mass M matrices in the modal basis, then
  // solves the generalized eigenproblem K*x = lambda*M*x for the tapered modes.
  //
  // Physical integrals (discretized as sums over Nx slices, dx = h_grid):
  //   K[i][j] = integral_0^L E * I(x) * Phi_dd_i(x) * Phi_dd_j(x) dx
  //   M[i][j] = integral_0^L rho * A(x) * Phi_i(x) * Phi_j(x) dx
  //
  // Rayleigh-Ritz gives the best approximation to the true tapered modes
  // within the subspace spanned by the uniform trial functions.
  //
  // After solving: new Phi = linear combination of uniform Phi_uniform columns.
  // New omega = sqrt(lambda) for each retained eigenpair.
  // ------------------------------------------------------------------
  _runRayleighRitz() {
    const Nx      = this.Nx;
    const N       = this.N_elastic;   // number of trial functions = number of uniform modes
    const E       = this.E;
    const rho     = this.rho;
    const h_grid  = this.L / (Nx + 1);   // spatial integration step (m)
    const dx      = h_grid;              // integration weight

    const Phi_u  = this.Phi_uniform;   // uniform mode shapes: Phi_u[p][n]
    const Phi_dd = this.Phi_dd;        // uniform 2nd derivatives: Phi_dd[p][n]
    const I_prof = this.I_profile;     // per-slice second moment: I_prof[p]
    const A_prof = this.A_profile;     // per-slice area: A_prof[p]

    // --- Build stiffness matrix K (N x N) ---
    // K[i][j] = sum_p  E * I_profile[p] * Phi_dd[p][i] * Phi_dd[p][j] * dx
    // K is symmetric: compute upper triangle, then mirror to lower.
    const K = [];
    for (let i = 0; i < N; i++) {
      K.push(new Array(N).fill(0));
    }
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        let sum = 0;
        for (let p = 0; p < Nx; p++) {
          sum += E * I_prof[p] * Phi_dd[p][i] * Phi_dd[p][j] * dx;
        }
        K[i][j] = sum;
        K[j][i] = sum;   // mirror lower triangle
      }
    }

    // --- Build mass matrix M (N x N) ---
    // M[i][j] = sum_p  rho * A_profile[p] * Phi_uniform[p][i] * Phi_uniform[p][j] * dx
    const M = [];
    for (let i = 0; i < N; i++) {
      M.push(new Array(N).fill(0));
    }
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        let sum = 0;
        for (let p = 0; p < Nx; p++) {
          sum += rho * A_prof[p] * Phi_u[p][i] * Phi_u[p][j] * dx;
        }
        M[i][j] = sum;
        M[j][i] = sum;   // mirror lower triangle
      }
    }

    // --- Solve generalized eigenproblem: K * x = lambda * M * x ---
    // Converted to standard form: (M^-1 * K) * x = lambda * x
    // Then symmetrized to ensure real eigenvalues despite floating-point errors.
    const mathM    = math.matrix(M);
    const mathK    = math.matrix(K);
    const Minv     = math.inv(mathM);            // M^-1 (N x N)
    const A_mat    = math.multiply(Minv, mathK); // M^-1 * K (N x N)
    // Symmetrize: A_sym = (A + A^T) / 2  -- removes any asymmetry from numerical noise.
    const A_mat_T  = math.transpose(A_mat);
    const A_sym    = math.multiply(math.add(A_mat, A_mat_T), 0.5);

    // math.eigs returns { values: [...], eigenvectors: [{value, vector}, ...] }
    const result   = math.eigs(A_sym);

    // --- Extract and sort eigenpairs ---
    // Clamp negative eigenvalues rather than discarding them.
    // Discarding would shrink pairs.length below N, so this.N would change and
    // BeamSoundObserver would access omega[n] beyond the array --> NaN --> Tone.js crash.
    // Clamp floor = first uniform bending eigenvalue squared: any numerically-negative
    // eigenpair gets the fundamental's frequency, not a near-zero DC drift.
    const MIN_LAMBDA = this.omega_uniform[0] * this.omega_uniform[0];
    const pairs = [];
    for (const ev of result.eigenvectors) {
      // ev.value may be a complex object {re, im} or a plain number.
      const rawLam = (typeof ev.value === 'object') ? ev.value.re : Number(ev.value);
      const lam    = Math.max(MIN_LAMBDA, rawLam);   // clamp: no filtering
      // ev.vector may be a math.js DenseMatrix; convert to plain array if needed.
      const vec = Array.isArray(ev.vector) ? ev.vector : ev.vector.toArray();
      pairs.push({ lambda: lam, vec });
    }
    // Sort ascending by eigenvalue (lowest frequency first).
    // pairs.length === N always (no filtering), so this.N remains fixed at N_elastic.
    pairs.sort((a, b) => a.lambda - b.lambda);

    // --- Build new Phi_new (Nx x pairs.length) ---
    // Phi_new[p][k] = sum_n Phi_uniform[p][n] * pairs[k].vec[n]
    // Each new mode shape is a linear combination of the uniform trial functions.
    const Phi_new = new Array(Nx);
    for (let p = 0; p < Nx; p++) {
      Phi_new[p] = new Array(pairs.length).fill(0);
    }
    for (let p = 0; p < Nx; p++) {
      for (let k = 0; k < pairs.length; k++) {
        let sum = 0;
        for (let n = 0; n < N; n++) {
          sum += Phi_u[p][n] * pairs[k].vec[n];
        }
        Phi_new[p][k] = sum;
      }
    }

    // --- Mass-normalize Phi_new w.r.t. the tapered mass distribution ---
    //
    // ModalState.setPhysicalState() projects as  q = Phi^T * M_taper * x,
    // and reconstructs as  x = Phi * q.  This is only exact when modes are
    // mass-normalized:  sum_p rho * A_profile[p] * Phi[p][k]^2 * dx = 1.
    //
    // Phi_new = Phi_uniform * V  where V are standard eigenvectors (V^T * V = I).
    // Phi_uniform is normalized for the UNIFORM mass matrix, NOT for M_taper.
    // So Phi_new is not yet normalized; the normalization step below corrects this.
    //
    // Without this, energy is over/under-allocated to each mode on projection,
    // causing the beam to deform indefinitely after a single strike.
    for (let k = 0; k < pairs.length; k++) {
      // Modal mass: mm = sum_p rho * A_profile[p] * Phi_new[p][k]^2 * dx
      let mm = 0;
      for (let p = 0; p < Nx; p++) {
        mm += rho * A_prof[p] * Phi_new[p][k] * Phi_new[p][k] * dx;
      }
      // Scale each spatial component by 1/sqrt(mm) to achieve mm = 1.
      // Guard against degenerate modes (mm near zero).
      const normScale = (mm > 1e-20) ? (1.0 / Math.sqrt(mm)) : 1.0;
      for (let p = 0; p < Nx; p++) {
        Phi_new[p][k] *= normScale;
      }
    }

    // --- Assign new references (new arrays trigger ModalState auto-rebuild) ---
    this.omega = pairs.map(p => Math.sqrt(p.lambda));   // omega_k = sqrt(lambda_k)
    this.Phi   = Phi_new;
    this.N     = pairs.length;

    // Update lumped masses to reflect the tapered cross-section area.
    this._updateMasses();

    // Rebuild zeta for the new (possibly smaller) mode count.
    const zeta = new Array(pairs.length);
    for (let n = 0; n < pairs.length; n++) {
      zeta[n] = this._dampBase + this._dampFreqScale * n;
    }
    this.zeta = zeta;
  }
}


// ------------------------------------------------------------------
// VERIFICATION SNIPPET (paste into browser console after page loads).
//
// Checks:
//   1. First 5 beta*L values against known exact roots.
//   2. Phi^T * M * Phi = I (orthonormality max error).
//   3. Bending frequency ratios (dispersive: f2/f1 = 2.757, f3/f1 = 5.404).
//
// function verifyBeamBending() {
//   const bd = new BeamBendingDefinition({ modes: 12, spatialPoints: 100 });
//   const known = [4.7300, 7.8532, 10.9956, 14.1372, 17.2788];
//   console.log('--- beta*L roots ---');
//   for (let n = 0; n < 5; n++) {
//     console.log('  n=' + (n+1) + '  computed=' + bd.betaL[n].toFixed(4)
//       + '  known=' + known[n] + '  err=' + Math.abs(bd.betaL[n] - known[n]).toExponential(1));
//   }
//   const N = bd.N; const Nx = bd.Nx;
//   let maxErr = 0;
//   for (let j = 0; j < N; j++) {
//     for (let k = 0; k < N; k++) {
//       let sum = 0;
//       for (let i = 0; i < Nx; i++) sum += bd.Phi[i][j] * bd.masses[i] * bd.Phi[i][k];
//       maxErr = Math.max(maxErr, Math.abs(sum - (j === k ? 1 : 0)));
//     }
//   }
//   console.log('Orthonormality max error:', maxErr.toExponential(2), '(should be < 0.01)');
//   const f1 = bd.omega[0], f2 = bd.omega[1], f3 = bd.omega[2];
//   console.log('Frequency ratios: f2/f1=' + (f2/f1).toFixed(3)
//     + '  f3/f1=' + (f3/f1).toFixed(3) + '  (expect 2.757, 5.404)');
// }
// ------------------------------------------------------------------
