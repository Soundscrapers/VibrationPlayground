/**
 * LatticeDefinition.js
 *
 * Responsibility:
 * - Define a 2D hexagonal lattice of masses coupled by springs
 * - Own masses, ground stiffness, and coupling stiffness matrix
 * - Compute eigenpairs (omega, Phi) from the current definition
 * - Expose directional stiffness controls for the three tonnetz axes
 *
 * NOT allowed to:
 * - Advance time
 * - Store modal amplitudes or velocities
 * - Perform rendering or sound
 *
 * Relationship to MassDefinition:
 * - Same ModalState interface (omega, Phi, zeta, masses, kGround, stiffness,
 *   fixedMasses, freeToGlobal, globalToFree)
 * - Same eigenanalysis algorithm (mass-normalized, math.js eigs)
 * - Difference: topology is a 2D hex grid instead of a 1D chain
 * - Difference: NO reduced eigenproblem. Heavy masses (masses[i] >> defaultMass)
 *   are effectively fixed -- their eigenvector components are negligible.
 *   fixedMasses is always empty. freeToGlobal and globalToFree are identity maps.
 *   This eliminates the fixMass/releaseMass reduced-eigenanalysis code path.
 *
 * Tonnetz axes:
 * - 'fifth' axis: edges along q-direction (dq = +-1, dr = 0)
 *                 interval = perfect fifth, pitch ratio 3/2
 * - 'third' axis: edges along r-direction (dq = 0, dr = +-1)
 *                 interval = major third, pitch ratio 5/4
 * - 'minor' axis: edges along (dq = +-1, dr = -+1), sum dq+dr = 0
 *                 interval = minor third, pitch ratio 6/5
 *                 (derived: 3/2 divided by 5/4 = 6/5)
 *
 * Axial (q, r) to screen pixel conversion (WEBGL origin at canvas center):
 *   screenX = spacing * (q + r * 0.5)
 *   screenY = spacing * (r * sqrt(3) / 2)
 * This produces a flat-top triangular grid with q pointing right.
 */

class LatticeDefinition {
  /**
   * constructor
   * @param {Object} config - optional configuration overrides
   * @param {number} config.shells   - hexagonal shell count (default 2 --> 19 nodes)
   * @param {number} config.mass     - default mass per node (default 1)
   * @param {number} config.kGround  - default ground spring stiffness per node (default 10)
   * @param {number} config.kFifth   - coupling stiffness along fifth axis (default 50)
   * @param {number} config.kThird   - coupling stiffness along major-third axis (default 50)
   * @param {number} config.kMinor   - coupling stiffness along minor-third axis (default 50)
   * @param {number} config.spacing  - pixel distance between adjacent nodes (default 80)
   * @param {number} config.zeta0    - baseline modal damping ratio (default 0.003)
   */
  constructor(config = {}) {
    // --- Configuration with defaults ---
    this.shells       = (config.shells   !== undefined) ? config.shells   : 2;
    this.defaultMass  = (config.mass     !== undefined) ? config.mass     : 1;
    this.defaultKGround = (config.kGround !== undefined) ? config.kGround : 0;
    this.kFifth       = (config.kFifth   !== undefined) ? config.kFifth  : 150;
    this.kThird       = (config.kThird   !== undefined) ? config.kThird  : 150;
    this.kMinor       = (config.kMinor   !== undefined) ? config.kMinor  : 150;
    this.spacing      = (config.spacing  !== undefined) ? config.spacing  : 80;
    this.zeta0        = (config.zeta0         !== undefined) ? config.zeta0         : 0.02;
    // dampingSlope: added to zeta0 linearly across mode index.
    //   zeta_n = zeta0 + dampingSlope * (n / (N-1))
    //   n=0 (lowest mode):  zeta = zeta0              (no extra damping)
    //   n=N-1 (highest):    zeta = zeta0 + dampingSlope (maximum extra damping)
    this.dampingSlope = (config.dampingSlope  !== undefined) ? config.dampingSlope  : 0;

    // --- Build node grid from shell count ---
    // nodePositions[i] = { q, r, screenX, screenY }
    //   q, r   : axial (hex) coordinates (integer)
    //   screenX, screenY : pixel position relative to WEBGL origin (canvas center)
    this.nodePositions = [];
    this._buildNodes();

    const N = this.nodePositions.length;

    // --- Physical arrays (one entry per node) ---
    this.masses  = new Array(N).fill(this.defaultMass);
    this.kGround = new Array(N).fill(this.defaultKGround);

    // --- Coupling stiffness matrix (N x N, symmetric) ---
    // stiffness[i][j] = spring constant between nodes i and j
    // Zero if not adjacent; set by _buildEdges() for all lattice neighbors
    this.stiffness = Array.from({ length: N }, () => new Array(N).fill(0));

    // --- Edge list ---
    // edges[e] = { i, j, axis } with i < j
    // axis: 'fifth' | 'third' | 'minor'
    this.edges = [];
    this._buildEdges();

    // --- ModalState compatibility: identity index maps ---
    // fixedMasses: Set of node indices currently held (1000x mass via fixMass()).
    // Updated by fixMass() / releaseMass(); read by LatticeVisualObserver for color.
    // Heavy masses still participate in the full N x N eigenproblem -- they just have
    // negligible eigenvector components. No reduced subsystem needed.
    this.fixedMasses  = new Set();
    // freeToGlobal[local_index] = global_index (identity for all N nodes)
    this.freeToGlobal = Array.from({ length: N }, (_, i) => i);
    // globalToFree: global_index --> local_index (identity Map)
    this.globalToFree = new Map(Array.from({ length: N }, (_, i) => [i, i]));

    // --- Derived eigenpairs (computed by recompute) ---
    this.omega = [];  // natural frequencies (rad/s), length N
    this.Phi   = [];  // mode shape matrix, N x N (row=node, col=mode)
    this.zeta  = [];  // modal damping ratios, length N

    this.recompute();
  }

