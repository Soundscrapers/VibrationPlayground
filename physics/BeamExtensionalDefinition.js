/**
 * BeamExtensionalDefinition.js
 *
 * Responsibility:
 *   Provide analytical eigenpairs (omega, Phi) for longitudinal (extensional)
 *   waves in a free-free rod. Duck-types the ModalState interface.
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
 *   this.fixedMasses  -- Set -- always empty
 *
 * Beam-specific extras:
 *   this.N_elastic -- number of elastic extensional modes retained
 *   this.N         -- total mode count = N_elastic (rigid body excluded)
 *   this.Nx        -- number of spatial sample points
 *   this.L         -- beam length (m)
 *   this.c_ext     -- extensional wave speed sqrt(E/rho) (m/s)
 *   this.spatialX  -- length Nx -- x-coordinates (m)
 * -------------------------------------------------------------------
 *
 * Physical model: 1D wave equation (free-free rod, longitudinal)
 *
 *   EA * d^2u/dx^2 = rho*A * d^2u/dt^2
 *
 * Simplifies to:
 *   d^2u/dx^2 = (1/c_ext^2) * d^2u/dt^2
 *   where c_ext = sqrt(E/rho) [m/s] -- bar wave speed (extensional)
 *
 * This is IDENTICAL in form to the string wave equation.
 * Free-free boundary conditions: du/dx(0,t) = 0, du/dx(L,t) = 0.
 * (Zero axial stress at both ends.)
 *
 * Mode shapes (same as free-free string but using rho*A as linear density):
 *   Mode 0 (rigid body): phi_0(x) = 1/sqrt(rho*A*L)       omega_0 = 0
 *   Mode n (n>=1):       phi_n(x) = sqrt(2/(rho*A*L)) * cos(n*pi*x/L)
 *                        omega_n = n * pi * c_ext / L
 *
 * Spectrum: HARMONIC (integer ratios, same as a string). Non-dispersive.
 * For default parameters (E=7.4e7, rho=7800, L=1m):
 *   c_ext = sqrt(7.4e7 / 7800) = 97.4 m/s
 *   f1 = 97.4 / (2*1) = 48.7 Hz (visual physics time)
 *
 * The rigid-body mode at omega=0 (uniform axial translation) is EXCLUDED,
 * following the same convention as MembraneDefinition and BeamBendingDefinition:
 * omega=0 modes drift without bound under any net impulse and cause the beam
 * to leave the screen. Only elastic modes (n >= 1) are retained.
 *
 * Normalization convention (elastic modes only, rigid body excluded):
 *   rho_linear = rho * A = rho * h^2 (mass per unit length, kg/m)
 *   normCos = sqrt(2 / (rho_linear * L))
 *   Same formula as StringDefinition free-free cos modes, substituting mu = rho*A.
 */

class BeamExtensionalDefinition {
  /**
   * @param {Object} cfg
   * @param {number} cfg.length        -- beam length L (m), default 1.0
   * @param {number} cfg.E             -- Young's modulus (Pa), default 7.4e7
   * @param {number} cfg.rho           -- density (kg/m^3), default 7800 (steel)
   * @param {CrossSection} cfg.crossSection -- cross-section object, default square h=0.02
   * @param {number} cfg.modes         -- elastic extensional modes to retain, default 8
   * @param {number} cfg.spatialPoints -- interior sample count Nx, default 100
   *                                      (should match BeamBendingDefinition.Nx for
   *                                      shared spatial grid)
   * @param {Object} cfg.damping       -- { base, freqScale }
   *                                      zeta_n = base + freqScale * n
   */
  constructor(cfg = {}) {

    // --- Physical parameters ---
    this.L   = cfg.length        || 1.0;     // beam length (m)
    this.E   = cfg.E             || 7.4e7;   // Young's modulus (Pa)
    this.rho = cfg.rho           || 7800;    // density (kg/m^3)

    // Cross-section: encapsulates A (area) and I (second moment).
    // Extensional frequencies are independent of cross-section (c_ext = sqrt(E/rho)).
    // Only the lumped masses change with A, affecting modal energy distribution.
    this.crossSection = cfg.crossSection || new CrossSection('square', { h: 0.02 });
    this.A = this.crossSection.A;   // cross-section area (m^2)

    // Number of ELASTIC extensional modes.
    // Total ModalState modes = N_elastic (rigid body excluded).
    this.N_elastic = cfg.modes         || 8;
    this.Nx        = cfg.spatialPoints || 100;

    // Damping: zeta_n = base + freqScale * n.
    this._dampBase      = (cfg.damping && cfg.damping.base      != null) ? cfg.damping.base      : 0.005;
    this._dampFreqScale = (cfg.damping && cfg.damping.freqScale != null) ? cfg.damping.freqScale : 0.001;

    // --- Interface arrays (populated by recompute) ---
    this.omega        = [];
    this.Phi          = [];
    this.zeta         = [];
    this.masses       = [];
    this.spatialX     = [];
    this.freeToGlobal = [];
    this.fixedMasses  = new Set();

    // Derived:
    this.c_ext = 0;   // extensional wave speed sqrt(E/rho) (m/s) -- independent of A
    this.N     = 0;   // total mode count = N_elastic

    this.recompute();
  }

