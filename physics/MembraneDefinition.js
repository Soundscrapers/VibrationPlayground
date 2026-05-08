/**
 * MembraneDefinition.js
 *
 * Responsibility:
 * - Define a rectangular vibrating membrane (2D wave equation, T/sigma/Lx/Ly)
 * - Provide analytical eigenpairs (omega, Phi) via separable sin*sin products
 * - Implement the same duck-type interface as StringDefinition so ModalState
 *   can drive a membrane without modification (it already supports rectangular Phi).
 *
 * NOT allowed to:
 * - Advance time (ModalState's job)
 * - Store modal coordinates or velocities
 * - Perform rendering or sound
 *
 * -------------------------------------------------------------------
 * Interface contract with ModalState (same as StringDefinition):
 *
 *   this.omega        -- length N       -- natural frequencies (rad/s), ascending
 *   this.Phi          -- (Nx*Ny) x N   -- mode shapes: Phi[flatIdx][modeIdx]
 *                        flatIdx = iy * Nx + ix  (row-major: y slow, x fast)
 *   this.zeta         -- length N       -- modal damping ratios (dimensionless)
 *   this.masses       -- length Nx*Ny   -- lumped cell mass at each spatial point (kg)
 *   this.freeToGlobal -- length Nx*Ny   -- identity: [0, 1, ..., Nx*Ny-1]
 *   this.fixedMasses  -- Set            -- always empty (no MDOF-style fixed masses)
 *
 * Membrane-specific (not in MassDefinition):
 *   this.Lx, this.Ly      -- domain dimensions (m)
 *   this.Nx, this.Ny      -- interior spatial sample counts
 *   this.c                -- wave speed (m/s) = sqrt(tension / sigma)
 *   this.tension          -- surface tension T (N/m)
 *   this.sigma            -- surface density (kg/m^2)
 *   this.spatialX         -- length Nx*Ny -- x-coordinate of each sample point (m)
 *   this.spatialY         -- length Nx*Ny -- y-coordinate of each sample point (m)
 *   this.modeIndices      -- length N -- array of {mx, my} for each retained mode
 * -------------------------------------------------------------------
 *
 * 2D wave equation:
 *   T * (d^2u/dx^2 + d^2u/dy^2) = sigma * d^2u/dt^2
 *
 * where T = surface tension (N/m), sigma = surface density (kg/m^2).
 * Wave speed: c = sqrt(T / sigma).
 *
 * Rectangular domain: x in [0, Lx], y in [0, Ly].
 * Boundary conditions: each of the four edges (left, right, top, bottom)
 * is independently 'fixed' (zero displacement) or 'free' (zero slope).
 *
 * -------------------------------------------------------------------
 * Separable modal solution:
 *
 * The 2D eigenproblem factors into two independent 1D problems:
 *   Phi_{mx,my}(x,y) = A * Bx(mx, x) * By(my, y)
 *
 * where Bx and By are the x and y shape functions (sin, cos, or constant 1)
 * and A is a combined normalization factor.
 *
 * Natural frequency for each (mx, my) pair:
 *   omega = c * sqrt(kx^2 + ky^2)
 *
 * where kx, ky are wavenumbers determined by the boundary conditions.
 *
 * For fixed-fixed in both dimensions (default):
 *   kx = mx * pi / Lx,  ky = my * pi / Ly,  Bx = sin,  By = sin
 *   omega_{mx,my} = pi * c * sqrt( (mx/Lx)^2 + (my/Ly)^2 )
 *
 * -------------------------------------------------------------------
 * Mass normalization: Phi^T * M * Phi = I.
 *
 * Each spatial point carries lumped cell mass dm = sigma * hx * hy.
 * The combined normalization factor is determined by whether each
 * dimension's mode function integrates to L/2 (sin or cos) or L (constant):
 *
 *   both non-rigid (sin or cos in each dim):  A = sqrt(4 / (sigma * Lx * Ly))
 *   one rigid-body mode (constant in one dim): A = sqrt(2 / (sigma * Lx * Ly))
 *   both rigid-body (free-free in both dims):  A = sqrt(1 / (sigma * Lx * Ly))
 *
 * For the default fixed-fixed case: A = 2 / sqrt(sigma * Lx * Ly).
 * -------------------------------------------------------------------
 *
 * Boundary conditions use the same four-case logic as StringDefinition,
 * applied independently to x (left/right edges) and y (bottom/top edges):
 *
 *   fixed-fixed: k = m*pi/L,         shape = sin(k*x),      m = 1, 2, ..., Mmax
 *   fixed-free:  k = (2m-1)*pi/(2L), shape = sin(k*x),      m = 1, 2, ..., Mmax
 *   free-fixed:  k = (2m-1)*pi/(2L), shape = cos(k*x),      m = 1, 2, ..., Mmax
 *   free-free:   k = m*pi/L,         shape = 1 (m=0) or cos, m = 0, 1, ..., Mmax
 *
 * For the y-direction: "bottom" = y=0 (left analog), "top" = y=Ly (right analog).
 * Physical y=0 appears at the visual bottom of the canvas; physical y=Ly at the top.
 */