  // ------------------------------------------------------------------
  // Grid construction (private)
  // ------------------------------------------------------------------

  /**
   * _buildNodes -- Populate this.nodePositions for shells hexagonal rings.
   *
   * Shell 0: center node at (q=0, r=0). 1 node.
   * Shell s: ring of 6*s nodes around the previous shell. s >= 1.
   * Total nodes: N = 1 + 3*s*(s+1) for s shells.
   *   s=1: 7 nodes, s=2: 19 nodes, s=3: 37 nodes
   *
   * Ring traversal: start at (s, 0), walk 6 directions, s steps each.
   * The six traversal directions (in axial coordinates):
   *   0: (-1, +1)  upper-left
   *   1: (-1,  0)  left
   *   2: ( 0, -1)  lower-left
   *   3: (+1, -1)  lower-right
   *   4: (+1,  0)  right
   *   5: ( 0, +1)  upper-right
   */
  _buildNodes() {
    const sqrt3 = Math.sqrt(3);
    const sp = this.spacing;

    // Shell 0: center node
    this.nodePositions.push({ q: 0, r: 0, screenX: 0, screenY: 0 });

    // Traversal directions for walking around each shell ring
    const ringDirs = [
      [-1,  1],
      [-1,  0],
      [ 0, -1],
      [ 1, -1],
      [ 1,  0],
      [ 0,  1]
    ];

    for (let s = 1; s <= this.shells; s++) {
      // Start of ring s at axial position (s, 0)
      let q = s;
      let r = 0;

      for (let d = 0; d < 6; d++) {
        // Each of the 6 sides of the ring has exactly s nodes
        for (let step = 0; step < s; step++) {
          // Convert axial (q, r) to screen pixels
          const sx = sp * (q + r * 0.5);
          const sy = sp * (r * sqrt3 / 2);
          this.nodePositions.push({ q, r, screenX: sx, screenY: sy });
          // Walk one step in current direction
          q += ringDirs[d][0];
          r += ringDirs[d][1];
        }
      }
    }
  }

  /**
   * _buildEdges -- Populate this.edges and initialize this.stiffness.
   *
   * Two nodes are adjacent if their axial coordinate difference is one of the
   * six unit vectors. We classify each edge by the tonnetz axis it lies on:
   *
   *   'fifth' : dq = +-1, dr = 0       (horizontal, perfect fifth 3/2)
   *   'third' : dq =   0, dr = +-1     (upper-right diagonal, major third 5/4)
   *   'minor' : dq+dr = 0, dq = +-1    (lower-right diagonal, minor third 6/5)
   *             i.e. (dq=+1, dr=-1) or (dq=-1, dr=+1)
   *
   * All 6 directions are checked; the guard (neighborIdx > nodeIdx) ensures
   * each edge is recorded exactly once with i < j.
   */
  _buildEdges() {
    const N = this.nodePositions.length;
    const pos = this.nodePositions;

    // Build axial-coordinate lookup: "q,r" --> node index, for O(1) adjacency test
    const lookup = new Map();
    for (let i = 0; i < N; i++) {
      lookup.set(`${pos[i].q},${pos[i].r}`, i);
    }

    // All 6 neighbor directions and their axis labels
    const allDirs = [
      { dq:  1, dr:  0, axis: 'fifth' },   // right (q increases)
      { dq: -1, dr:  0, axis: 'fifth' },   // left  (q decreases)
      { dq:  0, dr:  1, axis: 'third' },   // upper-right (r increases)
      { dq:  0, dr: -1, axis: 'third' },   // lower-left  (r decreases)
      { dq:  1, dr: -1, axis: 'minor' },   // lower-right (q+r constant, minor third)
      { dq: -1, dr:  1, axis: 'minor' }    // upper-left  (same axis, other direction)
    ];

    for (let nodeIdx = 0; nodeIdx < N; nodeIdx++) {
      for (const { dq, dr, axis } of allDirs) {
        const nq = pos[nodeIdx].q + dq;
        const nr = pos[nodeIdx].r + dr;
        const neighborIdx = lookup.get(`${nq},${nr}`);

        // Only add edge when neighborIdx > nodeIdx to avoid duplicates
        if (neighborIdx !== undefined && neighborIdx > nodeIdx) {
          this.edges.push({ i: nodeIdx, j: neighborIdx, axis });
          const k = this._axisStiffness(axis);
          this.stiffness[nodeIdx][neighborIdx] = k;
          this.stiffness[neighborIdx][nodeIdx] = k;
        }
      }
    }
  }

