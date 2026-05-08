/**
 * MassDefinition.js
 *
 * Responsibility:
 * - Define the physical MDOF system topology
 * - Own masses, ground stiffness, and coupling stiffness
 * - Compute eigenpairs (omega, Phi) from the current definition
 * - Define modal damping ratios (zeta)
 *
 * NOT allowed to:
 * - Advance time
 * - Store modal amplitudes or velocities
 * - Perform rendering or sound
 */

class MassDefinition {
  constructor() {
    // --- Physical definition ---
    this.maxMasses = 16;  // fits with color gradient (stops at index 9)
    this.masses   = [1];
    this.kGround  = [10];

    // symmetric coupling stiffness matrix
    this.stiffness = [[0]];

    // --- Fixed-mass bookkeeping (for reduced eigenanalysis) ---
    // When masses are fixed (held in place), they become boundary conditions.
    // recompute() builds a reduced K/M for the free masses only.
    this.fixedMasses  = new Set();   // global physics indices of fixed masses
    this.freeToGlobal = [];          // maps local free index --> global physics index
    this.globalToFree = new Map();   // maps global index --> local free index (absent if fixed)

    // --- Derived quantities ---
    this.omega = [];  // natural frequencies (rad/s)
    this.Phi   = [];  // mode shapes (columns)
    this.zeta  = [];  // modal damping ratios (dimensionless)

    this.recompute();
  }

  // --------------------------------------------------
  // Introspection (used by tools / observers)
  // --------------------------------------------------
  size() {
    return this.masses.length;
  }

  // spatialSize -- total number of spatial DOFs (= mass count for MDOF).
  // Mirrors StringDefinition.spatialSize() so callers can treat both
  // definition types uniformly without checking which type they have.
  spatialSize() {
    return this.masses.length;
  }

  hasCoupling(i, j) {
    return this.stiffness[i][j] > 0;
  }

  // --------------------------------------------------
  // Fixed-mass control (for reduced eigenanalysis)
  // --------------------------------------------------

  /**
   * fixMass - Mark a mass as fixed (boundary condition).
   * recompute() will build a reduced eigenproblem for the remaining free masses.
   * @param {number} index - global physics index to fix
   */
  fixMass(index) {
    if (index < 0 || index >= this.masses.length) return;
    this.fixedMasses.add(index);
    this.recompute();
  }

  /**
   * releaseMass - Remove a mass from the fixed set.
   * recompute() will include it back in the full eigenproblem.
   * @param {number} index - global physics index to release
   */
  releaseMass(index) {
    this.fixedMasses.delete(index);
    this.recompute();
  }

  /**
   * isFixed - Query whether a mass is currently fixed.
   * @param {number} index - global physics index
   * @returns {boolean}
   */
  isFixed(index) {
    return this.fixedMasses.has(index);
  }

  /**
   * getFixedMasses - Return the Set of fixed global indices.
   * @returns {Set<number>}
   */
  getFixedMasses() {
    return this.fixedMasses;
  }

  /**
   * getFreeIndices - Return array of global indices NOT in fixedMasses.
   * @returns {number[]}
   */
  getFreeIndices() {
    const N = this.masses.length;
    const free = [];
    for (let i = 0; i < N; i++) {
      if (!this.fixedMasses.has(i)) free.push(i);
    }
    return free;
  }

  // --------------------------------------------------
  // Definition mutation (topology changes)
  // --------------------------------------------------
  addMass(m = 1, kG = 10) {
    if (this.masses.length >= this.maxMasses) return false;
    
    this.masses.push(m);
    this.kGround.push(kG);

    // expand stiffness matrix
    this.stiffness.forEach(row => row.push(0));
    this.stiffness.push(new Array(this.masses.length).fill(0));

    this.recompute();
    return true;
  }

  /**
   * removeMass - Remove the last mass
   * Cannot remove if only one mass remains (system must have at least one mass)
   * 
   * @returns {boolean} true if removed, false if not possible
   */
  removeMass() {
    const N = this.masses.length;

    // Cannot remove if only one mass left
    if (N <= 1) return false;

    // If the last mass was fixed, remove it from the set before popping arrays.
    // (Its global index is N-1; after pop it no longer exists.)
    this.fixedMasses.delete(N - 1);

    // Remove last mass and ground stiffness
    this.masses.pop();
    this.kGround.pop();
    
    // Remove last row and column from stiffness matrix
    this.stiffness.pop();  // remove last row
    this.stiffness.forEach(row => row.pop());  // remove last column from each row
    
    this.recompute();
    return true;
  }

  setCoupling(i, j, k) {
    if (i === j) return;

    this.stiffness[i][j] = max(0, k);
    this.stiffness[j][i] = this.stiffness[i][j];

    this.recompute();
  }

