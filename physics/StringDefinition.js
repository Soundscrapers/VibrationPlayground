/**
 * StringDefinition.js
 *
 * Responsibility:
 * - Define the physical string system (wave equation, boundary conditions)
 * - Provide analytical eigenpairs (omega, Phi) for a 1D vibrating string
 * - Implement the same duck-type interface as MassDefinition so ModalState
 *   can drive a string without modification (after the rectangular-Phi
 *   edits added in Step 2 of the string-world plan).
 *
 * NOT allowed to:
 * - Advance time (that is ModalState's job)
 * - Store modal coordinates or velocities
 * - Perform rendering or sound
 *
 * -------------------------------------------------------------------
 * Interface contract with ModalState (must match MassDefinition):
 *
 *   this.omega        -- length N -- natural frequencies (rad/s)
 *   this.Phi          -- Nx x N  -- mode shapes: Phi[spatialIdx][modeIdx]
 *   this.zeta         -- length N -- modal damping ratios (dimensionless)
 *   this.masses       -- length Nx -- lumped segment mass at each point (kg)
 *   this.freeToGlobal -- length Nx -- identity: [0, 1, 2, ..., Nx-1]
 *   this.fixedMasses  -- Set       -- always empty (no MDOF-style fixed masses)
 *
 * String-specific (not in MassDefinition):
 *   this.spatialX     -- length Nx -- physical x-coordinate of each sample (m)
 *   this.c            -- wave speed (m/s) = sqrt(tension / density)
 * -------------------------------------------------------------------
 *
 * Wave equation:
 *   T * d^2u/dx^2 = mu * d^2u/dt^2
 *
 * where T = tension (N), mu = linear density (kg/m).
 * Wave speed: c = sqrt(T / mu).
 *
 * Spatial domain: x in [0, L].
 * Boundary conditions at x=0 (left) and x=L (right):
 *   'fixed' -- zero displacement: u = 0 at the boundary
 *   'free'  -- zero slope: du/dx = 0 at the boundary
 *
 * -------------------------------------------------------------------
 * Normalization convention (mass-normalized modes):
 *
 * ModalState requires Phi^T * M * Phi = I (identity), where
 * M = diag(masses). For a uniform string with linear density mu:
 *
 *   integral_0^L phi_n(x)^2 * mu dx = 1
 *
 * For sin modes:    integral_0^L sin^2(k_n*x) * mu dx = mu*L/2
 *   --> normalization factor: sqrt(2 / (mu * L))
 *
 * For the rigid-body mode (free-free, n=0):
 *   integral_0^L 1^2 * mu dx = mu*L
 *   --> normalization factor: sqrt(1 / (mu * L))
 *
 * Discrete check: the Nx interior-point grid with spacing h = L/(Nx+1)
 * and segment mass dm = mu*h gives EXACT orthonormality for the sin modes
 * via the Discrete Sine Transform (DST-I) identity:
 *   sum_{i=0}^{Nx-1} sin^2(n*pi*(i+1)/(Nx+1)) = (Nx+1)/2 exactly
 * So: sum_i Phi[i][n]^2 * dm = (2/(mu*L)) * mu*h * (Nx+1)/2 = 1. (exact)
 *
 * For cos modes (free-fixed, free-free), the DST-I identity does not
 * apply; the interior-point discrete sum approximates the continuous
 * integral with error O(1/Nx). At Nx=200 the error is < 0.01.
 */