  /**
   * _axisStiffness -- Return the current default stiffness for a given axis label.
   * @param {string} axis - 'fifth', 'third', or 'minor'
   * @returns {number} stiffness value
   */
  _axisStiffness(axis) {
    if (axis === 'fifth') return this.kFifth;
    if (axis === 'third') return this.kThird;
    if (axis === 'minor') return this.kMinor;
    return 0;
  }

  // ------------------------------------------------------------------
  // Introspection
  // ------------------------------------------------------------------

  /** size -- return total node count N */
  size() {
    return this.nodePositions.length;
  }

  /**
   * spatialSize -- total spatial DOFs (one per node).
   * Mirrors MassDefinition.spatialSize() so callers can treat both
   * definition types uniformly.
   */
  spatialSize() {
    return this.nodePositions.length;
  }

  // ------------------------------------------------------------------
  // Parameter control
  // ------------------------------------------------------------------

  /**
   * setAxisStiffness -- Set coupling stiffness for ALL edges on one tonnetz axis.
   * Updates the axis constant (kFifth, kThird, or kMinor) and propagates it to
   * every matching edge in the stiffness matrix, then recomputes eigenpairs.
   *
   * Physical meaning: changing one axis stiffness makes the lattice anisotropic.
   * A stiffer fifth-axis routes energy preferentially through the circle of fifths.
   * Setting an axis to 0 disconnects all edges on that axis (1D chain topology).
   *
   * @param {string} axis - 'fifth', 'third', or 'minor'
   * @param {number} k    - new stiffness value (>= 0, clamped)
   */
  setAxisStiffness(axis, k) {
    const kVal = Math.max(0, k);

    // Update the stored axis constant
    if      (axis === 'fifth') this.kFifth = kVal;
    else if (axis === 'third') this.kThird = kVal;
    else if (axis === 'minor') this.kMinor = kVal;
    else return;  // unknown axis label, ignore

    // Propagate to every edge on this axis in the stiffness matrix
    for (const edge of this.edges) {
      if (edge.axis === axis) {
        this.stiffness[edge.i][edge.j] = kVal;
        this.stiffness[edge.j][edge.i] = kVal;
      }
    }

    this.recompute();
  }

  /**
   * setCoupling -- Override the stiffness for one specific edge (by node indices).
   * Does NOT change the axis defaults (kFifth/kThird/kMinor).
   * Individual overrides allow local stiffness variation within a globally uniform axis.
   * Recomputes eigenpairs after change.
   *
   * @param {number} i - node index (order does not matter)
   * @param {number} j - node index
   * @param {number} k - stiffness value (>= 0, clamped)
   */
  setCoupling(i, j, k) {
    if (i === j) return;
    const kVal = Math.max(0, k);
    this.stiffness[i][j] = kVal;
    this.stiffness[j][i] = kVal;
    this.recompute();
  }

  /**
   * fixMass -- Make node i effectively immobile by giving it a very large mass.
   * Mass-as-fixedness: a 1000x mass has eigenvector components ~0.001x the others,
   * making it visually and audibly indistinguishable from a fixed boundary.
   * No special code path: it participates in the full N x N eigenproblem.
   *
   * @param {number} i - node index
   */
  fixMass(i) {
    if (i < 0 || i >= this.masses.length) return;
    // 1000x default mass --> eigenvector component at node i is ~= 1/sqrt(1000) ~= 0.032
    // of what it would be for default mass, effectively pinning it in place
    this.masses[i] = this.defaultMass * 1000;
    this.fixedMasses.add(i);   // track so LatticeVisualObserver can color it black
    this.recompute();
  }

  /**
   * releaseMass -- Restore node i to the default mass value.
   * @param {number} i - node index
   */
  releaseMass(i) {
    if (i < 0 || i >= this.masses.length) return;
    this.masses[i] = this.defaultMass;
    this.fixedMasses.delete(i);   // remove from fixed tracking
    this.recompute();
  }