  // ------------------------------------------------------------------
  // spatialSize -- returns Nx.
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
  // setDamping -- update base damping ratio, rewrite zeta in place.
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
  // Extensional frequencies are independent of cross-section: c_ext = sqrt(E/rho).
  // Only the lumped masses (dm = rho * A * h_grid) change.
  // recompute() rebuilds the masses array with the new A.
  //
  // Caller (beam-sketch.js _onCrossSectionChange) resets ModalState to rest.
  //
  // @param {CrossSection} cs -- new cross-section object
  // ------------------------------------------------------------------
  setCrossSection(cs) {
    this.crossSection = cs;
    this.A = cs.A;
    this.recompute();
  }

  // ------------------------------------------------------------------
  // recompute -- rebuild all derived quantities from current parameters.
  //
  // Call after changing: L, E, rho, crossSection, N_elastic, Nx, or damping.
  // Replaces omega, Phi, zeta arrays (new references) to trigger
  // ModalState auto-rebuild on next step() call.
  // ------------------------------------------------------------------
  recompute() {
    const L         = this.L;
    const E         = this.E;
    const rho       = this.rho;
    const N_elastic = this.N_elastic;
    const Nx        = this.Nx;
    // N_total = elastic modes only. Rigid body (omega=0) excluded to prevent drift.
    const N_total   = N_elastic;

    this.N = N_total;

    // --- Wave speed ---
    // c_ext = sqrt(E/rho)  [m/s]
    // For steel (E=200e9, rho=7800): c_ext = 5064 m/s (too fast to see visually)
    // For default slow-physics E=7.4e7, rho=7800: c_ext = 97.4 m/s (visible as mode patterns)
    const c_ext = Math.sqrt(E / rho);
    this.c_ext = c_ext;

    // Linear density: rho_linear = rho * A (kg/m).
    // A comes from the current CrossSection object (set in constructor or setCrossSection).
    const A           = this.A;
    const rho_linear  = rho * A;

    // --- Spatial grid: Nx interior points uniformly spaced in (0, L) ---
    // Identical convention to BeamBendingDefinition.
    // x_i = (i+1) * h_grid,  h_grid = L / (Nx + 1)
    const h_grid   = L / (Nx + 1);
    const spatialX = new Array(Nx);
    for (let i = 0; i < Nx; i++) {
      spatialX[i] = (i + 1) * h_grid;
    }
    this.spatialX = spatialX;

    this.freeToGlobal = Array.from({ length: Nx }, (_, i) => i);
    this.fixedMasses  = new Set();

    // --- Lumped segment masses ---
    // dm = rho_linear * h_grid = rho * A * h_grid (kg)
    // This matches BeamBendingDefinition's dm exactly (same rho, A, h_grid).
    const dm = rho_linear * h_grid;
    this.masses = new Array(Nx).fill(dm);

    // --- Normalization factor ---
    // For mass-normalized cos modes (Phi^T * M * Phi = I):
    //   integral_0^L normCos^2 * cos^2(k_n*x) * rho_linear dx = normCos^2 * rho_linear * L/2 = 1
    //   --> normCos = sqrt(2 / (rho_linear * L))
    const normCos = Math.sqrt(2.0 / (rho_linear * L));

    // --- Allocate output arrays ---
    // N_total = N_elastic (rigid body excluded).
    // Phi_d: Nx rows x N_elastic columns -- first spatial derivative of each mode.
    //   Used by Rayleigh-Ritz to build the extensional stiffness matrix for tapered rods.
    const omega = new Array(N_total);
    const Phi   = new Array(Nx);
    const Phi_d = new Array(Nx);   // first derivatives: Phi_d[p][modeIdx]
    for (let i = 0; i < Nx; i++) {
      Phi[i]   = new Array(N_total).fill(0);
      Phi_d[i] = new Array(N_elastic).fill(0);
    }

    // --- Elastic modes n = 1, 2, ..., N_elastic: cosine series ---
    // Stored at Phi column indices 0, 1, ..., N_elastic-1.
    // phi_n(x) = normCos * cos(n*pi*x/L)
    //   d/dx cos(k*x)|_{x=0} = -k*sin(0) = 0  (free left end ok)
    //   d/dx cos(k*x)|_{x=L} = -k*sin(n*pi) = 0  (free right end ok)
    //
    // omega_n = n * pi * c_ext / L  (harmonic series -- integer ratios)
    //
    // First derivative:
    //   d/dx [ normCos * cos(n*pi*x/L) ] = -(n*pi/L) * normCos * sin(n*pi*x/L)
    //   This appears in the extensional strain energy integral:
    //   K_ext[i][j] = integral_0^L E*A(x) * phi_i'(x) * phi_j'(x) dx
    const pi = Math.PI;
    for (let n = 1; n <= N_elastic; n++) {
      const modeIdx = n - 1;   // array index: elastic mode n stored at index n-1
      omega[modeIdx] = n * pi * c_ext / L;

      const k = n * pi / L;   // spatial wavenumber k_n = n*pi/L (rad/m)
      for (let i = 0; i < Nx; i++) {
        Phi[i][modeIdx]   = normCos * Math.cos(k * spatialX[i]);
        // First derivative: d/dx phi_n = -k * normCos * sin(k*x)
        Phi_d[i][modeIdx] = -k * normCos * Math.sin(k * spatialX[i]);
      }
    }

    // Store (new references trigger ModalState auto-rebuild).
    this.omega = omega;
    this.Phi   = Phi;

    // --- Modal damping ---
    // zeta_n = _dampBase + _dampFreqScale * n
    const zeta = new Array(N_total);
    for (let n = 0; n < N_total; n++) {
      zeta[n] = this._dampBase + this._dampFreqScale * n;
    }
    this.zeta = zeta;

    // --- Cache uniform (prismatic) results for Rayleigh-Ritz ---
    // Rayleigh-Ritz uses the uniform mode shapes as trial functions.
    this.Phi_uniform   = Phi;      // uniform (prismatic) mode shapes
    this.omega_uniform = omega;    // uniform natural frequencies
    this.Phi_d         = Phi_d;    // first spatial derivatives of uniform modes

    // --- Taper profile initialization ---
    // taperPoints: 5 control points along the normalized beam axis (xNorm = 0..1).
    // scale=1.0 everywhere means uniform (prismatic) rod -- no taper.
    // Only initialize if not already set (preserves user edits across recompute calls).
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
    this.scaleProfile = new Array(Nx).fill(1.0);

    // A_profile: scaled cross-section area at each slice.
    // A_profile[p] = A * scale^2  (area scales as length^2).
    // Note: extensional definition has no I_profile (bending stiffness unused here).
    this.A_profile = new Array(Nx).fill(A);

    // If taper is active, compute tapered eigenpairs via Rayleigh-Ritz.
    if (this._taperIsActive()) {
      this._recomputeProfiles();
      this._runRayleighRitzExt();
    }
  }

