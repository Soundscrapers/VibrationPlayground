/**
 * MembraneVisualObserver.js
 *
 * Responsibility:
 *   Render the vibrating membrane as a 3D WEBGL wireframe mesh.
 *   Owns two pieces of visual state:
 *     - dispMax: decaying peak displacement for color normalization
 *     - showColor: whether to color wire segments by displacement sign
 *
 * NOT allowed to:
 *   Mutate physics or modal state, call getDisplacements(), advance time.
 *
 * Called from membrane-sketch.js draw() INSIDE the p5 WEBGL context, after
 * orbitControl() and rotateX() have been applied. Uses p5 global drawing
 * functions (stroke, strokeWeight, line, beginShape, vertex, endShape, noFill)
 * which are available because the sketch runs in p5 global mode.
 *
 * -------------------------------------------------------------------
 * Coordinate convention (WEBGL, +y is DOWN in p5):
 *
 *   world_x = (physX - Lx/2) * S       (+x = right)
 *   world_y = -(physY - Ly/2) * S      (flip: physY=0 is bottom of screen)
 *   world_z = displacement * zScale    (+z = toward viewer at rest)
 *
 *   S (MESH_SCALE, pixels/meter) is computed by the sketch from canvas
 *   dimensions and current Lx/Ly, then passed into draw() each frame.
 *
 * -------------------------------------------------------------------
 * Mesh layout:
 *   (Nx+2) columns (0..Nx+1): col 0 = left boundary, col Nx+1 = right boundary.
 *   (Ny+2) rows   (0..Ny+1): row 0 = bottom boundary, row Ny+1 = top boundary.
 *   Interior points (col=1..Nx, row=1..Ny): disp[(row-1)*Nx + (col-1)] * zScale.
 *   Boundary: z=0 if fixed; z=nearest interior neighbor if free (Neumann BC).
 *
 * -------------------------------------------------------------------
 * Wireframe rendering (showColor = false, default):
 *   Uniform cool-white stroke rgb(210, 212, 215, 170).
 *   Batched as horizontal polylines (one per row) + vertical polylines (one per col).
 *
 * Color rendering (showColor = true, toggled by toggleColor()):
 *   Each wire segment colored by displacement at its midpoint.
 *   Zero / low amplitude  --> white (same as uncolored baseline)
 *   High positive (+z)    --> purple rgb(170, 70, 240)
 *   High negative (-z)    --> green  rgb(50, 210, 80)
 *   One line() call per segment; more expensive than polylines but needed for per-segment color.
 *
 * -------------------------------------------------------------------
 * dispMax:
 *   Tracks a decaying peak displacement for color normalization.
 *   Updated each frame: dispMax = max(0.9 * dispMax, curMax); floor = 0.005.
 *   Decays at 5%/frame so quiet membranes stay colorful without clipping active ones.
 *   Exposed as a public property so membrane-sketch.js can reset it on preset changes.
 *
 * -------------------------------------------------------------------
 * Boundary edge indicators:
 *   Four thick lines along the perimeter at world_z = 0.
 *   fixed edge: bright white-blue stroke rgb(200, 200, 220, 220).
 *   free edge:  dim gray stroke rgb(60, 60, 80, 160).
 */

class MembraneVisualObserver {

  /**
   * @param {Object} cfg
   * @param {number} cfg.zScale  -- world units per meter of displacement (Z_SCALE in sketch)
   */
  constructor(cfg) {
    this.zScale   = cfg.zScale;   // pixels per meter of physical displacement

    // Visual state owned by this observer.
    this.dispMax   = 0.3;    // decaying peak displacement for color normalization (m)
    this.showColor = false;  // true = color wireframe, false = uniform white wireframe
  }

