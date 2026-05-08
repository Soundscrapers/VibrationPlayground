/**
 * LatticeVisualObserver.js
 *
 * Responsibility:
 *   Render the lattice as a 3D WEBGL scene: coupling edges (lines) and
 *   nodes (spheres). Color encodes axis identity (edges) and mass (nodes).
 *   Hover and active-drag highlights are read from the interaction controller.
 *
 * NOT allowed to:
 *   Mutate physics or modal state, call getDisplacements(), advance time.
 *
 * Called from lattice-sketch.js draw() INSIDE the p5 WEBGL context, after
 * orbitControl(), rotateX(), lighting, and controller.updateProjections() have
 * been applied. Uses p5 global drawing functions (stroke, line, sphere, etc.)
 * which are available because the sketch runs in p5 global mode.
 *
 * -------------------------------------------------------------------
 * Coordinate convention (WEBGL, +y is DOWN in p5):
 *
 *   world_x = node.screenX     (q-axis = right, from lattice node positions)
 *   world_y = -node.screenY    (r-axis flipped: higher pitch appears UP on screen)
 *   world_z = disp[i] * zScale (vibration axis, toward viewer at rest)
 *
 * -------------------------------------------------------------------
 * Edge color scheme:
 *   fifth axis  (horizontal,        ratio 3/2): blue   rgb(119, 170, 255)
 *   third axis  (upper-right diag,  ratio 5/4): green  rgb(170, 255, 119)
 *   minor axis  (lower-right diag,  ratio 6/5): purple rgb(170, 119, 255)
 *
 *   Alpha: linear from 0 (k=0) to 255 (k >= K_DEFAULT=150).
 *     k =   0  --> alpha =   0  (invisible)
 *     k =  75  --> alpha = 128  (half transparent)
 *     k = 150  --> alpha = 255  (fully opaque -- the default coupling value)
 *     k > 150  --> alpha = 255  (above default, thickness encodes stiffness instead)
 *
 *   Stroke weight:
 *     k <= 150  --> STROKE_BASE (1.5) -- constant; opacity alone varies here
 *     k > 150   --> linear from 1.5 (at k=150) to 4.5 (at k=K_MAX=2000)
 *                   so a near-rigid edge is visually 3x thicker than default
 *
 *   Hovered or actively dragged edge: bright yellow rgb(255, 240, 100), always opaque.
 *
 * -------------------------------------------------------------------
 * Node color scheme:
 *   Normal: mass-based blue.
 *     massRatio = m / defaultMass, clamped to [1, maxMassRatio].
 *     fill(40, 80, brightness): brightness maps massRatio to [200..30].
 *     brightness 200 = default mass (light blue).
 *     brightness 30  = maxMassRatio x default mass (near-black = effectively fixed).
 *   Hovered: bright cyan rgb(120, 200, 255) so the node pops against the background.
 */

class LatticeVisualObserver {

  /**
   * @param {Object}                       cfg
   * @param {LatticeDefinition}            cfg.latticeDef    -- physics definition (read-only)
   * @param {LatticeInteractionController} cfg.controller    -- interaction state (read-only)
   * @param {number}                       cfg.zScale        -- world units per unit displacement;
   *                                                            must match Z_SCALE in the sketch
   *                                                            and the value passed to the controller
   * @param {number}                      [cfg.maxMassRatio=100] -- mass ratio that maps to the
   *                                                               darkest node color; masses above
   *                                                               this threshold all look the same
   * @param {number}                      [cfg.nodeRadius=12]    -- sphere radius in pixels
   * @param {number}                      [cfg.nodeDetailX=12]   -- sphere tessellation (longitude)
   * @param {number}                      [cfg.nodeDetailY=8]    -- sphere tessellation (latitude)
   */
  constructor(cfg) {
    this.latticeDef   = cfg.latticeDef;   // owns topology: edges, nodePositions, stiffness, masses
    this.controller   = cfg.controller;   // owns hover/hit state: hoverEdge, hitEdge, hoverNode
    this.zScale       = cfg.zScale;       // pixels per unit of physical displacement

    // Visual parameters -- pass in cfg to tune without editing this file.
    this.maxMassRatio = cfg.maxMassRatio || 100;  // clamp ceiling for mass-color mapping
    this.nodeRadius   = cfg.nodeRadius   || 12;   // sphere radius (pixels)
    this.nodeDetailX  = cfg.nodeDetailX  || 12;   // longitudinal tessellation segments
    this.nodeDetailY  = cfg.nodeDetailY  || 8;    // latitudinal tessellation segments
  }