class MembraneDefinition {
  /**
   * constructor
   *
   * @param {Object} cfg -- configuration object (all fields optional)
   * @param {number} cfg.Lx            -- membrane width (m), default 1.0 (fixed by design)
   * @param {number} cfg.Ly            -- membrane height (m), default 1.0 (changed by aspect ratio)
   * @param {number} cfg.tension       -- surface tension T (N/m), default 97
   * @param {number} cfg.sigma         -- surface density (kg/m^2), default 5
   *                                      Default c = sqrt(97/5) = 4.4 m/s
   *                                      f_{1,1} = c/2 * sqrt(1/Lx^2 + 1/Ly^2) = 3.11 Hz (square)
   *                                      At AUDIO_SCALE=80: f_{1,1} audible = 249 Hz (B3)
   * @param {number} cfg.Nx            -- interior x-points, default 40
   * @param {number} cfg.Ny            -- interior y-points, default 40
   * @param {number} cfg.modes         -- retained mode count N, default 30
   * @param {string} cfg.boundaryLeft  -- 'fixed' or 'free', default 'fixed'
   * @param {string} cfg.boundaryRight -- 'fixed' or 'free', default 'fixed'
   * @param {string} cfg.boundaryTop   -- 'fixed' or 'free', default 'fixed'  (y = Ly)
   * @param {string} cfg.boundaryBottom-- 'fixed' or 'free', default 'fixed'  (y = 0)
   * @param {Object} cfg.damping       -- { base, freqScale }, default { base: 0.02, freqScale: 0.005 }
   */
  constructor(cfg = {}) {

    // --- Physical parameters ---

    // Membrane width Lx (m). Fixed at 1.0 by design; aspect ratio slider changes Ly.
    this.Lx = (cfg.Lx != null) ? cfg.Lx : 1.0;

    // Membrane height Ly (m). Controlled by aspect ratio slider (Ly/Lx).
    this.Ly = (cfg.Ly != null) ? cfg.Ly : 1.0;

    // Surface tension T (N/m). Larger tension --> faster wave speed.
    this.tension = (cfg.tension != null) ? cfg.tension : 97;

    // Surface density sigma (kg/m^2). Larger density --> slower wave speed.
    this.sigma = (cfg.sigma != null) ? cfg.sigma : 5;

    // --- Spatial resolution ---

    // Number of interior x-sample points. Excludes the x=0 and x=Lx boundary columns.
    this.Nx = cfg.Nx || 40;

    // Number of interior y-sample points. Excludes the y=0 and y=Ly boundary rows.
    this.Ny = cfg.Ny || 40;

    // Number of retained modes N. N << Nx*Ny for efficient modal superposition.
    this.N = cfg.modes || 30;

    // --- Boundary conditions ---
    // Each edge is independently 'fixed' (u=0) or 'free' (du/dn=0).
    // The x-direction pair (left, right) determines the x-mode shape.
    // The y-direction pair (bottom, top) determines the y-mode shape.
    this.boundaryLeft   = cfg.boundaryLeft   || 'fixed';
    this.boundaryRight  = cfg.boundaryRight  || 'fixed';
    this.boundaryBottom = cfg.boundaryBottom || 'fixed';  // y = 0
    this.boundaryTop    = cfg.boundaryTop    || 'fixed';  // y = Ly

    // --- Damping: zeta_n = base + freqScale * n ---
    // Linear-in-n term makes higher modes damp faster (approximates structural damping).
    this._dampBase      = (cfg.damping && cfg.damping.base      != null) ? cfg.damping.base      : 0.02;
    this._dampFreqScale = (cfg.damping && cfg.damping.freqScale != null) ? cfg.damping.freqScale : 0.005;

    // --- Derived wave speed ---
    // c = sqrt(T / sigma)   [m/s]
    // For defaults: sqrt(97/5) = 4.4 m/s
    this.c = Math.sqrt(this.tension / this.sigma);

    // --- Interface arrays (populated by recompute) ---
    this.omega        = [];   // length N -- natural frequencies (rad/s)
    this.Phi          = [];   // (Nx*Ny) x N -- mode shapes: Phi[flatIdx][modeIdx]
    this.zeta         = [];   // length N -- modal damping ratios
    this.masses       = [];   // length Nx*Ny -- lumped cell mass at each point (kg)
    this.spatialX     = [];   // length Nx*Ny -- x-coordinate of each sample (m)
    this.spatialY     = [];   // length Nx*Ny -- y-coordinate of each sample (m)
    this.freeToGlobal = [];   // length Nx*Ny -- identity mapping [0, 1, ..., Nx*Ny-1]
    this.fixedMasses  = new Set();   // always empty for MembraneDefinition
    this.modeIndices  = [];   // length N -- {mx, my} for each retained mode

    // Build all derived quantities from current parameters.
    this.recompute();
  }

