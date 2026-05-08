/**
 * PresetLoader.js
 * 
 * Responsibility:
 * - Parse Initial Conditions Descriptor JSON
 * - Construct physical definition (MassDefinition or StringDefinition)
 * - Provide initial physical state (displacements, velocities)
 * 
 * NOT allowed to:
 * - Advance time
 * - Store modal state
 * - Perform rendering or sound
 * 
 * Design principle:
 * Presets shape starting conditions, not the rules of reality.
 */

class PresetLoader {
  
  /**
   * Load a preset and return initialized components
   * 
   * @param {Object|string} preset - JSON object or JSON string
   * @returns {Object} { world, definition, initialX, initialV, soundMuted, timeScale, timeFrozen }
   */
  static load(preset) {
    // Parse if string
    const config = typeof preset === 'string' ? JSON.parse(preset) : preset;
    
    const world = config.world || 'mdof';
    
    let definition;
    let N;
    
    if (world === 'mdof') {
      definition = PresetLoader.buildMassDefinition(config.mdof || {});
      N = definition.size();
    } 
    else if (world === 'string') {
      definition = PresetLoader.buildStringDefinition(config.string || {});
      N = definition.Nx;   // initial state arrays have one entry per spatial point
    }
    else if (world === 'lattice') {
      definition = PresetLoader.buildLatticeDefinition(config.lattice || {});
      N = definition.size();
    }
    else if (world === 'strings') {
      // Multi-string world: build one StringDefinition per string, each at its own pitch.
      // Returns immediately with a different shape than single-world presets.
      const bundles = PresetLoader.buildMultiStringPreset(config.strings || {}, config.initial || {});
      const soundMuted  = config.sound?.muted  ?? true;
      const timeScale   = config.time?.scale   ?? 1.0;
      const timeFrozen  = config.time?.frozen  ?? false;
      return { world: 'strings', stringBundles: bundles, soundMuted, timeScale, timeFrozen };
    }
    else {
      throw new Error(`Unknown world: ${world}`);
    }

    // Initial state -- built differently per world type.
    let initialX, initialV;
    const initial = config.initial || {};

    if (world === 'string') {
      // String initial conditions are built from a type descriptor:
      //   type:'strike' --> zero displacement, velocity impulse at position
      //   type:'pluck'  --> triangular displacement at position, zero velocity
      //   (none)        --> all zeros
      if (initial.type === 'strike') {
        initialX = new Array(N).fill(0);
        initialV = PresetLoader._buildStrikeVelocity(definition, initial);
      } else if (initial.type === 'pluck') {
        initialX = PresetLoader._buildPluckDisplacement(definition, initial);
        initialV = new Array(N).fill(0);
      } else {
        initialX = new Array(N).fill(0);
        initialV = new Array(N).fill(0);
      }
    } else if (world === 'lattice') {
      // Lattice initial conditions: node 0 is always the center.
      // If explicit arrays are provided, use them (truncated/padded to N).
      // Otherwise displace the center node by centerDisp (default 0.5 units).
      initialX = initial.displacements
        ? initial.displacements.slice(0, N)
        : new Array(N).fill(0);
      initialV = initial.velocities
        ? initial.velocities.slice(0, N)
        : new Array(N).fill(0);
      if (!initial.displacements) {
        // Default: center node displaced, all others at rest.
        initialX[0] = (initial.centerDisp !== undefined) ? initial.centerDisp : 0.5;
      }
    } else {
      // MDOF: use displacements/velocities arrays or random defaults
      initialX = PresetLoader.padArray(initial.displacements, N, () => random(-0.2, 0.2));
      initialV = PresetLoader.padArray(initial.velocities,    N, () => 0);
    }
    
    // Observer/time settings
    const soundMuted = config.sound?.muted ?? true;
    const timeScale = config.time?.scale ?? 1.0;
    const timeFrozen = config.time?.frozen ?? false;
    
    return {
      world,
      definition,
      initialX,
      initialV,
      soundMuted,
      timeScale,
      timeFrozen
    };
  }
  