class StringDefinition {
  /**
   * constructor
   *
   * @param {Object} cfg                  -- configuration object (all fields optional)
   * @param {number} cfg.length           -- string length L (m), default 1
   * @param {number} cfg.tension          -- tension T (N), default 97
   * @param {number} cfg.density          -- linear density mu (kg/m), default 5
   *                                         Default c = sqrt(97/5) = 4.4 m/s, f1 = c/(2L) = 2.2 Hz
   *                                         At 100x audio scale: KS fundamental = 220 Hz (A3)
   * @param {number} cfg.modes            -- number of modes N to retain, default 20
   * @param {number} cfg.spatialPoints    -- interior spatial sample count Nx, default 200
   * @param {string} cfg.boundaryLeft     -- 'fixed' or 'free', default 'fixed'
   * @param {string} cfg.boundaryRight    -- 'fixed' or 'free', default 'fixed'
   * @param {Object} cfg.damping          -- { base, freqScale } for modal damping
   *                                         zeta_n = base + freqScale * n
   */
  constructor(cfg = {}) {

    // --- Physical parameters ---

    // String length L (m).
    this.L = cfg.length || 1;

    // Tension T (N). Larger tension --> faster wave speed.
    this.tension = cfg.tension || 97;

    // Linear density mu (kg/m). Larger density --> slower wave speed.
    this.density = cfg.density || 5;

    // Number of modes N retained in the modal basis.
    // More modes --> more accurate representation of sharp features (plucks, strikes).
    // Recommended: N << Nx (default 20 out of 200 spatial points).
    this.N = cfg.modes || 20;

    // Number of interior spatial sample points Nx.
    // The string has Nx DOFs. Wave propagation is resolved at this resolution.
    this.Nx = cfg.spatialPoints || 200;

    // Boundary conditions: 'fixed' = zero displacement, 'free' = zero slope.
    this.boundaryLeft  = cfg.boundaryLeft  || 'fixed';
    this.boundaryRight = cfg.boundaryRight || 'fixed';

    // Damping parameters.
    // zeta_n = _dampBase + _dampFreqScale * n
    // The linear-in-mode-number term makes higher modes decay faster,
    // approximating frequency-proportional (structural) damping.
    this._dampBase      = (cfg.damping && cfg.damping.base      != null) ? cfg.damping.base      : 0.1;
    this._dampFreqScale = (cfg.damping && cfg.damping.freqScale != null) ? cfg.damping.freqScale : 0.0;

    // --- Derived constant: wave speed ---
    // c = sqrt(T / mu)  [m/s]
    // For defaults: sqrt(97 / 5) = 4.4 m/s, f1 = c/(2L) = 2.2 Hz visually.
    // A 1m string with c=4.4 m/s has a crossing time of 0.23s = ~14 frames at 60fps.
    this.c = Math.sqrt(this.tension / this.density);

    // --- Interface arrays (populated by recompute) ---
    this.omega        = [];   // length N -- natural frequencies (rad/s)
    this.Phi          = [];   // Nx x N  -- mode shapes Phi[spatialIdx][modeIdx]
    this.zeta         = [];   // length N -- modal damping ratios
    this.masses       = [];   // length Nx -- lumped segment mass at each point (kg)
    this.spatialX     = [];   // length Nx -- x-coordinate of each sample point (m)
    this.freeToGlobal = [];   // length Nx -- identity mapping [0, 1, ..., Nx-1]
    this.fixedMasses  = new Set();   // always empty for StringDefinition

    // Build all derived quantities from the current parameters.
    this.recompute();
  }

  // ------------------------------------------------------------------
  // size -- returns N (mode count).
  //
  // Mirrors MassDefinition.size(). For MDOF, size() = number of masses.
  // For strings, size() = number of modes (not spatial points).
  // ModalState uses this.omega.length for N, not size().
  // ------------------------------------------------------------------
  size() {
    return this.N;
  }

  // ------------------------------------------------------------------
  // spatialSize -- returns Nx (spatial sample count).
  //
  // New method not in MassDefinition. Used by StringVisualObserver and
  // the Step 2 edits to ModalState to distinguish mode count from
  // spatial DOF count.
  // ------------------------------------------------------------------
  spatialSize() {
    return this.Nx;
  }

  // ------------------------------------------------------------------
  // toggleBoundary -- flip one end's boundary condition and rebuild.
  //
  // @param {string} side  -- 'left' or 'right'
  //
  // After toggling, the eigenpairs change (new mode shapes and frequencies).
  // ModalState detects this change via the auto-rebuild check in step():
  //   if (this.omega !== this.mdof.omega) { this.rebuild(this.mdof); }
  // This works because recompute() replaces (not mutates) this.omega.
  // ------------------------------------------------------------------
  toggleBoundary(side) {
    if (side === 'left') {
      // Flip left boundary between 'fixed' and 'free'
      this.boundaryLeft = (this.boundaryLeft === 'fixed') ? 'free' : 'fixed';
    } else {
      // Flip right boundary between 'fixed' and 'free'
      this.boundaryRight = (this.boundaryRight === 'fixed') ? 'free' : 'fixed';
    }
    // Rebuild all derived quantities with new boundary conditions
    this.recompute();
  }