  // ---------------------------------------------------------------------------
  // draw -- render the full membrane scene for one frame.
  //
  // Must be called INSIDE the p5 WEBGL context, AFTER:
  //   - orbitControl() (camera navigation)
  //   - rotateX() (base model tilt)
  //   - controller.updateProjections() (hit-test state)
  //
  // Updates dispMax from current displacements, then draws the wireframe mesh
  // and the boundary edge indicators.
  //
  // @param {number[]}         disp        -- length Ntot = Nx*Ny interior displacements (m)
  // @param {MembraneDefinition} membraneDef -- physics definition (read-only)
  // @param {number}           S           -- mesh scale (pixels per meter, computed by sketch)
  // ---------------------------------------------------------------------------
  // @param {string|null} hoverEdge -- edge name currently hovered ('left', 'right',
  //                                   'top', 'bottom') or null; from controller.hoverEdge
  draw(disp, membraneDef, S, hoverEdge) {
    // --- Update decaying displacement max for color normalization ---
    // curMax = largest absolute displacement this frame.
    // dispMax decays by 5% per frame so quiet membranes stay colorful.
    // Floor at 0.005 prevents zero-divide on a silent membrane.
    let curMax = 0;
    for (let k = 0; k < disp.length; k++) {
      const absD = Math.abs(disp[k]);
      if (absD > curMax) curMax = absD;
    }
    this.dispMax = Math.max(0.9 * this.dispMax, curMax);
    if (this.dispMax < 0.005) this.dispMax = 0.005;

    this._drawSurface(disp, membraneDef, S);
    this._drawBoundaryEdges(membraneDef, S, hoverEdge);
  }

  // ---------------------------------------------------------------------------
  // toggleColor -- flip the color overlay on/off.
  //
  // Returns the new showColor value so the caller can sync a button's active class.
  // ---------------------------------------------------------------------------
  toggleColor() {
    this.showColor = !this.showColor;
    return this.showColor;
  }