  // ---------------------------------------------------------------------------
  // draw -- render edges then nodes for one frame.
  //
  // Must be called INSIDE the p5 WEBGL context, AFTER:
  //   - orbitControl() (camera navigation)
  //   - rotateX() (base model tilt)
  //   - ambientLight() / directionalLight() (so spheres have shading)
  //   - controller.updateProjections() (so nodeProj is current)
  //
  // Edges are drawn before nodes so that transparent (low-stiffness) edges
  // are composited behind the opaque spheres.
  //
  // @param {number[]} disp -- length N physical displacements, one per node
  // ---------------------------------------------------------------------------
  draw(disp) {
    this._drawEdges(disp);
    this._drawNodes(disp);
  }

  // ---------------------------------------------------------------------------
  // _drawEdges -- draw all coupling edges as colored lines.
  //
  // For each edge e connecting nodes i and j:
  //   - Compute world-space endpoints from nodePositions[i/j].screenX/Y and disp[i/j].
  //   - Set stroke color: axis-identity hue + stiffness-based alpha, or yellow if hovered.
  //   - Call line() in 3D.
  //
  // @param {number[]} disp -- physical displacements, length N
  // ---------------------------------------------------------------------------
  _drawEdges(disp) {
    const def  = this.latticeDef;
    const ctrl = this.controller;
    const Z    = this.zScale;

    for (let e = 0; e < def.edges.length; e++) {
      const edge = def.edges[e];

      // World-space z for each endpoint: displacement (in physical units) * Z_SCALE.
      const ni = def.nodePositions[edge.i];
      const nj = def.nodePositions[edge.j];
      const di = disp[edge.i];
      const dj = disp[edge.j];

      const isHovered = (e === ctrl.hoverEdge || e === ctrl.hitEdge);

      if (isHovered) {
        // Bright yellow: always fully opaque so low-stiffness edges are discoverable on hover.
        stroke(255, 240, 100, 255);
        strokeWeight(2.5);
      } else {
        // Axis-identity color:
        //   fifth  (horizontal,        ratio 3/2): blue   #7af = rgb(119, 170, 255)
        //   third  (upper-right diag,  ratio 5/4): green  #af7 = rgb(170, 255, 119)
        //   minor  (lower-right diag,  ratio 6/5): purple #a7f = rgb(170, 119, 255)
        let er, eg, eb;
        if      (edge.axis === 'fifth') { er = 119; eg = 170; eb = 255; }
        else if (edge.axis === 'third') { er = 170; eg = 255; eb = 119; }
        else                            { er = 170; eg = 119; eb = 255; }  // minor

        // Reference stiffness and drag-max for visual mapping.
        // K_DEFAULT = 150 is the isotropic default: full opacity, base thickness.
        // K_MAX     = 2000 is the drag ceiling: 3x base thickness.
        const K_DEFAULT   = 150;
        const K_MAX       = 2000;
        const STROKE_BASE = 1.5;

        const k = def.stiffness[edge.i][edge.j];

        // Alpha: linear from 0 (k=0) to 255 (k >= K_DEFAULT).
        // Constant at 255 above K_DEFAULT -- thickness carries the signal there.
        const alpha = Math.round(constrain(255 * k / K_DEFAULT, 0, 255));

        // Stroke weight: constant at STROKE_BASE for k <= K_DEFAULT.
        // Linear from STROKE_BASE to 3*STROKE_BASE as k goes K_DEFAULT -> K_MAX.
        //   t = 0 (k = K_DEFAULT) --> weight = STROKE_BASE          (1.5)
        //   t = 1 (k = K_MAX)     --> weight = 3 * STROKE_BASE      (4.5)
        let sw;
        if (k <= K_DEFAULT) {
          sw = STROKE_BASE;
        } else {
          const t = (k - K_DEFAULT) / (K_MAX - K_DEFAULT);
          sw = STROKE_BASE + t * 2 * STROKE_BASE;
        }

        stroke(er, eg, eb, alpha);
        strokeWeight(sw);
      }

      // y is negated so higher r-axis (higher pitch) appears UP on screen.
      line(
        ni.screenX, -ni.screenY, di * Z,
        nj.screenX, -nj.screenY, dj * Z
      );
    }
  }

