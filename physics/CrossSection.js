/**
 * CrossSection.js
 *
 * Responsibility:
 *   Compute cross-sectional properties (A, I) for four beam cross-section types,
 *   and provide per-slice vertex layouts for the 3D mesh renderer.
 *
 * NOT allowed to:
 *   Touch physics state, modal coordinates, or rendering context.
 *
 * -------------------------------------------------------------------
 * Interface:
 *
 *   this.type      -- 'square' | 'circle' | 'tube' | 'rectangle'
 *   this.params    -- type-specific parameter object (see constructor)
 *   this.A         -- cross-section area (m^2)
 *   this.I         -- second moment of area about bending axis (m^4)
 *   this.kSquared  -- radius of gyration squared = I/A (m^2).
 *                     The single number that determines how geometry
 *                     affects bending frequency: omega_n ~ sqrt(E/rho * I/A)
 *
 * -------------------------------------------------------------------
 * Cross-section types and their parameters:
 *
 *   'square'    { h }             -- square solid, side h (m)
 *     A = h^2,  I = h^4/12
 *
 *   'circle'    { r }             -- circular solid, radius r (m)
 *     A = pi*r^2,  I = pi*r^4/4
 *
 *   'tube'      { rOuter, rInner } -- circular hollow tube
 *     A = pi*(ro^2 - ri^2),  I = pi*(ro^4 - ri^4)/4
 *     Note: for thin walls (ri -> ro), I/A -> ro^2/2, twice that of
 *     a solid circle -- tubes are stiffer per unit mass.
 *
 *   'rectangle' { width, depth }  -- rectangular solid, bending about y-axis
 *     A = b*d,  I = b*d^3/12  (bending in the depth direction)
 *     A flat bar (b >> d) is much more flexible than a tall bar (d >> b)
 *     of the same mass -- same material, same A, very different I.
 *
 * -------------------------------------------------------------------
 * getVertices():
 *
 *   Returns array of { y, z } offsets from the neutral axis (m).
 *   Used by BeamVisualObserver to build the 3D wireframe mesh.
 *   Coordinates are in physical meters; the renderer scales by visScale*S.
 *
 *   For 'tube': each vertex also has a 'ring' property ('outer' or 'inner')
 *   so the renderer can draw two concentric polygons and end-cap radial lines.
 *
 *   For 'square' and 'rectangle': 4 vertices (corners of the rectangle).
 *   For 'circle': 12 vertices (dodecagon -- 12 facets approximates a circle).
 *   For 'tube':  24 vertices (12 outer + 12 inner).
 */

class CrossSection {

  /**
   * @param {string} type   -- 'square' | 'circle' | 'tube' | 'rectangle'
   * @param {Object} params -- type-specific parameter object:
   *   square:    { h }               -- side length (m)
   *   circle:    { r }               -- radius (m)
   *   tube:      { rOuter, rInner }  -- outer and inner radii (m)
   *   rectangle: { width, depth }    -- width b and depth d (m)
   */
  constructor(type, params) {
    this.type   = type;
    this.params = params;
    this._compute();
  }