  // ------------------------------------------------------------------
  // size -- returns N (retained mode count).
  // Mirrors MassDefinition.size(). ModalState uses this.omega.length for N.
  // ------------------------------------------------------------------
  size() {
    return this.N;
  }

  // ------------------------------------------------------------------
  // spatialSize -- returns Nx * Ny (total spatial DOF count).
  // New method (same as StringDefinition.spatialSize). Used by sketch.js
  // and controller to loop over all spatial points.
  // ------------------------------------------------------------------
  spatialSize() {
    return this.Nx * this.Ny;
  }

  // ------------------------------------------------------------------
  // toggleBoundary -- flip one edge's boundary condition and rebuild.
  //
  // @param {string} edge -- 'left' | 'right' | 'top' | 'bottom'
  //
  // Replaces this.omega with a new array reference, triggering ModalState's
  // auto-rebuild check (omega !== mdof.omega) on the next step().
  // ------------------------------------------------------------------
  toggleBoundary(edge) {
    const flip = (bc) => (bc === 'fixed') ? 'free' : 'fixed';
    if      (edge === 'left')   this.boundaryLeft   = flip(this.boundaryLeft);
    else if (edge === 'right')  this.boundaryRight  = flip(this.boundaryRight);
    else if (edge === 'top')    this.boundaryTop    = flip(this.boundaryTop);
    else if (edge === 'bottom') this.boundaryBottom = flip(this.boundaryBottom);
    this.recompute();
  }

  // ------------------------------------------------------------------
  // setAspectRatio -- set Ly = Lx * ratio; Lx stays fixed at 1.0.
  //
  // @param {number} ratio -- Ly / Lx, clamped to [0.25, 4.0]
  //
  // Changing the aspect ratio alters all frequencies and mode shapes.
  // Full recompute is required. Replaces omega array reference.
  // ------------------------------------------------------------------
  setAspectRatio(ratio) {
    ratio = Math.max(0.25, Math.min(4.0, ratio));
    this.Ly = this.Lx * ratio;
    this.recompute();
  }

  // ------------------------------------------------------------------
  // setTension -- update surface tension and recompute wave speed and eigenpairs.
  //
  // @param {number} t -- new tension (N/m), clamped to [1, 10000]
  // ------------------------------------------------------------------
  setTension(t) {
    this.tension = Math.max(1, Math.min(10000, t));
    this.c = Math.sqrt(this.tension / this.sigma);
    this.recompute();
  }

  // ------------------------------------------------------------------
  // setDamping -- update base damping ratio in place (no eigenrecompute).
  //
  // @param {number} base -- uniform damping ratio (dimensionless, >= 0)
  // ------------------------------------------------------------------
  setDamping(base) {
    this._dampBase = Math.max(0, base);
    for (let n = 0; n < this.zeta.length; n++) {
      this.zeta[n] = this._dampBase + this._dampFreqScale * n;
    }
  }