  // ------------------------------------------------------------------
  // _taperIsActive -- returns true if any taperPoint has scale != 1.0.
  //
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
  //   sorted by xNorm from 0 to 1.
  //
  // Updates scaleProfile by linear interpolation, then either runs
  // Rayleigh-Ritz (if taper is active) or restores the uniform eigenpairs.
  // ------------------------------------------------------------------
  setTaperProfile(points) {
    this.taperPoints = points;
    const Nx = this.Nx;
    const L  = this.L;

    // Build scaleProfile by linear interpolation of taperPoints.
    for (let p = 0; p < Nx; p++) {
      const xNorm = this.spatialX[p] / L;
      let s = 1.0;
      for (let j = 0; j < points.length - 1; j++) {
        if (xNorm <= points[j + 1].xNorm) {
          const t = (xNorm - points[j].xNorm) / (points[j + 1].xNorm - points[j].xNorm);
          s = points[j].scale + t * (points[j + 1].scale - points[j].scale);
          break;
        }
        if (j === points.length - 2) s = points[points.length - 1].scale;
      }
      this.scaleProfile[p] = s;
    }

    if (this._taperIsActive()) {
      this._recomputeProfiles();
      this._runRayleighRitzExt();
    } else {
      // Restore uniform eigenpairs (new references trigger ModalState rebuild).
      this.omega     = this.omega_uniform.slice();
      this.Phi       = this.Phi_uniform.map(row => row.slice());
      this.N         = this.omega.length;
      this.A_profile = new Array(Nx).fill(this.A);
      this._updateMasses();
      const zeta = new Array(this.N);
      for (let n = 0; n < this.N; n++) {
        zeta[n] = this._dampBase + this._dampFreqScale * n;
      }
      this.zeta = zeta;
    }
  }