  // ------------------------------------------------------------------
  // _compute -- derive A, I, kSquared from current params.
  // ------------------------------------------------------------------
  _compute() {
    switch (this.type) {

      case 'square': {
        const h = this.params.h;
        this.A = h * h;
        this.I = h * h * h * h / 12.0;
        this.I_lateral = this.I;   // isotropic: same stiffness in all bending directions
        break;
      }

      case 'circle': {
        const r  = this.params.r;
        const pi = Math.PI;
        this.A = pi * r * r;
        this.I = pi * r * r * r * r / 4.0;
        this.I_lateral = this.I;   // isotropic: circular cross-section has no preferred axis
        break;
      }

      case 'tube': {
        const ro = this.params.rOuter;
        const ri = this.params.rInner;
        const pi = Math.PI;
        this.A = pi * (ro * ro - ri * ri);
        this.I = pi * (ro * ro * ro * ro - ri * ri * ri * ri) / 4.0;
        this.I_lateral = this.I;   // isotropic: annular cross-section has no preferred axis
        break;
      }

      case 'rectangle': {
        const b = this.params.width;   // width (horizontal, z-direction)
        const d = this.params.depth;   // depth (vertical, y-direction)
        this.A = b * d;
        // I_z = second moment about z-axis = integral(y^2 dA) = b*d^3/12.
        // Resists bending in the y-direction (depth controls y-stiffness).
        // A tall bar (large d) resists y-bending; a flat bar (small d) bends easily in y.
        this.I = b * d * d * d / 12.0;
        // I_y = second moment about y-axis = integral(z^2 dA) = d*b^3/12.
        // Resists bending in the z-direction (width controls z-stiffness).
        // A wide bar (large b) resists sideways bending; a narrow bar bends easily in z.
        // This is the strong/weak axis distinction: hitting the narrow face vs. the wide face
        // produces bending with very different resonant frequencies.
        this.I_lateral = d * b * b * b / 12.0;
        break;
      }

      default:
        throw new Error('CrossSection: unknown type "' + this.type + '"');
    }

    // Radius of gyration squared = I / A.
    // Bending omega_n scales as sqrt(E/rho * kSquared) for a given beta_n.
    // Larger kSquared = higher bending frequency for the same material and length.
    this.kSquared = this.I / this.A;

    // I_lateral: second moment of area about the y-axis (resists z-direction bending).
    // For isotropic sections (square, circle, tube): I_lateral = I (same in all directions).
    // For rectangle: I_lateral = depth * width^3 / 12.
    //   Tall bar (depth >> width) has low I_lateral -- bends easily sideways.
    //   Wide bar (width >> depth) has high I_lateral -- stiff in the lateral direction.
    // kSquaredLateral = I_lateral / A: governs z-bending frequency just as kSquared governs y-bending.
    this.kSquaredLateral = this.I_lateral / this.A;
  }

  // ------------------------------------------------------------------
  // getVertices -- return array of {y, z} vertex offsets from neutral axis.
  //
  // Vertices are in physical meters. The mesh renderer scales them by
  // visScale * S (visual amplification * beam length scale).
  //
  // Vertices are ordered counter-clockwise when viewed from the left end.
  // For tube: outer ring vertices first (ring: 'outer'), then inner ring
  // (ring: 'inner'). The renderer uses the ring property to draw two
  // concentric polygons and, for end caps, radial lines between them.
  //
  // @returns {Array<{y:number, z:number, ring?:string}>}
  // ------------------------------------------------------------------
  getVertices() {
    switch (this.type) {

      case 'square': {
        const h2 = this.params.h / 2;
        // 4 corners, counter-clockwise from top-front.
        return [
          { y:  h2, z:  h2 },   // top-front
          { y:  h2, z: -h2 },   // top-back
          { y: -h2, z: -h2 },   // bottom-back
          { y: -h2, z:  h2 }    // bottom-front
        ];
      }

      case 'circle': {
        const r       = this.params.r;
        const N_VERTS = 12;   // dodecagon: 12 sides approximates a circle
        const verts   = [];
        for (let j = 0; j < N_VERTS; j++) {
          const theta = j * 2 * Math.PI / N_VERTS;
          // y = radial component in bending direction
          // z = radial component in depth direction
          verts.push({ y: r * Math.cos(theta), z: r * Math.sin(theta) });
        }
        return verts;
      }

      case 'tube': {
        const ro      = this.params.rOuter;
        const ri      = this.params.rInner;
        const N_VERTS = 12;
        const verts   = [];
        // Outer ring: 12 vertices at rOuter.
        for (let j = 0; j < N_VERTS; j++) {
          const theta = j * 2 * Math.PI / N_VERTS;
          verts.push({ y: ro * Math.cos(theta), z: ro * Math.sin(theta), ring: 'outer' });
        }
        // Inner ring: 12 vertices at rInner, same angular positions.
        // Same ordering as outer so index j in outer corresponds to index j in inner.
        for (let j = 0; j < N_VERTS; j++) {
          const theta = j * 2 * Math.PI / N_VERTS;
          verts.push({ y: ri * Math.cos(theta), z: ri * Math.sin(theta), ring: 'inner' });
        }
        return verts;
      }

      case 'rectangle': {
        const b2 = this.params.width / 2;
        const d2 = this.params.depth / 2;
        // 4 corners: width in z-direction, depth in y-direction.
        // y-direction = bending direction (same as square case).
        return [
          { y:  d2, z:  b2 },   // top-front
          { y:  d2, z: -b2 },   // top-back
          { y: -d2, z: -b2 },   // bottom-back
          { y: -d2, z:  b2 }    // bottom-front
        ];
      }
    }
  }
}