  clearCoupling(i, j) {
    this.stiffness[i][j] = 0;
    this.stiffness[j][i] = 0;

    this.recompute();
  }

  // --------------------------------------------------
  // Damping control
  // --------------------------------------------------
  setDamping(index, value) {
    if (index >= 0 && index < this.zeta.length) {
      this.zeta[index] = Math.max(0, Math.min(1, value));  // clamp to [0, 1]
    }
  }

  // --------------------------------------------------
  // Eigenanalysis
  // --------------------------------------------------
recompute() {
  const N = this.masses.length;

  // --------------------------------------------------
  // Decide whether to run full or reduced eigenproblem
  // --------------------------------------------------

  if (!this.fixedMasses || this.fixedMasses.size === 0) {
    // ---- FULL system: all N masses are free DOFs ----

    // Update index maps to identity
    this.freeToGlobal = [];
    this.globalToFree = new Map();
    for (let i = 0; i < N; i++) {
      this.freeToGlobal.push(i);
      this.globalToFree.set(i, i);
    }

    // Assemble full N x N stiffness matrix
    const K = math.zeros(N, N);
    for (let i = 0; i < N; i++) {
      K.set([i, i], this.kGround[i]);
    }
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

    // Mass-normalized eigenproblem: A = M^{-1/2} K M^{-1/2}
    const MinvSqrt = math.diag(this.masses.map(m => 1 / sqrt(m)));
    const A = math.multiply(MinvSqrt, K, MinvSqrt);
    const eig = math.eigs(A);

    // Natural frequencies (rad/s)
    const lambda = eig.values.valueOf().flat();
    this.omega = lambda.map(v => sqrt(max(v, 0)));

    // Mode shapes: columns of Phi, rows = global mass index
    // eig.eigenvectors is an array of {vector, value}; transpose gives columns
    const V = eig.eigenvectors.map(ev => ev.vector.valueOf());
    const Vmat = math.transpose(V);
    this.Phi = math.multiply(MinvSqrt, Vmat).valueOf();

  } else {
    // ---- REDUCED system: some masses are fixed boundary conditions ----

    // Build free index list (global indices not in fixedMasses)
    const freeIdx = [];
    for (let i = 0; i < N; i++) {
      if (!this.fixedMasses.has(i)) freeIdx.push(i);
    }
    const Nfree = freeIdx.length;

    // Update index maps
    this.freeToGlobal = freeIdx.slice();
    this.globalToFree = new Map();
    for (let li = 0; li < Nfree; li++) {
      this.globalToFree.set(freeIdx[li], li);
    }

    // Edge case: every mass is fixed --> no DOFs left
    if (Nfree === 0) {
      this.omega = [];
      this.Phi   = [];
      this.zeta  = [];
      return;
    }

    // Assemble reduced Nfree x Nfree stiffness matrix.
    // Logic mirrors getReducedFrequencies():
    //   - coupling between two free masses --> off-diagonal -k, diagonal +k
    //   - coupling from free mass to a FIXED mass --> diagonal +k only
    //     (the fixed mass acts as a moving wall; it contributes stiffness
    //      but not a DOF -- equivalent to an extra ground spring)
    const Kred = math.zeros(Nfree, Nfree);

    for (let ri = 0; ri < Nfree; ri++) {
      const gi = freeIdx[ri];   // global index of this free mass
      let diag = this.kGround[gi];

      // Coupling to other FREE masses
      for (let rj = ri + 1; rj < Nfree; rj++) {
        const gj = freeIdx[rj];
        const k = this.stiffness[gi][gj];
        if (k > 0) {
          diag += k;
          Kred.set([rj, rj], Kred.get([rj, rj]) + k);
          Kred.set([ri, rj], -k);
          Kred.set([rj, ri], -k);
        }
      }

      // Coupling to FIXED masses (absorbed as extra ground stiffness)
      for (const gf of this.fixedMasses) {
        const k = this.stiffness[gi][gf];
        if (k > 0) diag += k;
      }

      Kred.set([ri, ri], Kred.get([ri, ri]) + diag);
    }

    // Reduced diagonal mass matrix
    const mFree = freeIdx.map(gi => this.masses[gi]);
    const MinvSqrtR = math.diag(mFree.map(m => 1 / sqrt(m)));

    // Mass-normalized eigenproblem on free DOFs only
    const A = math.multiply(MinvSqrtR, Kred, MinvSqrtR);
    const eig = math.eigs(A);

    // Natural frequencies (rad/s) -- length = Nfree
    const lambda = eig.values.valueOf().flat();
    this.omega = lambda.map(v => sqrt(max(v, 0)));

    // Mode shapes -- rows = local free index, columns = mode number
    const V = eig.eigenvectors.map(ev => ev.vector.valueOf());
    const Vmat = math.transpose(V);
    this.Phi = math.multiply(MinvSqrtR, Vmat).valueOf();
  }

  // --------------------------------------------------
  // Modal damping: preserve existing values if size matches, else set defaults
  // --------------------------------------------------
  const oldZeta = this.zeta || [];
  const needsNewZeta = !this.zeta || this.zeta.length !== this.omega.length;

  if (needsNewZeta) {
    this.zeta = this.omega.map((w, i) => {
      if (i < oldZeta.length) return oldZeta[i];  // preserve existing value
      const baseDamping      = 0.003;
      const frequencyScaling = 0.005 * (i + 1);
      return baseDamping + frequencyScaling;
    });
  }
  // If size unchanged, keep existing zeta (may be from preset)
}