  /**
   * Build MassDefinition from config
   * 
   * Config structure:
   * {
   *   masses: [1, 1, 1],               // mass values
   *   kGround: [10, 10, 10],           // ground stiffness for each mass
   *   coupling: [[0, 1, 30], [1, 2, 20]], // [i, j, k] triples
   *   damping: {
   *     base: 0.01,                     // baseline modal damping
   *     frequencyScaling: 0.005         // additional damping per mode index
   *   }
   * }
   */
  static buildMassDefinition(mdofConfig) {
    const def = new MassDefinition();
    
    // If masses specified, rebuild from scratch
    if (mdofConfig.masses && mdofConfig.masses.length > 0) {
      const masses = mdofConfig.masses;
      const kGround = mdofConfig.kGround || masses.map(() => 10);
      
      // Clear default and rebuild
      def.masses = [masses[0]];
      def.kGround = [kGround[0]];
      def.stiffness = [[0]];
      
      // Add remaining masses
      for (let i = 1; i < masses.length; i++) {
        // Use ?? not || so kGround[i] = 0 (free mass, no ground spring) is preserved.
        // || 10 would treat 0 as falsy and silently override it with the default.
        def.addMass(masses[i], kGround[i] ?? 10);
      }
    }
    
    // Apply coupling
    if (mdofConfig.coupling) {
      for (const [i, j, k] of mdofConfig.coupling) {
        def.setCoupling(i, j, k);
      }
    }

    // Apply fixed masses (boundary conditions).
    // Must come BEFORE damping so the reduced mode count is known when
    // zeta[] is written.  fixMass() calls recompute() internally, which
    // resizes zeta to the number of free modes.
    if (mdofConfig.fixed) {
      for (const i of mdofConfig.fixed) {
        def.fixMass(i);
      }
    }

    // Apply damping parameters (requires recompute to have run)
    if (mdofConfig.damping) {
      const base = mdofConfig.damping.base ?? 0.01;
      const freqScale = mdofConfig.damping.frequencyScaling ?? 0.005;
      
      for (let i = 0; i < def.zeta.length; i++) {
        def.zeta[i] = base + freqScale * (i + 1);
      }
    }
    
    return def;
  }
  
  /**
   * Build StringDefinition from config.
   *
   * Config fields (all optional, defaults shown):
   *   length:        1       (m)
   *   tension:       80      (N)
   *   density:       20      (kg/m)   --> c = sqrt(80/20) = 2 m/s
   *   modes:         20      (number of modes retained)
   *   spatialPoints: 200     (interior spatial sample count Nx)
   *   boundaryLeft:  'fixed' ('fixed' or 'free')
   *   boundaryRight: 'fixed'
   *   damping:       { base: 0.001, freqScale: 0.002 }
   */
  /**
   * Build LatticeDefinition from config.
   *
   * Config fields (all optional, defaults shown):
   *   shells:  2       -- hexagonal shell count (2 --> 19 nodes, 3 --> 37 nodes)
   *   mass:    1       -- default mass per node (kg)
   *   kGround: 10     -- ground spring stiffness per node
   *   kFifth:  50     -- coupling stiffness along fifth axis (q-direction, ratio 3/2)
   *   kThird:  50     -- coupling stiffness along major-third axis (r-direction, ratio 5/4)
   *   kMinor:  50     -- coupling stiffness along minor-third axis (dq+dr=0, ratio 6/5)
   *   spacing: 80     -- pixel distance between adjacent nodes
   *   zeta0:   0.005  -- baseline modal damping ratio
   */
  static buildLatticeDefinition(cfg) {
    return new LatticeDefinition({
      shells:  cfg.shells  ?? 2,
      mass:    cfg.mass    ?? 1,
      kGround: cfg.kGround ?? 0,
      kFifth:  cfg.kFifth  ?? 150,
      kThird:  cfg.kThird  ?? 150,
      kMinor:  cfg.kMinor  ?? 150,
      spacing: cfg.spacing ?? 80,
      zeta0:   cfg.zeta0   ?? 0.02
    });
  }

  /**
   * buildMultiStringPreset -- build one StringDefinition per string for the multi-string world.
   *
   * Tuning: 'fifths' places strings at perfect-fifth intervals (ratio 3/2).
   *   centerIdx = floor(count/2). String i has audible Hz:
   *     audibleHz[i] = centerHz * (3/2)^(i - centerIdx)
   * Tension from: f1 = sqrt(T/mu) / (2*L)  -->  T = mu * (2 * L * f1_physics)^2
   * where f1_physics = audibleHz / AUDIO_SCALE (100).
   *
   * @param {Object} cfg     -- strings config block from the preset JSON
   * @param {Object} initial -- initial condition descriptor { type, ... }
   * @returns {Array}        -- [{def: StringDefinition, initialX: [], initialV: []}]
   *                           length = count, index 0 = lowest pitch (bottom string)
   */
  static buildMultiStringPreset(cfg, initial) {
    const count      = cfg.count         || 9;
    const centerHz   = cfg.centerHz      || 294;
    const AUDIO_SCALE = 100;             // visual physics is 100x slower than audible
    const L          = cfg.length        || 1;
    const mu         = cfg.density       || 5;    // linear density (kg/m)
    const modes      = cfg.modes         || 20;
    const Nx         = cfg.spatialPoints || 200;
    const bLeft      = cfg.boundaryLeft  || 'fixed';
    const bRight     = cfg.boundaryRight || 'fixed';
    const damping    = cfg.damping       || { base: 0.1, freqScale: 0.0 };
    const init       = initial           || {};

    // centerIdx: the string at the center pitch. i=0 = lowest (bottom), i=count-1 = highest (top).
    const centerIdx = Math.floor(count / 2);

    const bundles = [];
    for (let i = 0; i < count; i++) {
      // Audible fundamental for string i (Hz).
      // exp = i - centerIdx: positive = above center (higher pitch), negative = below.
      const exp       = i - centerIdx;
      const audibleHz = centerHz * Math.pow(1.5, exp);

      // Physics fundamental = audibleHz / AUDIO_SCALE.
      // Visual wave speed is 1/100 of audible so pulses are visible.
      const f1_phys = audibleHz / AUDIO_SCALE;

      // Tension: T = mu * (2 * L * f1_phys)^2
      const tension = mu * Math.pow(2 * L * f1_phys, 2);

      const def = new StringDefinition({
        length:        L,
        tension:       tension,
        density:       mu,
        modes:         modes,
        spatialPoints: Nx,
        boundaryLeft:  bLeft,
        boundaryRight: bRight,
        damping:       damping
      });

      // Initial conditions: default to rest (zeros) for all strings.
      // Optional: pluck or strike a specific string by index.
      let initialX, initialV;
      const targetsThis = (init.stringIndex === undefined || init.stringIndex === i);
      if (init.type === 'pluck' && targetsThis) {
        initialX = PresetLoader._buildPluckDisplacement(def, init);
        initialV = new Array(Nx).fill(0);
      } else if (init.type === 'strike' && targetsThis) {
        initialX = new Array(Nx).fill(0);
        initialV = PresetLoader._buildStrikeVelocity(def, init);
      } else {
        initialX = new Array(Nx).fill(0);
        initialV = new Array(Nx).fill(0);
      }

      bundles.push({ def, initialX, initialV });
    }

    return bundles;
  }