  // ------------------------------------------------------------------
  // recompute -- rebuild all derived quantities from current parameters.
  //
  // Call after changing: tension, density, N, Nx, boundaryLeft,
  // boundaryRight, or damping parameters.
  //
  // IMPORTANT: this method REPLACES arrays (omega, Phi, zeta, masses,
  // spatialX, freeToGlobal) rather than mutating them in place.
  // ModalState.step() checks `this.omega !== this.mdof.omega` to detect
  // topology changes. A new array reference triggers auto-rebuild.
  // ------------------------------------------------------------------
  recompute() {

    // Update wave speed in case tension or density changed.
    // c = sqrt(T / mu)
    this.c = Math.sqrt(this.tension / this.density);

    const L   = this.L;
    const N   = this.N;
    const Nx  = this.Nx;
    const c   = this.c;
    const mu  = this.density;
    const pi  = Math.PI;

    // ------------------------------------------------------------------
    // SPATIAL GRID: Nx interior points uniformly spaced in (0, L).
    //
    // Spacing:   h = L / (Nx + 1)
    // Position:  spatialX[i] = (i+1) * h,  i = 0, 1, ..., Nx-1
    //
    // The grid EXCLUDES the endpoints at x=0 and x=L. For fixed BCs,
    // these endpoints have zero displacement anyway. For free BCs, the
    // visual observer adds the endpoint as a separate rendered point.
    //
    // The +1 in the denominator ensures no sample falls exactly on
    // the boundary, avoiding sin(0)=0 interior points for fixed BCs.
    // ------------------------------------------------------------------
    const h = L / (Nx + 1);   // spacing between interior points (m)
    const spatialX = new Array(Nx);
    for (let i = 0; i < Nx; i++) {
      spatialX[i] = (i + 1) * h;   // x-coordinate of sample i (m)
    }
    this.spatialX = spatialX;

    // Identity mapping: every spatial point is a free DOF.
    // freeToGlobal[i] = i for all i = 0, ..., Nx-1.
    // ModalState uses freeToGlobal to index into physical displacement arrays.
    this.freeToGlobal = Array.from({ length: Nx }, (_, i) => i);
    this.fixedMasses  = new Set();   // always empty -- no MDOF-style fixed masses

    // ------------------------------------------------------------------
    // LUMPED SEGMENT MASSES.
    //
    // Each interior point represents a string segment of length h.
    // Segment mass:  dm = mu * h = mu * L / (Nx + 1)   [kg]
    //
    // This is the EXACT segment mass for the interior-point grid.
    // Total modeled mass = Nx * dm = mu*L*Nx/(Nx+1) ≈ mu*L (converges
    // to the full string mass as Nx --> infinity).
    //
    // Using dm = mu*h (not mu*L/Nx) gives EXACT discrete orthonormality
    // for sin modes via the DST-I identity. See file header for derivation.
    // ------------------------------------------------------------------
    const dm = mu * h;   // segment mass at each spatial point (kg)
    this.masses = new Array(Nx).fill(dm);

    // ------------------------------------------------------------------
    // NORMALIZATION FACTORS.
    //
    // For mass-normalized modes (Phi^T * M * Phi = I):
    //
    //   sin/cos modes:  A = sqrt(2 / (mu * L))
    //   rigid-body:     A = sqrt(1 / (mu * L))
    //
    // Derivation from continuous integral:
    //   integral_0^L A^2 * sin^2(k*x) * mu dx = A^2 * mu * L/2 = 1
    //   --> A^2 = 2 / (mu * L)
    //   --> A  = sqrt(2 / (mu * L))
    // ------------------------------------------------------------------
    const normSin   = Math.sqrt(2 / (mu * L));   // factor for sin and non-zero cos modes
    const normRigid = Math.sqrt(1 / (mu * L));   // factor for rigid-body mode (free-free n=0)

    // ------------------------------------------------------------------
    // ALLOCATE output arrays.
    //
    // omega: length N
    // Phi:   Nx rows (outer), N columns (inner) --> Phi[spatialIdx][modeIdx]
    //        This layout matches ModalState's access pattern:
    //          this.Phi[li][j]  where li = local DOF index, j = mode index
    // ------------------------------------------------------------------
    const omega = new Array(N);

    const Phi = new Array(Nx);
    for (let i = 0; i < Nx; i++) {
      Phi[i] = new Array(N).fill(0);
    }

    const BL = this.boundaryLeft;
    const BR = this.boundaryRight;

    // ------------------------------------------------------------------
    // CASE 1: fixed-fixed (both ends pinned).
    //
    // Boundary conditions: u(0,t) = 0,  u(L,t) = 0
    //
    // Eigenfunctions (mode shapes):
    //   phi_n(x) = sqrt(2/(mu*L)) * sin(n*pi*x/L),  n = 1, 2, 3, ...
    //
    // Natural frequencies:
    //   omega_n = n * pi * c / L   [rad/s]
    //
    // Verification: sin(n*pi*0/L) = 0  (fixed left ok)
    //               sin(n*pi*L/L) = sin(n*pi) = 0  (fixed right ok)
    //
    // Orthogonality: EXACT on the interior-point grid via DST-I:
    //   sum_i sin^2(n*pi*(i+1)/(Nx+1)) = (Nx+1)/2
    //   --> sum_i Phi[i][n]^2 * dm = (2/(mu*L)) * mu*h * (Nx+1)/2 = 1 exactly
    // ------------------------------------------------------------------
    if (BL === 'fixed' && BR === 'fixed') {

      for (let n = 0; n < N; n++) {
        const modeNum = n + 1;                  // 1-based mode number (n=1,2,...,N)
        omega[n] = modeNum * pi * c / L;        // omega_n = n*pi*c/L  [rad/s]

        const k = modeNum * pi / L;             // spatial wavenumber k_n = n*pi/L  [rad/m]
        for (let i = 0; i < Nx; i++) {
          // Evaluate normalized sin at interior point i
          Phi[i][n] = normSin * Math.sin(k * spatialX[i]);
        }
      }

    // ------------------------------------------------------------------
    // CASE 2: fixed-free (left end pinned, right end open).
    //
    // Boundary conditions: u(0,t) = 0,  du/dx(L,t) = 0
    //
    // From the wave equation, mode shapes satisfying these BCs:
    //   phi_n(x) = sqrt(2/(mu*L)) * sin((2n-1)*pi*x/(2L)),  n = 1, 2, 3, ...
    //
    // Natural frequencies (odd harmonics only, no even harmonics):
    //   omega_n = (2n-1) * pi * c / (2L)   [rad/s]
    //
    // Verification:
    //   sin((2n-1)*pi*0/(2L)) = sin(0) = 0  (fixed left ok)
    //   d/dx sin(k*x)|_{x=L} = k*cos(k*L) = k*cos((2n-1)*pi/2) = 0  (free right ok)
    //   because cos((2n-1)*pi/2) = 0 for all integer n.
    // ------------------------------------------------------------------
    } else if (BL === 'fixed' && BR === 'free') {

      for (let n = 0; n < N; n++) {
        const modeNum = 2 * n + 1;                      // odd: 1, 3, 5, ..., (2N-1)
        omega[n] = modeNum * pi * c / (2 * L);          // omega_n = (2n-1)*pi*c/(2L)

        const k = modeNum * pi / (2 * L);               // k_n = (2n-1)*pi/(2L)
        for (let i = 0; i < Nx; i++) {
          Phi[i][n] = normSin * Math.sin(k * spatialX[i]);
        }
      }

    // ------------------------------------------------------------------
    // CASE 3: free-fixed (left end open, right end pinned).
    //
    // same as Case 2 but with fixed/free ends swapped
    // ------------------------------------------------------------------
    } else if (BL === 'free' && BR === 'fixed') {

      for (let n = 0; n < N; n++) {
        const modeNum = 2 * n + 1;                      // odd: 1, 3, 5, ..., (2N-1)
        omega[n] = modeNum * pi * c / (2 * L);          // omega_n = (2n-1)*pi*c/(2L)

        const k = modeNum * pi / (2 * L);               // k_n = (2n-1)*pi/(2L)
        for (let i = 0; i < Nx; i++) {
          // cos(k*x): zero slope at x=0 (free), zero value at x=L (fixed)
          Phi[i][n] = normSin * Math.cos(k * spatialX[i]);
        }
      }

    // ------------------------------------------------------------------
    // CASE 4: free-free (both ends open).
    //
    // Boundary conditions: du/dx(0,t) = 0,  du/dx(L,t) = 0
    //
    // Mode shapes:
    //   n=0: phi_0(x) = sqrt(1/(mu*L))           (rigid-body translation, omega=0)
    //   n>=1: phi_n(x) = sqrt(2/(mu*L)) * cos(n*pi*x/L)
    //
    // Natural frequencies:
    //   omega_0 = 0   (rigid-body mode -- no restoring force)
    //   omega_n = n * pi * c / L,  n = 1, 2, ..., N-1
    //
    // Verification for cos modes:
    //   d/dx cos(k*x)|_{x=0} = -k*sin(0) = 0  (free left ok)
    //   d/dx cos(k*x)|_{x=L} = -k*sin(k*L) = -k*sin(n*pi) = 0  (free right ok)
    //
    // NOTE: ModalState handles omega_0 = 0 specially (rigid-body path at line ~302):
    //   if (wn < 1e-6) { q = q + qdot*dt; continue; }
    // This is correct: a zero-frequency mode drifts at constant velocity.
    // ------------------------------------------------------------------
    } else {
      // free-free

      // Mode 0: rigid-body (constant displacement, omega = 0)
      omega[0] = 0;
      for (let i = 0; i < Nx; i++) {
        Phi[i][0] = normRigid;   // uniform value -- same at every spatial point
      }

      // Modes 1 through N-1: cosine series (omega > 0)
      for (let n = 1; n < N; n++) {
        omega[n] = n * pi * c / L;              // omega_n = n*pi*c/L  [rad/s]

        const k = n * pi / L;                  // k_n = n*pi/L  [rad/m]
        for (let i = 0; i < Nx; i++) {
          Phi[i][n] = normSin * Math.cos(k * spatialX[i]);
        }
      }
    }

    // Store the new arrays (replaces old references -- triggers ModalState auto-rebuild).
    this.omega = omega;
    this.Phi   = Phi;

    // ------------------------------------------------------------------
    // MODAL DAMPING.
    //
    // zeta_n = _dampBase + _dampFreqScale * n
    //
    // Linear-in-mode-number term approximates frequency-proportional
    // (structural) damping: higher modes decay faster.
    // Default: base=0.1, freqScale=0.0 (uniform, controlled by UI damping slider).
    //   --> zeta_n = 0.1 for all n (moderate damping, matches typical string feel).
    // ------------------------------------------------------------------
    const zeta = new Array(N);
    for (let n = 0; n < N; n++) {
      zeta[n] = this._dampBase + this._dampFreqScale * n;
    }
    this.zeta = zeta;
  }