  // ------------------------------------------------------------------
  // recompute -- rebuild all derived quantities from current parameters.
  //
  // Call after changing: tension, sigma, Lx, Ly, Nx, Ny, N, any boundary.
  //
  // IMPORTANT: replaces array references (omega, Phi, zeta, masses,
  // spatialX, spatialY, freeToGlobal, modeIndices) rather than mutating
  // them in place. ModalState.step() checks `this.omega !== this.mdof.omega`
  // to detect topology changes; a new reference triggers auto-rebuild.
  // ------------------------------------------------------------------
  recompute() {

    // Update wave speed in case tension or sigma changed.
    this.c = Math.sqrt(this.tension / this.sigma);

    const Lx    = this.Lx;
    const Ly    = this.Ly;
    const Nx    = this.Nx;
    const Ny    = this.Ny;
    const N     = this.N;
    const c     = this.c;
    const sigma = this.sigma;
    const pi    = Math.PI;
    const Ntot  = Nx * Ny;   // total spatial DOF count

    // ------------------------------------------------------------------
    // SPATIAL GRID: Nx*Ny interior points uniformly spaced.
    //
    // x interior: x_ix = (ix+1) * hx,  ix = 0..Nx-1,  hx = Lx/(Nx+1)
    // y interior: y_iy = (iy+1) * hy,  iy = 0..Ny-1,  hy = Ly/(Ny+1)
    //
    // Flat index: k = iy * Nx + ix  (row-major: y changes slowly, x changes fast)
    //
    // Grid excludes the boundary rows/columns (x=0, x=Lx, y=0, y=Ly).
    // The +1 in the denominator ensures no sample falls exactly on the
    // boundary, avoiding sin(0)=0 interior samples for fixed BCs.
    // ------------------------------------------------------------------
    const hx = Lx / (Nx + 1);   // x-spacing between interior points (m)
    const hy = Ly / (Ny + 1);   // y-spacing between interior points (m)

    const spatialX = new Array(Ntot);
    const spatialY = new Array(Ntot);

    for (let iy = 0; iy < Ny; iy++) {
      for (let ix = 0; ix < Nx; ix++) {
        const k = iy * Nx + ix;          // flat index
        spatialX[k] = (ix + 1) * hx;    // x-coordinate of sample k (m)
        spatialY[k] = (iy + 1) * hy;    // y-coordinate of sample k (m)
      }
    }

    this.spatialX = spatialX;
    this.spatialY = spatialY;

    // Identity mapping: all Nx*Ny points are free DOFs (no fixed masses).
    this.freeToGlobal = Array.from({ length: Ntot }, (_, i) => i);
    this.fixedMasses  = new Set();

    // ------------------------------------------------------------------
    // LUMPED CELL MASSES.
    //
    // Each interior point represents a cell of area hx * hy.
    // Cell mass: dm = sigma * hx * hy   [kg]
    //
    // This gives EXACT discrete orthonormality for fixed-fixed sin modes
    // via the 2D Discrete Sine Transform (DST) identity:
    //   sum_{ix} sin^2(mx*pi*(ix+1)/(Nx+1)) = (Nx+1)/2  (exact for each mx)
    //   sum_{iy} sin^2(my*pi*(iy+1)/(Ny+1)) = (Ny+1)/2  (exact for each my)
    //
    // Product: sum_{k} Phi[k]^2 * dm
    //   = A^2 * sigma*hx*hy * [(Nx+1)/2] * [(Ny+1)/2]
    //   = A^2 * sigma * (Lx/(Nx+1)) * (Ly/(Ny+1)) * (Nx+1)/2 * (Ny+1)/2
    //   = A^2 * sigma * Lx * Ly / 4
    //
    // Setting this to 1: A = sqrt(4 / (sigma * Lx * Ly)). (exact for sin*sin)
    // For mixed or cos modes: approximation, error < 0.01 at Nx=Ny=40.
    // ------------------------------------------------------------------
    const dm = sigma * hx * hy;   // cell mass at each spatial point (kg)
    this.masses = new Array(Ntot).fill(dm);

    // ------------------------------------------------------------------
    // MODE LIST: generate candidate (mx, my) pairs, sort by omega, retain N.
    //
    // _modeList() returns objects: { mx, my, kx, ky, omega, shapeX, shapeY }
    //   shapeX / shapeY: 'sin' | 'cos' | 'rigid'  (shape function type)
    //   kx / ky: wavenumber for evaluating Bx(x) = sin/cos(kx*x)
    //   omega: c * sqrt(kx^2 + ky^2)
    // ------------------------------------------------------------------
    // Generate all candidate (mx, my) pairs for current boundary conditions,
    // then remove zero-frequency rigid-body modes (omega = 0) before sorting.
    // The (0,0) free-free mode is a pure piston (uniform translation, omega=0).
    // ModalState integrates it as constant velocity -- it drifts without bound.
    // Filtering it out removes the drift while keeping all true vibrational modes.
    const candidates = this._modeList(Lx, Ly, c)
      .filter(m => m.omega > 1e-6);

    // Sort candidates by omega ascending.
    // For equal omega (degenerate modes, e.g. omega_{2,1}=omega_{1,2} for square),
    // the tie-breaking order is arbitrary -- both modes are equally valid.
    candidates.sort((a, b) => a.omega - b.omega);

    // Take the N lowest-frequency modes.
    const retained = candidates.slice(0, N);

    // ------------------------------------------------------------------
    // NORMALIZATION FACTORS.
    //
    // Continuous-integral orthonormality requires:
    //   integral_0^Lx integral_0^Ly (A * Bx * By)^2 * sigma * dx * dy = 1
    //
    //   integral of sin^2(k*x) over [0, Lx]  = Lx / 2
    //   integral of cos^2(k*x) over [0, Lx]  = Lx / 2
    //   integral of 1 (rigid)  over [0, Lx]  = Lx
    //
    //   non-rigid in both x and y: A^2 * sigma * Lx/2 * Ly/2 = 1  -->  A = sqrt(4 / (sigma*Lx*Ly))
    //   rigid in x, non-rigid in y: A^2 * sigma * Lx * Ly/2 = 1   -->  A = sqrt(2 / (sigma*Lx*Ly))
    //   rigid in y, non-rigid in x: same as above                       A = sqrt(2 / (sigma*Lx*Ly))
    //   rigid in both x and y:      A^2 * sigma * Lx * Ly = 1          A = sqrt(1 / (sigma*Lx*Ly))
    // ------------------------------------------------------------------
    const norm_both  = Math.sqrt(4 / (sigma * Lx * Ly));   // both non-rigid (default)
    const norm_one   = Math.sqrt(2 / (sigma * Lx * Ly));   // exactly one rigid-body dimension
    const norm_none  = Math.sqrt(1 / (sigma * Lx * Ly));   // both rigid-body (free-free in both)

    // ------------------------------------------------------------------
    // BUILD Phi: (Ntot x N) mode shape matrix.
    //
    // Phi[k][mode] = A * Bx(kx, x_k) * By(ky, y_k)
    //
    // where Bx and By are evaluated from the candidate's shapeX/shapeY field.
    // ------------------------------------------------------------------
    const Phi         = new Array(Ntot);
    const omega       = new Array(N);
    const modeIndices = new Array(N);

    for (let k = 0; k < Ntot; k++) {
      Phi[k] = new Array(N).fill(0);
    }

    for (let mode = 0; mode < N; mode++) {
      const m = retained[mode];
      omega[mode]       = m.omega;
      modeIndices[mode] = { mx: m.mx, my: m.my };

      // Choose normalization factor.
      const rigX = (m.shapeX === 'rigid');
      const rigY = (m.shapeY === 'rigid');
      let A;
      if      (!rigX && !rigY) A = norm_both;
      else if ( rigX &&  rigY) A = norm_none;
      else                     A = norm_one;

      // Evaluate mode shape at each interior spatial point.
      for (let k = 0; k < Ntot; k++) {
        const x = spatialX[k];
        const y = spatialY[k];

        // x-direction shape function Bx.
        let Bx;
        if      (m.shapeX === 'sin')   Bx = Math.sin(m.kx * x);
        else if (m.shapeX === 'cos')   Bx = Math.cos(m.kx * x);
        else                           Bx = 1.0;   // rigid-body: constant

        // y-direction shape function By.
        let By;
        if      (m.shapeY === 'sin')   By = Math.sin(m.ky * y);
        else if (m.shapeY === 'cos')   By = Math.cos(m.ky * y);
        else                           By = 1.0;   // rigid-body: constant

        Phi[k][mode] = A * Bx * By;
      }
    }

    // Store new arrays (replaces old references --> triggers ModalState auto-rebuild).
    this.omega       = omega;
    this.Phi         = Phi;
    this.modeIndices = modeIndices;

    // ------------------------------------------------------------------
    // MODAL DAMPING: zeta_n = base + freqScale * n
    //
    // n is the mode index (0-based, sorted by frequency).
    // The freqScale term makes higher modes decay faster, approximating
    // frequency-proportional (structural) damping.
    // Default: base=0.02, freqScale=0.005 --> light, perceptually balanced.
    // ------------------------------------------------------------------
    const zeta = new Array(N);
    for (let n = 0; n < N; n++) {
      zeta[n] = this._dampBase + this._dampFreqScale * n;
    }
    this.zeta = zeta;
  }