  // ---------------------------------------------------------------------------
  // _drawNodes -- draw all nodes as spheres colored by mass.
  //
  // Radius scales with mass as a constant-density sphere:
  //   radius = nodeRadius * (m / defaultMass)^(1/3)
  //   At defaultMass: radius = nodeRadius        (base size)
  //   At 3x mass:     radius = nodeRadius * 1.44 (44% larger)
  //   At 1/3 mass:    radius = nodeRadius * 0.69 (31% smaller)
  //
  // Normal: fill(40, 80, brightness), colorMode HSB.
  //   massRatio = m / def.defaultMass, range [1/maxMassRatio, maxMassRatio].
  //   brightness maps the full range:
  //     massRatio < 1 (lighter) --> brightness above 200 (up to ~240, lighter blue)
  //     massRatio = 1 (default) --> brightness = 200
  //     massRatio > 1 (heavier) --> brightness toward 30 (near-black = fixed-like)
  //
  // Hovered node: bright cyan fill(120, 200, 255).
  //   Active-drag node keeps mass-based color -- color CHANGE during drag is the feedback.
  //
  // @param {number[]} disp -- physical displacements, length N
  // ---------------------------------------------------------------------------
  _drawNodes(disp) {
    const def  = this.latticeDef;
    const ctrl = this.controller;
    const Z    = this.zScale;

    noStroke();

    for (let i = 0; i < def.size(); i++) {
      const node = def.nodePositions[i];
      const d    = disp[i];
      const m    = def.masses[i];

      // Radius: cube-root scaling so a heavier sphere looks physically larger.
      // A sphere with 3x mass at constant density has radius * (3)^(1/3) = 1.44x.
      const massRatio = m / def.defaultMass;

      // Fixed (held) nodes use a small visual radius regardless of their physics mass
      // (1000x default). The mass change is kept for physics; we just don't want a
      // giant sphere at an anchor point. FIXED_VISUAL_RATIO < 1 makes the sphere
      // noticeably smaller than a default-mass node.
      const FIXED_VISUAL_RATIO = 0.35;   // radius = nodeRadius * 0.35^(1/3) ~= 0.71x default
      const ratioForSize = def.fixedMasses.has(i) ? FIXED_VISUAL_RATIO : massRatio;
      const radius       = this.nodeRadius * Math.pow(ratioForSize, 1 / 3);

      if (i === ctrl.hoverNode) {
        // Hover highlight: bright cyan pops against the near-black background.
        fill(120, 200, 255);
      } else if (def.fixedMasses.has(i)) {
        // Fixed node (hold tool, 1000x mass): 70% gray so it reads as pinned.
        fill(178, 178, 178);
      } else {
        // Mass-based blue: heavier node = darker blue, lighter node = brighter blue.
        // massRatio < 1 maps above 200 (lighter); massRatio > 1 maps below 200 (darker).
        // clamp to [1/maxMassRatio, maxMassRatio] to avoid runaway brightness values.
        const minRatio   = 1 / this.maxMassRatio;
        const ratioClamp = constrain(massRatio, minRatio, this.maxMassRatio);
        // map: minRatio (lightest) --> 240, 1.0 (default) --> 200, maxMassRatio (heaviest) --> 30
        // Use two-segment linear map via log scale to keep default at exactly 200.
        let brightness;
        if (ratioClamp <= 1) {
          // Lighter than default: brightness 200 (ratio=1) to 240 (ratio=minRatio).
          brightness = map(ratioClamp, minRatio, 1, 240, 200);
        } else {
          // Heavier than default: brightness 200 (ratio=1) to 30 (ratio=maxMassRatio).
          brightness = map(ratioClamp, 1, this.maxMassRatio, 200, 30);
        }
        fill(40, 80, brightness);
      }

      push();
      translate(node.screenX, -node.screenY, d * Z);
      sphere(radius, this.nodeDetailX, this.nodeDetailY);
      pop();
    }
  }
}