  // ------------------------------------------------------------------
  // setDamping -- update base damping ratio and rewrite this.zeta in place.
  //
  // Called by sketch.js vpSetDamping() when string world is active.
  // Does NOT recompute eigenpairs -- omega and Phi are unchanged.
  // ModalState.step() reads this.zeta each call, so the new values
  // take effect on the very next physics step.
  //
  // @param {number} base -- uniform damping ratio (dimensionless, >= 0)
  // ------------------------------------------------------------------
  setDamping(base) {
    this._dampBase = Math.max(0, base);
    // Rewrite zeta for all modes using the new base and the existing freqScale.
    const N = this.zeta.length;
    for (let n = 0; n < N; n++) {
      this.zeta[n] = this._dampBase + this._dampFreqScale * n;
    }
  }

  // ------------------------------------------------------------------
  // setTension -- update tension, recompute wave speed and eigenpairs.
  //
  // Called by StringInteractionController during endpoint tension-drag.
  // Replaces the omega, Phi, and zeta arrays (new references), which
  // triggers ModalState's auto-rebuild check (omega !== mdof.omega) and
  // signals callers to call state.rebuild(def) immediately.
  //
  // @param {number} t -- new tension (N), clamped to [1, 10000]
  // ------------------------------------------------------------------
  setTension(t) {
    this.tension = Math.max(1, Math.min(10000, t));
    // Wave speed c = sqrt(T / mu). Recompute from new tension.
    this.c = Math.sqrt(this.tension / this.density);
    // Rebuild eigenpairs: omega depends on c, Phi depends on boundary conditions.
    this.recompute();
  }
}

// ------------------------------------------------------------------
// VERIFICATION TEST (paste into browser console after loading this file).
//
// Instantiates a StringDefinition and checks that Phi^T * M * Phi ≈ I.
// Max error should be < 0.01 for Nx=200, N=20 (fixed-fixed).
//
// function testStringNormalization() {
//   const sd = new StringDefinition({
//     length: 1, tension: 80, density: 20, modes: 20, spatialPoints: 200,
//     boundaryLeft: 'fixed', boundaryRight: 'fixed'
//   });
//   const N = sd.N, Nx = sd.Nx;
//   let maxErr = 0;
//   for (let j = 0; j < N; j++) {
//     for (let k = 0; k < N; k++) {
//       let sum = 0;
//       for (let i = 0; i < Nx; i++) {
//         sum += sd.Phi[i][j] * sd.masses[i] * sd.Phi[i][k];
//       }
//       const expected = (j === k) ? 1 : 0;
//       maxErr = Math.max(maxErr, Math.abs(sum - expected));
//     }
//   }
//   console.log('Normalization max error:', maxErr, '(should be < 0.01)');
//   return maxErr;
// }
// ------------------------------------------------------------------