  // ------------------------------------------------------------------
  // _modeList -- generate candidate (mx, my) mode pairs based on the
  // current boundary conditions and domain dimensions.
  //
  // Returns an array of objects:
  //   { mx, my, kx, ky, omega, shapeX, shapeY }
  //
  // shapeX / shapeY: 'sin' | 'cos' | 'rigid'
  // omega: c * sqrt(kx^2 + ky^2)
  //
  // x-direction uses (boundaryLeft, boundaryRight) with the same four-case
  // logic as StringDefinition. y-direction uses (boundaryBottom, boundaryTop)
  // where boundaryBottom is at y=0 (analogous to left) and boundaryTop at y=Ly.
  //
  // @param {number} Lx -- x-dimension (m)
  // @param {number} Ly -- y-dimension (m)
  // @param {number} c  -- wave speed (m/s)
  // @returns {Array} candidate mode objects
  // ------------------------------------------------------------------
  _modeList(Lx, Ly, c) {
    const pi   = Math.PI;
    const BL   = this.boundaryLeft;
    const BR   = this.boundaryRight;
    const BB   = this.boundaryBottom;   // y = 0 edge
    const BT   = this.boundaryTop;      // y = Ly edge
    const Mmax = 20;                    // upper index limit per dimension

    // --- x-direction mode helper ---
    // Returns { kx, shapeX } or null if mx is out of range for this BC pair.
    //
    // Four cases (mirrors StringDefinition exactly):
    //   fixed-fixed: sin(mx*pi*x/Lx),           kx = mx*pi/Lx,       mx = 1..Mmax
    //   fixed-free:  sin((2mx-1)*pi*x/(2Lx)),    kx = (2mx-1)*pi/(2Lx), mx = 1..Mmax
    //   free-fixed:  cos((2mx-1)*pi*x/(2Lx)),    kx = (2mx-1)*pi/(2Lx), mx = 1..Mmax
    //   free-free:   1 (mx=0) or cos(mx*pi*x/Lx), kx = mx*pi/Lx,      mx = 0..Mmax
    const xMode = (mx) => {
      if (BL === 'fixed' && BR === 'fixed') {
        if (mx < 1 || mx > Mmax) return null;
        return { kx: mx * pi / Lx, shapeX: 'sin' };
      } else if (BL === 'fixed' && BR === 'free') {
        // sin: zero at x=0 (fixed), zero slope at x=Lx (free)
        if (mx < 1 || mx > Mmax) return null;
        return { kx: (2 * mx - 1) * pi / (2 * Lx), shapeX: 'sin' };
      } else if (BL === 'free' && BR === 'fixed') {
        // cos: zero slope at x=0 (free), zero at x=Lx (fixed)
        if (mx < 1 || mx > Mmax) return null;
        return { kx: (2 * mx - 1) * pi / (2 * Lx), shapeX: 'cos' };
      } else {
        // free-free: mx=0 is rigid-body (constant displacement, k=0)
        if (mx < 0 || mx > Mmax) return null;
        if (mx === 0) return { kx: 0, shapeX: 'rigid' };
        return { kx: mx * pi / Lx, shapeX: 'cos' };
      }
    };

    // --- y-direction mode helper ---
    // Uses (boundaryBottom at y=0, boundaryTop at y=Ly).
    // Bottom = left analog, Top = right analog.
    //
    // Four cases (same structure as x-direction):
    //   BB fixed, BT fixed: sin(my*pi*y/Ly),            ky = my*pi/Ly
    //   BB fixed, BT free:  sin((2my-1)*pi*y/(2Ly)),    ky = (2my-1)*pi/(2Ly)
    //   BB free,  BT fixed: cos((2my-1)*pi*y/(2Ly)),    ky = (2my-1)*pi/(2Ly)
    //   BB free,  BT free:  1 (my=0) or cos(my*pi*y/Ly)
    const yMode = (my) => {
      if (BB === 'fixed' && BT === 'fixed') {
        if (my < 1 || my > Mmax) return null;
        return { ky: my * pi / Ly, shapeY: 'sin' };
      } else if (BB === 'fixed' && BT === 'free') {
        // sin: zero at y=0 (fixed bottom), zero slope at y=Ly (free top)
        if (my < 1 || my > Mmax) return null;
        return { ky: (2 * my - 1) * pi / (2 * Ly), shapeY: 'sin' };
      } else if (BB === 'free' && BT === 'fixed') {
        // cos: zero slope at y=0 (free bottom), zero at y=Ly (fixed top)
        if (my < 1 || my > Mmax) return null;
        return { ky: (2 * my - 1) * pi / (2 * Ly), shapeY: 'cos' };
      } else {
        // free-free: my=0 is rigid-body
        if (my < 0 || my > Mmax) return null;
        if (my === 0) return { ky: 0, shapeY: 'rigid' };
        return { ky: my * pi / Ly, shapeY: 'cos' };
      }
    };

    // --- Generate all (mx, my) candidate pairs ---
    const candidates = [];

    // Index ranges: starts at 0 for free-free (includes rigid body), else 1.
    const mxStart = (BL === 'free' && BR === 'free') ? 0 : 1;
    const myStart = (BB === 'free' && BT === 'free') ? 0 : 1;

    for (let mx = mxStart; mx <= Mmax; mx++) {
      const xm = xMode(mx);
      if (!xm) continue;

      for (let my = myStart; my <= Mmax; my++) {
        const ym = yMode(my);
        if (!ym) continue;

        // Natural frequency: omega = c * sqrt(kx^2 + ky^2)
        const omega = c * Math.sqrt(xm.kx * xm.kx + ym.ky * ym.ky);

        candidates.push({
          mx:     mx,
          my:     my,
          kx:     xm.kx,
          ky:     ym.ky,
          shapeX: xm.shapeX,
          shapeY: ym.shapeY,
          omega:  omega
        });
      }
    }

    return candidates;
  }
}