  // --------------------------------------------------
  // Reduced eigenanalysis (for display only)
  // --------------------------------------------------
  /**
   * getReducedFrequencies - Compute natural frequencies of the FREE subsystem
   * when one or more masses are kinematically forced.
   *
   * Physically: a forced mass is a prescribed boundary condition, not a DOF.
   * The remaining free masses form a smaller system whose eigenvalues are
   * the frequencies at which resonance will occur under harmonic driving.
   *
   * Method: strike the rows and columns of forced masses from K and M,
   * solve the reduced (N-F) × (N-F) eigenproblem.
   *
   * @param {Set|Map|Array} forcedIndices - which mass indices are forced
   * @returns {number[]} natural frequencies (rad/s) of the free subsystem,
   *                     sorted ascending. Empty array if all masses are forced
   *                     or if fewer than 1 free mass remains.
   */
  getReducedFrequencies(forcedIndices) {
    // Normalise input: accept Set, Map (keys), or Array
    let forced;
    if (forcedIndices instanceof Map) {
      forced = new Set(forcedIndices.keys());
    } else if (forcedIndices instanceof Set) {
      forced = forcedIndices;
    } else if (Array.isArray(forcedIndices)) {
      forced = new Set(forcedIndices);
    } else {
      return [];  // nothing forced → caller should use this.omega instead
    }

    const N = this.masses.length;

    // Build list of FREE indices (everything not forced)
    const freeIdx = [];
    for (let i = 0; i < N; i++) {
      if (!forced.has(i)) freeIdx.push(i);
    }

    const Nfree = freeIdx.length;
    if (Nfree < 1) return [];  // all masses forced → no free DOFs

    // --------------------------------------------------
    // Assemble reduced K matrix (Nfree × Nfree)
    //
    // Same assembly as recompute(), but only for free DOFs.
    // The coupling between a free mass and a forced mass becomes
    // an additional ground stiffness on the free mass (the forced
    // mass acts as a moving wall, not a free participant).
    // --------------------------------------------------
    const Kred = math.zeros(Nfree, Nfree);

    for (let ri = 0; ri < Nfree; ri++) {
      const gi = freeIdx[ri];  // global index of this free mass

      // Ground stiffness (unchanged)
      let diag = this.kGround[gi];

      // Coupling to OTHER FREE masses → off-diagonal in reduced K
      for (let rj = ri + 1; rj < Nfree; rj++) {
        const gj = freeIdx[rj];
        const k = this.stiffness[gi][gj];
        if (k > 0) {
          // Both diagonals get +k (same pattern as full K assembly)
          diag += k;
          Kred.set([rj, rj], Kred.get([rj, rj]) + k);
          // Off-diagonals get -k
          Kred.set([ri, rj], -k);
          Kred.set([rj, ri], -k);
        }
      }

      // Coupling to FORCED masses → adds to diagonal only
      // (the forced mass is a prescribed boundary, so the spring
      //  connecting free mass gi to forced mass gf acts like a
      //  ground spring on gi from the free subsystem's perspective)
      for (const gf of forced) {
        const k = this.stiffness[gi][gf];
        if (k > 0) {
          diag += k;
        }
      }

      // Accumulate diagonal for this row
      Kred.set([ri, ri], Kred.get([ri, ri]) + diag);
    }

    // Reduced mass matrix (diagonal)
    const mFree = freeIdx.map(gi => this.masses[gi]);
    const MinvSqrt = math.diag(mFree.map(m => 1 / Math.sqrt(m)));

    // Mass-normalised eigenproblem: A = M^{-1/2} K M^{-1/2}
    const A = math.multiply(MinvSqrt, Kred, MinvSqrt);
    const eig = math.eigs(A);

    // Extract frequencies, sorted ascending (math.js returns sorted eigenvalues)
    const lambda = eig.values.valueOf().flat();
    return lambda.map(v => Math.sqrt(Math.max(v, 0)));
  }
}