  // ---------------------------------------------------------------------------
  // _drawSurface -- draw the interior + boundary wireframe mesh.
  //
  // Grid coordinates: col = 0..Nx+1, row = 0..Ny+1.
  //   Interior (col=1..Nx, row=1..Ny): displacement from disp[], scaled by zScale.
  //   Boundary ring: z=0 if fixed; z=nearest interior neighbor if free.
  //   Corners: free only when BOTH adjacent edges are free.
  //
  // Colored mode: one line() per segment, colored by midpoint displacement.
  // Uncolored mode: beginShape/vertex/endShape polylines -- one per row/col.
  //
  // @param {number[]}           disp        -- length Ntot interior displacements (m)
  // @param {MembraneDefinition} membraneDef -- domain geometry and boundary conditions
  // @param {number}             S           -- mesh scale (pixels per meter)
  // ---------------------------------------------------------------------------
  _drawSurface(disp, membraneDef, S) {
    const def = membraneDef;
    const Lx  = def.Lx;
    const Ly  = def.Ly;
    const Nx  = def.Nx;
    const Ny  = def.Ny;
    const Z   = this.zScale;

    // Boundary condition flags.
    const leftFree   = def.boundaryLeft   === 'free';
    const rightFree  = def.boundaryRight  === 'free';
    const bottomFree = def.boundaryBottom === 'free';
    const topFree    = def.boundaryTop    === 'free';

    // Helper: world_z at grid position (col, row), col = 0..Nx+1, row = 0..Ny+1.
    //
    // Interior (col=1..Nx, row=1..Ny): disp[(row-1)*Nx + (col-1)] * zScale.
    //
    // Boundary ring:
    //   Fixed edge: z = 0 (membrane is clamped, displacement is exactly zero).
    //   Free edge:  z = nearest interior neighbor (Neumann condition du/dn = 0;
    //               displacement does not change across the boundary to first order).
    //
    // Corners: free only if BOTH adjacent edges are free -- a single fixed
    //   adjacent edge forces zero at that corner.
    const worldZ = (col, row) => {
      if (col >= 1 && col <= Nx && row >= 1 && row <= Ny) {
        return disp[(row - 1) * Nx + (col - 1)] * Z;   // interior point
      }

      // Identify which boundary edge(s) this point lies on.
      const onLeft   = (col === 0);
      const onRight  = (col === Nx + 1);
      const onBottom = (row === 0);
      const onTop    = (row === Ny + 1);

      // Corner: free only if both adjacent edges are free.
      // Pure edge (not corner): free if that edge is free.
      let isFree;
      const isCorner = (onLeft || onRight) && (onBottom || onTop);
      if (isCorner) {
        const hFree = onLeft ? leftFree : rightFree;
        const vFree = onBottom ? bottomFree : topFree;
        isFree = hFree && vFree;
      } else if (onLeft)   { isFree = leftFree;   }
        else if (onRight)  { isFree = rightFree;  }
        else if (onBottom) { isFree = bottomFree; }
        else               { isFree = topFree;    }  // onTop

      if (!isFree) return 0;   // fixed: clamp to zero

      // Free: inherit displacement from nearest interior grid point.
      // Clamping: boundary col=0 maps to interior col=1, etc.
      const icol = Math.max(1, Math.min(Nx, col));
      const irow = Math.max(1, Math.min(Ny, row));
      return disp[(irow - 1) * Nx + (icol - 1)] * Z;
    };

    // Helper: world_x from column index (col = 0..Nx+1).
    // physX = col * hx, where hx = Lx / (Nx+1).
    // Center-shifted by Lx/2 and scaled to pixels.
    const worldX = (col) => {
      const physX = col * (Lx / (Nx + 1));
      return (physX - Lx / 2) * S;
    };

    // Helper: world_y from row index (row = 0..Ny+1).
    // physY = row * hy, where hy = Ly / (Ny+1).
    // Negated so physY=0 (bottom) maps to positive world_y (down in WEBGL).
    const worldY = (row) => {
      const physY = row * (Ly / (Ny + 1));
      return -(physY - Ly / 2) * S;
    };

    // Helper: RGBA stroke color for a wire segment at midpoint displacement d (m).
    // Used only when showColor is true.
    //
    // Scheme: lerp from white (norm=0, zero displacement) to full hue (norm=1, antinode).
    //   High positive (+z): purple rgb(170, 70, 240).
    //   High negative (-z): green  rgb(50, 210, 80).
    // Returns [r, g, b, a] as integers 0..255.
    const segColor = (d) => {
      const norm = Math.min(Math.abs(d) / this.dispMax, 1.0);
      // lr: linear interpolation from white component (255) to target hue component.
      const lr = (hue) => Math.round(255 + (hue - 255) * norm);
      const alpha = 200;   // constant: the uncolored baseline is also opaque
      if (d >= 0) {
        // White (255,255,255) --> purple (170, 70, 240)
        return [lr(170), lr(70), lr(240), alpha];
      } else {
        // White (255,255,255) --> green (50, 210, 80)
        return [lr(50), lr(210), lr(80), alpha];
      }
    };

    noFill();

    if (this.showColor) {
      // --- Colored wireframe: one line() per segment ---
      // Each segment colored by midpoint displacement. line(x1,y1,z1, x2,y2,z2).
      strokeWeight(0.5);

      // Horizontal segments: col -> col+1 along each row.
      for (let row = 0; row <= Ny + 1; row++) {
        for (let col = 0; col <= Nx; col++) {
          const z1   = worldZ(col,     row);
          const z2   = worldZ(col + 1, row);
          // Midpoint displacement in physical units (undo zScale).
          const dMid = (z1 + z2) / (2 * Z);
          const c    = segColor(dMid);
          stroke(c[0], c[1], c[2], c[3]);
          line(worldX(col), worldY(row), z1, worldX(col + 1), worldY(row), z2);
        }
      }

      // Vertical segments: row -> row+1 along each column.
      for (let col = 0; col <= Nx + 1; col++) {
        for (let row = 0; row <= Ny; row++) {
          const z1   = worldZ(col, row);
          const z2   = worldZ(col, row + 1);
          const dMid = (z1 + z2) / (2 * Z);
          const c    = segColor(dMid);
          stroke(c[0], c[1], c[2], c[3]);
          line(worldX(col), worldY(row), z1, worldX(col), worldY(row + 1), z2);
        }
      }

    } else {
      // --- Uncolored wireframe: uniform cool-white, batched polylines ---
      // beginShape/vertex/endShape avoids per-segment stroke() calls.
      strokeWeight(0.5);
      stroke(210, 212, 215, 170);   // cool white, matches zero-amplitude color in color mode

      // Horizontal polylines: one per row (including boundary rows 0 and Ny+1).
      for (let row = 0; row <= Ny + 1; row++) {
        beginShape();
        for (let col = 0; col <= Nx + 1; col++) {
          vertex(worldX(col), worldY(row), worldZ(col, row));
        }
        endShape();
      }

      // Vertical polylines: one per column (including boundary columns 0 and Nx+1).
      for (let col = 0; col <= Nx + 1; col++) {
        beginShape();
        for (let row = 0; row <= Ny + 1; row++) {
          vertex(worldX(col), worldY(row), worldZ(col, row));
        }
        endShape();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // _drawBoundaryEdges -- draw four thick lines just outside the membrane perimeter.
  //
  // Lines are drawn at EDGE_OUTSET world pixels beyond the true membrane boundary.
  // This prevents z-fighting with the mesh boundary ring (both at world_z=0).
  // Must match EDGE_OUTSET_PX in MembraneInteractionController.
  //
  //   fixed edge: bright white-blue rgb(200, 200, 220, 220)
  //   free edge:  dim gray          rgb(60,  60,  80,  160)
  //   hovered:    bright warm white rgb(255, 255, 190, 255) -- shows toggle affordance
  //
  // @param {MembraneDefinition} membraneDef -- provides Lx, Ly, boundary condition strings
  // @param {number}             S           -- mesh scale (pixels per meter)
  // @param {string|null}        hoverEdge   -- edge name currently hovered, or null
  // ---------------------------------------------------------------------------
  _drawBoundaryEdges(membraneDef, S, hoverEdge) {
    const def = membraneDef;
    const Lx  = def.Lx;
    const Ly  = def.Ly;

    // EDGE_OUTSET: offset each line outward from the true boundary to avoid z-fighting
    // with the wireframe mesh boundary ring (which sits at z=0 along the same lines).
    // Must match MembraneInteractionController.EDGE_OUTSET_PX.
    const EDGE_OUTSET = 4;   // world pixels

    const xL = (-Lx / 2) * S - EDGE_OUTSET;   // left edge, shifted left
    const xR = ( Lx / 2) * S + EDGE_OUTSET;   // right edge, shifted right
    const yB = ( Ly / 2) * S + EDGE_OUTSET;   // bottom edge (+y is down), shifted down
    const yT = (-Ly / 2) * S - EDGE_OUTSET;   // top edge, shifted up

    noFill();
    strokeWeight(3);

    // Helper: set stroke color for one boundary edge.
    //   isHovered=true: bright warm white-yellow -- communicates that a click will
    //                    toggle this edge's boundary condition.
    //   fixed:           bright white-blue = clamped.
    //   free:            dim gray = free (Neumann).
    const edgeColor = (bc, isHovered) => {
      if (isHovered)          stroke(255, 255, 190, 255);  // bright hover highlight
      else if (bc === 'fixed') stroke(200, 200, 220, 220);  // white-blue = clamped
      else                     stroke(60,  60,  80,  160);  // dim gray = free
    };

    // Left edge: spans bottom-left to top-left of the outset rectangle.
    edgeColor(def.boundaryLeft,   hoverEdge === 'left');
    line(xL, yB, 0,  xL, yT, 0);

    // Right edge.
    edgeColor(def.boundaryRight,  hoverEdge === 'right');
    line(xR, yB, 0,  xR, yT, 0);

    // Bottom edge.
    edgeColor(def.boundaryBottom, hoverEdge === 'bottom');
    line(xL, yB, 0,  xR, yB, 0);

    // Top edge.
    edgeColor(def.boundaryTop,    hoverEdge === 'top');
    line(xL, yT, 0,  xR, yT, 0);

    noStroke();
  }
}