  static buildStringDefinition(cfg) {
    return new StringDefinition({
      length:        cfg.length        || 1,
      tension:       cfg.tension       || 80,
      density:       cfg.density       || 20,
      modes:         cfg.modes         || 20,
      spatialPoints: cfg.spatialPoints || 200,
      boundaryLeft:  cfg.boundaryLeft  || 'fixed',
      boundaryRight: cfg.boundaryRight || 'fixed',
      damping:       cfg.damping       || { base: 0.001, freqScale: 0.002 }
    });
  }

  /**
   * _buildStrikeVelocity -- build Nx-length velocity array for a hammer strike.
   *
   * All spatial points within hammerWidth/2 of position*L receive velocity v.
   * All other points are zero.
   *
   * @param {StringDefinition} def     -- for spatialX and Nx
   * @param {Object}           cfg     -- { position, velocity, hammerWidth }
   *                                      position: fraction of L (0..1)
   *                                      velocity: impulse m/s (positive = up)
   *                                      hammerWidth: fraction of L (0..1)
   */
  static _buildStrikeVelocity(def, cfg) {
    const v    = new Array(def.Nx).fill(0);
    const ksi  = (cfg.position    || 0.33) * def.L;      // strike x in meters
    const vel  = (cfg.velocity    != null) ? cfg.velocity : 0.3;
    const hw   = (cfg.hammerWidth || 0.05) * def.L / 2;  // half-width in meters
    for (let i = 0; i < def.Nx; i++) {
      if (Math.abs(def.spatialX[i] - ksi) < hw) v[i] = vel;
    }
    return v;
  }

  /**
   * _buildPluckDisplacement -- build Nx-length displacement array for a pluck.
   *
   * Triangular shape: rises linearly from 0 at x=0 to height at x=position*L,
   * then falls linearly back to 0 at x=L.
   *
   * @param {StringDefinition} def     -- for spatialX, Nx, L
   * @param {Object}           cfg     -- { position, height }
   *                                      position: fraction of L (0..1) for peak
   *                                      height: peak displacement (m)
   */
  static _buildPluckDisplacement(def, cfg) {
    const x   = new Array(def.Nx).fill(0);
    const ksi = (cfg.position || 0.33) * def.L;   // peak x in meters
    const h0  = (cfg.height   != null) ? cfg.height : 0.05;
    for (let i = 0; i < def.Nx; i++) {
      const xi = def.spatialX[i];
      x[i] = xi <= ksi
        ? h0 * xi / ksi
        : h0 * (def.L - xi) / (def.L - ksi);
    }
    return x;
  }

  /**
   * Pad or truncate array to length N, using generator for missing values
   * 
   * @param {Array|null} arr - input array (may be null/undefined)
   * @param {number} N - target length
   * @param {function} generator - function(index) => value for missing entries
   * @returns {Array} array of length N
   */
  static padArray(arr, N, generator) {
    if (!arr) {
      return new Array(N).fill(0).map((_, i) => generator(i));
    }
    
    const result = arr.slice(0, N);  // truncate if too long
    while (result.length < N) {
      result.push(generator(result.length));
    }
    return result;
  }
  
  /**
   * Default preset (for when no preset provided)
   * Single mass, grounded, small random displacement
   */
  static get DEFAULT() {
    return {
      world: 'mdof',
      mdof: {
        masses: [1],
        kGround: [10]
      },
      sound: {
        muted: false
      }
    };
  }
}