  // ------------------------------------------------------------------
  // Eigenanalysis
  // ------------------------------------------------------------------

  /**
   * recompute -- Assemble K and M, solve the mass-normalized eigenproblem.
   *
   * Stiffness matrix assembly (same logic as MassDefinition full-system path):
   *   K[i][i] = kGround[i] + sum of all coupling stiffnesses at node i
   *   K[i][j] = -k_{ij}  for each coupled neighbor pair (i, j)
   *   K is symmetric and positive definite (for kGround > 0 and k >= 0).
   *
   * Mass-normalized eigenproblem:
   *   A = M^{-1/2} K M^{-1/2}
   *   where M^{-1/2} = diag(1/sqrt(masses[i]))
   *   A is symmetric, so math.js eigs() returns real eigenvalues.
   *   eigenvalue lambda_n = omega_n^2 (rad/s)^2
   *
   * Physical mode shapes (displacement space):
   *   v_n = eigenvector of A (unit length in mass-normalized space)
   *   Phi_n = M^{-1/2} v_n  (column of mode shape matrix)
   *
   * This is a full N x N eigenproblem on all nodes, always.
   * No reduced subsystem is used even when fixMass() has been called.
   *
   * At N=19, math.js eigs() runs in < 10 ms (well within 16 ms frame budget).
   * At N=37, eigs() takes ~20 ms -- still safe at 60 fps.
   */
  recompute() {
    const N = this.nodePositions.length;
    if (N === 0) return;

    // --- Assemble full N x N stiffness matrix ---
    const K = math.zeros(N, N);

    // Diagonal: ground spring at each node
    for (let i = 0; i < N; i++) {
      K.set([i, i], this.kGround[i]);
    }

    // Off-diagonal: coupling springs between adjacent nodes
    // For each pair i < j with stiffness k > 0:
    //   Node i is pulled back by the spring connecting it to j: diagonal K[i][i] += k
    //   Node j is pulled back by the spring connecting it to i: diagonal K[j][j] += k
    //   Cross-coupling (restoring force on i from displacement of j): K[i][j] = -k
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        const k = this.stiffness[i][j];
        if (k > 0) {
          K.set([i, i], K.get([i, i]) + k);
          K.set([j, j], K.get([j, j]) + k);
          K.set([i, j], -k);
          K.set([j, i], -k);
        }
      }
    }

    // --- Build M^{-1/2}: diagonal matrix, entry i = 1/sqrt(masses[i]) ---
    const MinvSqrt = math.diag(this.masses.map(m => 1 / Math.sqrt(m)));

    // --- Form mass-normalized problem: A = M^{-1/2} K M^{-1/2} ---
    const A = math.multiply(MinvSqrt, K, MinvSqrt);

    // --- Solve eigenproblem ---
    // math.js eigs() on a real symmetric matrix returns sorted real eigenvalues
    // and corresponding eigenvectors (unit vectors in mass-normalized space)
    const eig = math.eigs(A);

    // --- Natural frequencies (rad/s) ---
    // lambda_n = omega_n^2; guard against small negative values from floating point
    const lambda = eig.values.valueOf().flat();
    this.omega = lambda.map(v => Math.sqrt(Math.max(v, 0)));

    // --- Mode shapes (physical displacement space) ---
    // eig.eigenvectors[n].vector is the nth eigenvector (mass-normalized, unit length)
    // Physical mode shape: Phi_n = M^{-1/2} v_n
    // Assemble as N x N matrix: row = node index, column = mode number
    const V    = eig.eigenvectors.map(ev => ev.vector.valueOf());  // array of N row-vectors
    const Vmat = math.transpose(V);                                 // N x N: rows=nodes, cols=modes
    this.Phi   = math.multiply(MinvSqrt, Vmat).valueOf();           // physical mode shapes

    // --- Modal damping ---
    // Always rebuild from current zeta0 and dampingSlope so slider changes take
    // effect immediately.
    //   zeta_n = zeta0 + dampingSlope * (n / (N-1))
    //   n=0 (lowest mode):  zeta = zeta0
    //   n=N-1 (highest):    zeta = zeta0 + dampingSlope
    const Nm1 = Math.max(N - 1, 1);  // avoid divide-by-zero for N=1
    this.zeta = this.omega.map((w, i) => {
      const raw = this.zeta0 + this.dampingSlope * (i / Nm1);
      // Clamp to [0, 0.99]: ModalState's step formula uses sqrt(1 - zeta^2)
      // to compute the damped frequency.  zeta >= 1 makes that term imaginary
      // (overdamped regime), producing NaN that propagates into audio gain.
      return Math.min(raw, 0.99);
    });
  }
}