// ------------------------------------------------------------------
// VERIFICATION TEST (paste into browser console after loading this file).
//
// Checks that Phi^T * M * Phi approximates the identity matrix.
// Max error should be < 0.01 for Nx=Ny=40, N=30 (fixed-fixed in all edges).
//
// function testMembraneNormalization() {
//   const md = new MembraneDefinition({
//     Lx: 1, Ly: 1, tension: 97, sigma: 5, Nx: 40, Ny: 40, modes: 30
//   });
//   const N = md.N, Ntot = md.spatialSize();
//   let maxErr = 0;
//   for (let j = 0; j < N; j++) {
//     for (let k = 0; k < N; k++) {
//       let sum = 0;
//       for (let i = 0; i < Ntot; i++) {
//         sum += md.Phi[i][j] * md.masses[i] * md.Phi[i][k];
//       }
//       const expected = (j === k) ? 1 : 0;
//       maxErr = Math.max(maxErr, Math.abs(sum - expected));
//     }
//   }
//   console.log('Max normalization error:', maxErr, '(target < 0.01)');
//   // Also print first 5 frequencies to verify known ratios for square membrane.
//   for (let n = 0; n < 8; n++) {
//     const f = md.omega[n] / (2 * Math.PI);
//     const ratio = md.omega[n] / md.omega[0];
//     const mn = md.modeIndices[n];
//     console.log('Mode', n, '('+mn.mx+','+mn.my+')', 'f='+f.toFixed(3)+'Hz', 'ratio='+ratio.toFixed(3));
//   }
//   return maxErr;
// }
// ------------------------------------------------------------------