  // ------------------------------------------------------------------
  // _recomputeProfiles -- compute A_profile from scaleProfile.
  //
  // A_profile[p] = A * scale^2  (area scales as length^2).
  // Extensional definition uses only A_profile (no I_profile needed).
  // ------------------------------------------------------------------
  _recomputeProfiles() {
    const A  = this.A;
    const Nx = this.Nx;
    for (let p = 0; p < Nx; p++) {
      const s        = this.scaleProfile[p];
      this.A_profile[p] = A * s * s;
    }
  }

  // ------------------------------------------------------------------
  // _updateMasses -- update lumped masses from A_profile.
  // ------------------------------------------------------------------
  _updateMasses() {
    const rho    = this.rho;
    const h_grid = this.L / (this.Nx + 1);
    for (let p = 0; p < this.Nx; p++) {
      this.masses[p] = rho * this.A_profile[p] * h_grid;
    }
  }

  // ------------------------------------------------------------------
  // _runRayleighRitzExt -- compute tapered rod eigenpairs via Rayleigh-Ritz.
  //
  // Analogous to BeamBendingDefinition._runRayleighRitz but uses the
  // extensional wave equation: strain energy = E*A(x) * (du/dx)^2.
  // Trial functions are the uniform cosine modes and their first derivatives.
  //
  // K_ext[i][j] = integral_0^L E * A(x) * phi_i'(x) * phi_j'(x) dx
  // M_ext[i][j] = integral_0^L rho * A(x) * phi_i(x)  * phi_j(x)  dx
  // ------------------------------------------------------------------
  _runRayleighRitzExt() {
    const Nx     = this.Nx;
    const N      = this.N_elastic;
    const E      = this.E;
    const rho    = this.rho;
    const h_grid = this.L / (Nx + 1);
    const dx     = h_grid;

    const Phi_u  = this.Phi_uniform;   // uniform mode shapes: Phi_u[p][n]
    const Phi_d  = this.Phi_d;         // first derivatives: Phi_d[p][n]
    const A_prof = this.A_profile;     // per-slice area: A_prof[p]

    // --- Build stiffness matrix K_ext (N x N) ---
    // K_ext[i][j] = sum_p  E * A_profile[p] * Phi_d[p][i] * Phi_d[p][j] * dx
    const K = [];
    for (let i = 0; i < N; i++) K.push(new Array(N).fill(0));
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        let sum = 0;
        for (let p = 0; p < Nx; p++) {
          sum += E * A_prof[p] * Phi_d[p][i] * Phi_d[p][j] * dx;
        }
        K[i][j] = sum;
        K[j][i] = sum;
      }
    }

    // --- Build mass matrix M_ext (N x N) ---
    // M_ext[i][j] = sum_p  rho * A_profile[p] * Phi_uniform[p][i] * Phi_uniform[p][j] * dx
    const M = [];
    for (let i = 0; i < N; i++) M.push(new Array(N).fill(0));
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        let sum = 0;
        for (let p = 0; p < Nx; p++) {
          sum += rho * A_prof[p] * Phi_u[p][i] * Phi_u[p][j] * dx;
        }
        M[i][j] = sum;
        M[j][i] = sum;
      }
    }

    // --- Solve generalized eigenproblem via standard form ---
    const mathM   = math.matrix(M);
    const mathK   = math.matrix(K);
    const Minv    = math.inv(mathM);
    const A_mat   = math.multiply(Minv, mathK);
    // Symmetrize to remove floating-point noise.
    const A_mat_T = math.transpose(A_mat);
    const A_sym   = math.multiply(math.add(A_mat, A_mat_T), 0.5);

    const result  = math.eigs(A_sym);

    // Extract eigenpairs -- clamp rather than discard negative eigenvalues.
    // Same rationale as BeamBendingDefinition: discarding shrinks pairs.length < N,
    // which changes this.N and causes BeamSoundObserver to read omega beyond bounds.
    // Clamp floor = first uniform extensional eigenvalue squared (not near-DC).
    const MIN_LAMBDA = this.omega_uniform[0] * this.omega_uniform[0];
    const pairs = [];
    for (const ev of result.eigenvectors) {
      const rawLam = (typeof ev.value === 'object') ? ev.value.re : Number(ev.value);
      const lam    = Math.max(MIN_LAMBDA, rawLam);
      const vec    = Array.isArray(ev.vector) ? ev.vector : ev.vector.toArray();
      pairs.push({ lambda: lam, vec });
    }
    pairs.sort((a, b) => a.lambda - b.lambda);
    // pairs.length === N always (no filtering), so this.N stays fixed at N_elastic.

    // --- Build new Phi_new from linear combinations of uniform trial functions ---
    const Phi_new = new Array(Nx);
    for (let p = 0; p < Nx; p++) Phi_new[p] = new Array(pairs.length).fill(0);
    for (let p = 0; p < Nx; p++) {
      for (let k = 0; k < pairs.length; k++) {
        let sum = 0;
        for (let n = 0; n < N; n++) sum += Phi_u[p][n] * pairs[k].vec[n];
        Phi_new[p][k] = sum;
      }
    }

    // --- Mass-normalize Phi_new w.r.t. the tapered mass distribution ---
    // Same rationale as BeamBendingDefinition._runRayleighRitz:
    // Phi_new = Phi_uniform * V is normalized for the UNIFORM mass, not M_taper.
    // ModalState assumes mass-normalized modes (q = Phi^T * M_taper * x); without
    // normalization the projection misallocates energy and the beam drifts.
    for (let k = 0; k < pairs.length; k++) {
      let mm = 0;
      for (let p = 0; p < Nx; p++) {
        mm += rho * A_prof[p] * Phi_new[p][k] * Phi_new[p][k] * dx;
      }
      const normScale = (mm > 1e-20) ? (1.0 / Math.sqrt(mm)) : 1.0;
      for (let p = 0; p < Nx; p++) {
        Phi_new[p][k] *= normScale;
      }
    }

    // --- Assign new references (triggers ModalState auto-rebuild) ---
    this.omega = pairs.map(p => Math.sqrt(p.lambda));
    this.Phi   = Phi_new;
    this.N     = pairs.length;

    this._updateMasses();

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
// Checks frequency ratios (should be harmonic: 2.0, 3.0, 4.0)
// and orthonormality of mode shapes.
//
// function verifyBeamExtensional() {
//   const ed = new BeamExtensionalDefinition({ modes: 8, spatialPoints: 100 });
//   const N = ed.N, Nx = ed.Nx;
//   console.log('c_ext =', ed.c_ext.toFixed(1), 'm/s');
//   console.log('f1 =', (ed.omega[1] / (2*Math.PI)).toFixed(2), 'Hz');
//   console.log('Ratios: f2/f1=' + (ed.omega[2]/ed.omega[1]).toFixed(3)
//     + ' f3/f1=' + (ed.omega[3]/ed.omega[1]).toFixed(3) + ' (expect 2.000, 3.000)');
//   let maxErr = 0;
//   for (let j = 0; j < N; j++) {
//     for (let k = 0; k < N; k++) {
//       let sum = 0;
//       for (let i = 0; i < Nx; i++) sum += ed.Phi[i][j] * ed.masses[i] * ed.Phi[i][k];
//       maxErr = Math.max(maxErr, Math.abs(sum - (j === k ? 1 : 0)));
//     }
//   }
//   console.log('Orthonormality max error:', maxErr.toExponential(2), '(should be < 0.01)');
// }
// ------------------------------------------------------------------
