/**
 * BeamVisualObserver.js
 *
 * Responsibility:
 *   Render the deformed beam as a 3D WEBGL wireframe for any cross-section type
 *   (square, circle, tube, rectangle). Own visual scale, color state, dispMax decay.
 *
 * NOT allowed to:
 *   Mutate physics or modal state, call getDisplacements(), advance time.
 *
 * Called from beam-sketch.js draw() INSIDE the p5 WEBGL context, after
 * orbitControl() and rotateX() have been applied. Uses p5 global drawing
 * functions (stroke, beginShape, vertex, line, etc.) which are available
 * because the sketch runs in p5 global mode.
 *
 * -------------------------------------------------------------------
 * Coordinate convention (WEBGL, +y is DOWN in p5):
 *
 *   Beam axis: world_x = (physX - L/2) * S  (+x = right end of beam)
 *              physX = 0 at left end, L at right end
 *
 *   Bending:   world_y = wBend[i] * bendScale  (+y = down = positive displacement)
 *              wBend[i] is the transverse displacement (m) of slice i.
 *
 *   Extensional: shifts each slice along world_x by uExt[i] * extScale.
 *
 *   Cross-section: vertex coordinates from CrossSection.getVertices() in meters.
 *     Scaled to world units by visScale * S.
 *     visScale=3.0 makes the beam 3x thicker than the physics cross-section
 *     so it's clearly visible at the default camera distance.
 *
 * -------------------------------------------------------------------
 * Wireframe structure:
 *
 *   Longitudinal edges: one polyline per cross-section vertex, running from
 *     slice 0 to slice Nx-1 along the beam length.
 *     For tube: separate outer-ring polylines + inner-ring polylines.
 *
 *   Cross-section rings: at every RING_INTERVAL slices, draw the closed
 *     polygon outline. For tube: outer polygon + inner polygon.
 *
 *   End caps at slice 0 and Nx-1:
 *     Non-tube: closed polygon ring.
 *     Tube: outer polygon + inner polygon + radial lines connecting them
 *           (annular ring, visible when orbiting to look through the ends).
 *
 * -------------------------------------------------------------------
 * Color mode (toggle with C key via toggleColor()):
 *   Off (default): uniform cool-white wireframe.
 *   On: each longitudinal segment colored by bending displacement at midpoint.
 *     Zero / node:          white (255, 255, 255)
 *     Positive bending +y:  purple (170, 70, 240)
 *     Negative bending -y:  green (50, 210, 80)
 *   Color applies to all vertex polylines -- extensional displacement does not
 *   contribute to color (those modes produce no bending, so they stay white).
 *
 * dispMax: decaying peak bending displacement for color normalization.
 *   Updated each draw(): dispMax = max(0.9 * dispMax, curMax), floor 0.005.
 */

class BeamVisualObserver {
  /**
   * @param {Object} cfg
   * @param {number}   cfg.Nx        -- number of spatial points
   * @param {number[]} cfg.spatialX  -- length Nx, x-coordinates of points (m)
   * @param {number}   cfg.L         -- beam length (m), for centering world_x
   * @param {number}   cfg.visScale  -- visual cross-section scale factor (default 3.0).
   *                                    Cross-section vertex coords (m) are multiplied
   *                                    by visScale * S to get world units. Larger =
   *                                    visually thicker beam relative to physics size.
   * @param {number}   cfg.bendScale -- world units per meter of bending displacement
   * @param {number}   cfg.extScale  -- world units per meter of axial displacement
   */
  constructor(cfg) {
    this.Nx        = cfg.Nx;
    this.spatialX  = cfg.spatialX;   // reference; updated from sketch on length/CS change
    this.L         = cfg.L;
    this.visScale  = cfg.visScale  || 3.0;    // visual thickness amplifier
    this.bendScale = cfg.bendScale || 120;    // world units per meter bending
    this.extScale  = cfg.extScale  || 80;     // world units per meter extensional

    // Color toggle. Off by default (uniform white wireframe).
    this.showColor = false;

    // Decaying peak bending displacement for color normalization.
    // Starts at 0.3 so the first strike immediately shows color.
    this.dispMax = 0.3;

    // Cross-section rings drawn every RING_INTERVAL slices.
    // At Nx=100, RING_INTERVAL=10 gives 9 intermediate rings + 2 end caps.
    this.RING_INTERVAL = 10;

    // Surface mode toggle. false = wireframe (default), true = shaded solid.
    // Toggled with F key or surface button via toggleSurface().
    this.surfaceMode = false;
  }

  // ------------------------------------------------------------------
  // toggleColor -- flip showColor. Called from beam-sketch.js keyPressed.
  // ------------------------------------------------------------------
  toggleColor() {
    this.showColor = !this.showColor;
  }

  // ------------------------------------------------------------------
  // toggleSurface -- flip surfaceMode between wireframe and shaded solid.
  // Called from beam-sketch.js keyPressed (F key) and surface button.
  // ------------------------------------------------------------------
  toggleSurface() {
    this.surfaceMode = !this.surfaceMode;
  }

  // ------------------------------------------------------------------
  // draw -- main render entry point, called from beam-sketch.js draw().
  //
  // @param {number[]}    wBend        -- length Nx, y-bending displacements (m)
  // @param {number[]}    wBendZ       -- length Nx, z-bending displacements (m)
  // @param {number[]}    uExt         -- length Nx, extensional displacements (m)
  // @param {number}      S            -- beam scale (world units per meter of beam length)
  // @param {CrossSection} crossSection -- current cross-section (geometry + vertex layout)
  // @param {number[]|null} scaleProfile -- optional length Nx scale factors (1.0 = uniform).
  //                                        Cross-section at slice i is scaled by scaleProfile[i].
  //                                        null or undefined = uniform (all 1.0).
  //
  // Must be called inside p5 draw() after WEBGL transforms have been applied.
  // ------------------------------------------------------------------
  draw(wBend, wBendZ, uExt, S, crossSection, scaleProfile) {
    // Store scale profile for use by all sub-drawing methods this frame.
    // null means uniform (every slice uses the same vs = visScale * S).
    this._sp = scaleProfile || null;

    // --- Update dispMax: decaying peak bending displacement (combined planes) ---
    let curMax = 0;
    for (let k = 0; k < this.Nx; k++) {
      // Use total deflection magnitude: sqrt(y^2 + z^2) for color normalization.
      const a = Math.sqrt(wBend[k] * wBend[k] + wBendZ[k] * wBendZ[k]);
      if (a > curMax) curMax = a;
    }
    this.dispMax = Math.max(0.9 * this.dispMax, curMax);
    if (this.dispMax < 0.005) this.dispMax = 0.005;   // floor: prevent zero-divide

    // vs = visual scale applied to cross-section vertex coordinates.
    // Vertex coords are in meters; multiply by visScale*S to get world units.
    const vs = this.visScale * S;

    // Split vertices into outer and inner rings.
    // For non-tube types, all vertices are "outer" and innerVerts is empty.
    // For tube: outer has 12 vertices, inner has 12 vertices.
    const verts      = crossSection.getVertices();
    const outerVerts = verts.filter(v => v.ring !== 'inner');
    const innerVerts = verts.filter(v => v.ring === 'inner');

    if (this.surfaceMode) {
      // Surface mode: shaded solid with ambient + directional lighting.
      // _drawSurface sets up lighting then draws TRIANGLE_STRIP per longitudinal band.
      // noLights() resets lighting state so subsequent draws (hover spot) use raw colors.
      this._drawSurface(wBend, wBendZ, uExt, S, outerVerts, vs);
      this._drawSurfaceEndCaps(wBend, wBendZ, uExt, S, outerVerts, innerVerts, vs);
      noLights();
    } else {
      // Wireframe mode: no fill, white or colored longitudinal edges + rings.
      noFill();
      if (this.showColor) {
        this._drawColoredLong(wBend, wBendZ, uExt, S, outerVerts, innerVerts, vs);
      } else {
        this._drawWhiteLong(wBend, wBendZ, uExt, S, outerVerts, innerVerts, vs);
      }
      this._drawRings(wBend, wBendZ, uExt, S, outerVerts, innerVerts, vs);
      this._drawEndCaps(wBend, wBendZ, uExt, S, outerVerts, innerVerts, vs);
    }
  }

  // ------------------------------------------------------------------
  // drawHoverSpot -- draw a filled disk on the beam surface at the hovered
  // slice, positioned on the face nearest to the mouse cursor.
  //
  // Called from beam-sketch.js draw() after the main draw(), so it
  // renders on top of the beam wireframe or surface. Draws nothing if
  // info is null (cursor not near beam).
  //
  // Geometry:
  //   Hit surface point: outer vertex with maximum dot product in the
  //   click's incoming direction (-dyNorm, -dzNorm) in the cross-section
  //   plane. This selects the face the user is pointing at.
  //
  //   Disk tangent plane:
  //     T1 = beam axis = (1, 0, 0)
  //     n  = outward surface normal = (0, -dyNorm, -dzNorm)
  //     T2 = n x T1 = (0, -dzNorm, dyNorm)
  //
  //   Disk center = (cx, cy + surfY*vs, cz + surfZ*vs).
  //   Disk radius = maxDot * vs * 0.7 (70% of the surface vertex distance).
  //
  // @param {{ idx: number, dyNorm: number, dzNorm: number } | null} info
  //   -- from controller.getHoverInfo(). null = no hover, draw nothing.
  // @param {number[]}    wBend, wBendZ -- bending displacements (m)
  // @param {number[]}    uExt          -- extensional displacements (m)
  // @param {number}      S             -- beam scale (world units per meter)
  // @param {CrossSection} crossSection  -- current cross-section geometry
  // @param {number[]|null} scaleProfile -- optional per-slice scale factors (taper)
  // ------------------------------------------------------------------
  drawHoverSpot(info, wBend, wBendZ, uExt, S, crossSection, scaleProfile) {
    if (!info) return;

    // End-face hover (extensional hit zone): draw an axial-plane disk in amber.
    // This tells the user they are hovering over the beam tip and will get an
    // extensional compression strike, not a bending side strike.
    if (info.isEndFace) {
      this._drawEndFaceHoverSpot(info.idx, wBend, wBendZ, uExt, S, crossSection, scaleProfile);
      return;
    }

    const { idx, viewY, viewZ } = info;
    const vs         = this.visScale * S;
    // Apply the per-slice taper scale at the hovered slice (idx).
    // vs_s is the actual visual scale at this particular cross-section slice.
    const vs_s       = vs * (scaleProfile && scaleProfile[idx] != null ? scaleProfile[idx] : 1.0);
    const verts      = crossSection.getVertices();
    const outerVerts = verts.filter(v => v.ring !== 'inner');

    const cx = this._cx(idx, uExt, S);
    const cy = this._cy(idx, wBend);
    const cz = this._cz(idx, wBendZ);

    // Find the face MIDPOINT most aligned with (viewY, viewZ).
    // Face midpoint = average of adjacent outer vertex pair.
    // For square/rectangle: the 4 face midpoints land exactly at the center of
    // each flat face (never at a corner), so the disk sits flush on the face.
    // For circle/tube: the midpoint lies on the arc between adjacent vertices.
    const n = outerVerts.length;
    let maxDot = -Infinity;
    let surfY  = 0;
    let surfZ  = 0;
    for (let j = 0; j < n; j++) {
      const j1    = (j + 1) % n;
      const mid_y = (outerVerts[j].y + outerVerts[j1].y) * 0.5;
      const mid_z = (outerVerts[j].z + outerVerts[j1].z) * 0.5;
      const dot   = mid_y * viewY + mid_z * viewZ;
      if (dot > maxDot) {
        maxDot = dot;
        surfY  = mid_y;
        surfZ  = mid_z;
      }
    }

    // Disk center on the beam surface (world coordinates).
    // Use vs_s (the per-slice scaled visual scale) so the disk sits on the
    // actual tapered surface, not the uniform-radius surface.
    const spotCx = cx;
    const spotCy = cy + surfY * vs_s;
    const spotCz = cz + surfZ * vs_s;

    // Disk tangent plane:
    //   n  = (0, viewY, viewZ)   -- outward face normal (toward camera)
    //   T1 = (1, 0, 0)           -- beam axis
    //   T2 = n x T1 = (0, viewZ, -viewY)  -- perpendicular in cross-section plane
    const t2y =  viewZ;
    const t2z = -viewY;

    // Disk radius: 70% of the distance from beam center to face midpoint.
    // Use vs_s so the disk is proportional to the tapered cross-section at this slice.
    const faceDist = Math.sqrt(surfY * surfY + surfZ * surfZ);
    const radius   = faceDist * vs_s * 0.7;

    const DISK_SEGS = 16;   // 16-sided polygon approximates a circle

    // Reset any active lighting so the spot renders with raw fill/stroke colors.
    noLights();

    push();

    // Filled semi-transparent disk (TRIANGLE_FAN from center to perimeter).
    noStroke();
    fill(110, 200, 255, 90);   // translucent cyan-blue
    beginShape(TRIANGLE_FAN);
    vertex(spotCx, spotCy, spotCz);   // fan center
    for (let j = 0; j <= DISK_SEGS; j++) {
      const theta = (j / DISK_SEGS) * 2 * Math.PI;
      const a = Math.cos(theta) * radius;   // T1 component (beam axis)
      const b = Math.sin(theta) * radius;   // T2 component (in-plane perp)
      vertex(
        spotCx + a,
        spotCy + b * t2y,
        spotCz + b * t2z
      );
    }
    endShape();

    // Outline ring.
    noFill();
    stroke(110, 200, 255, 230);   // bright cyan-blue
    strokeWeight(1.5);
    beginShape();
    for (let j = 0; j <= DISK_SEGS; j++) {
      const theta = (j / DISK_SEGS) * 2 * Math.PI;
      const a = Math.cos(theta) * radius;
      const b = Math.sin(theta) * radius;
      vertex(
        spotCx + a,
        spotCy + b * t2y,
        spotCz + b * t2z
      );
    }
    endShape(CLOSE);

    pop();
  }

  // ------------------------------------------------------------------
  // _cx -- world_x (beam axis) for slice i.
  //   world_x = (spatialX[i] - L/2) * S + uExt[i] * extScale
  // ------------------------------------------------------------------
  _cx(i, uExt, S) {
    return (this.spatialX[i] - this.L / 2) * S + uExt[i] * this.extScale;
  }

  // ------------------------------------------------------------------
  // _cy -- world_y (y-bending) for slice i.
  //   world_y = wBend[i] * bendScale  (+y is down in WEBGL)
  // ------------------------------------------------------------------
  _cy(i, wBend) {
    return wBend[i] * this.bendScale;
  }

  // ------------------------------------------------------------------
  // _cz -- world_z (z-bending) for slice i.
  //   world_z = wBendZ[i] * bendScale  (+z is toward viewer in p5 WEBGL)
  //   For isotropic sections this is zero by default; for rectangle with
  //   lateral strike this shifts the whole cross-section in z each frame.
  // ------------------------------------------------------------------
  _cz(i, wBendZ) {
    return wBendZ[i] * this.bendScale;
  }

  // ------------------------------------------------------------------
  // _segColor -- stroke color [r,g,b,a] for a bending displacement d.
  //
  // Matches membrane's segColor scheme:
  //   d = 0 --> white (255, 255, 255)
  //   d > 0 --> lerp white to purple (170, 70, 240)
  //   d < 0 --> lerp white to green  (50, 210, 80)
  // ------------------------------------------------------------------
  _segColor(d) {
    const norm = Math.min(Math.abs(d) / this.dispMax, 1.0);
    const lr = (hue) => Math.round(255 + (hue - 255) * norm);
    const alpha = 200;
    if (d >= 0) {
      return [lr(170), lr(70), lr(240), alpha];   // white --> purple
    } else {
      return [lr(50), lr(210), lr(80), alpha];     // white --> green
    }
  }

  // ------------------------------------------------------------------
  // _drawWhiteLong -- draw one white polyline per cross-section vertex,
  // running from slice 0 to Nx-1 along the beam length.
  //
  // One beginShape/endShape per vertex = efficient batching.
  // Outer ring first, then inner ring (for tube: 24 polylines total).
  // ------------------------------------------------------------------
  _drawWhiteLong(wBend, wBendZ, uExt, S, outerVerts, innerVerts, vs) {
    stroke(210, 212, 215, 170);   // cool white, matches membrane default
    strokeWeight(1.0);

    const Nx = this.Nx;

    // Draw all vertex polylines. For tube: outer 12 + inner 12.
    const allVerts = outerVerts.concat(innerVerts);
    for (let v = 0; v < allVerts.length; v++) {
      const vert = allVerts[v];
      beginShape();
      for (let i = 0; i < Nx; i++) {
        // Per-slice visual scale: scaleProfile[i] shrinks or enlarges the
        // cross-section at this slice (tapered beam shape).
        // For uniform beams, _sp is null and vs_i == vs for all i.
        const vs_i = vs * (this._sp ? this._sp[i] : 1.0);
        // world_z includes z-bending displacement + cross-section z-offset.
        vertex(
          this._cx(i, uExt, S),
          this._cy(i, wBend) + vert.y * vs_i,
          this._cz(i, wBendZ) + vert.z * vs_i
        );
      }
      endShape();
    }
  }

  // ------------------------------------------------------------------
  // _drawColoredLong -- draw longitudinal polylines with per-segment coloring.
  //
  // One line() call per segment per vertex. Bending displacement at the
  // segment midpoint determines the hue. Extensional shift affects position
  // but not color (extensional modes produce no transverse bending).
  // ------------------------------------------------------------------
  _drawColoredLong(wBend, wBendZ, uExt, S, outerVerts, innerVerts, vs) {
    strokeWeight(1.0);
    const Nx = this.Nx;

    const allVerts = outerVerts.concat(innerVerts);
    for (let v = 0; v < allVerts.length; v++) {
      const vert = allVerts[v];
      for (let i = 0; i < Nx - 1; i++) {
        // Color by midpoint y-bending displacement (purple/green = y-deflection direction).
        // Z-bending affects position but not color -- it has no inherent up/down sign.
        const dMid = (wBend[i] + wBend[i + 1]) * 0.5;
        const c = this._segColor(dMid);
        stroke(c[0], c[1], c[2], c[3]);
        // Per-slice scale for each endpoint of this segment.
        const vs_i  = vs * (this._sp ? this._sp[i]     : 1.0);
        const vs_i1 = vs * (this._sp ? this._sp[i + 1] : 1.0);
        line(
          this._cx(i,   uExt, S), this._cy(i,   wBend) + vert.y * vs_i,  this._cz(i,   wBendZ) + vert.z * vs_i,
          this._cx(i+1, uExt, S), this._cy(i+1, wBend) + vert.y * vs_i1, this._cz(i+1, wBendZ) + vert.z * vs_i1
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // _drawPolyRing -- draw one closed cross-section polygon at world (cx, cy, cz).
  //
  // Connects vertices in order: v[0]->v[1]->...->v[n-1]->v[0].
  // Used for both rings and end caps.
  //
  // @param {number}   cx   -- world_x center of slice
  // @param {number}   cy   -- world_y center of slice (y-bending displacement)
  // @param {number}   cz   -- world_z center of slice (z-bending displacement)
  // @param {Array}    verts -- ring vertices [{y,z}, ...]
  // @param {number}   vs   -- visual scale (visScale * S)
  // ------------------------------------------------------------------
  _drawPolyRing(cx, cy, cz, verts, vs) {
    const n = verts.length;
    for (let j = 0; j < n; j++) {
      const v0 = verts[j];
      const v1 = verts[(j + 1) % n];
      line(
        cx, cy + v0.y * vs, cz + v0.z * vs,
        cx, cy + v1.y * vs, cz + v1.z * vs
      );
    }
  }

  // ------------------------------------------------------------------
  // _drawRadialLines -- connect outer to inner ring vertices at a slice.
  //
  // For tube end caps: draws one radial line per angular position,
  // producing an annular ring that reveals the hollow bore when the
  // user orbits to look through the end of the beam.
  //
  // @param {number} cx, cy, cz -- slice world position
  // @param {Array}  outerV -- outer ring vertices
  // @param {Array}  innerV -- inner ring vertices (same angular order as outer)
  // @param {number} vs     -- visual scale
  // ------------------------------------------------------------------
  _drawRadialLines(cx, cy, cz, outerV, innerV, vs) {
    for (let j = 0; j < outerV.length; j++) {
      const vo = outerV[j];
      const vi = innerV[j];
      line(
        cx, cy + vo.y * vs, cz + vo.z * vs,
        cx, cy + vi.y * vs, cz + vi.z * vs
      );
    }
  }

  // ------------------------------------------------------------------
  // _drawRings -- draw cross-section polygons at every RING_INTERVAL slices.
  //
  // Rings are drawn in dim gray. They reveal the cross-section shape and
  // provide 3D depth cues without competing with the colored longitudinal edges.
  // Slices 0 and Nx-1 (the ends) are drawn by _drawEndCaps, not here.
  // ------------------------------------------------------------------
  _drawRings(wBend, wBendZ, uExt, S, outerVerts, innerVerts, vs) {
    stroke(120, 122, 130, 100);   // dim gray
    strokeWeight(0.5);

    const interval = this.RING_INTERVAL;
    for (let i = interval; i < this.Nx - 1; i += interval) {
      const cx  = this._cx(i, uExt, S);
      const cy  = this._cy(i, wBend);
      const cz  = this._cz(i, wBendZ);
      // Per-slice scale: tapered cross-section has different radius at each ring.
      const vs_i = vs * (this._sp ? this._sp[i] : 1.0);
      this._drawPolyRing(cx, cy, cz, outerVerts, vs_i);
      if (innerVerts.length > 0) {
        this._drawPolyRing(cx, cy, cz, innerVerts, vs_i);
        // No radial lines on intermediate rings (only end caps get them).
      }
    }
  }

  // ------------------------------------------------------------------
  // _drawSurface -- render the beam as a shaded solid.
  //
  // Draws one TRIANGLE_STRIP per longitudinal band (from vertex j to vertex
  // (j+1)%n around the ring), running the full beam length. Each band forms
  // a planar quad strip connecting adjacent cross-section edges along the beam.
  //
  // Lighting: ambient + directional from upper-front-left for a cool steel look.
  // p5.js auto-computes face normals from the triangle vertices, giving flat
  // shading per triangle (smooth on circle sections, faceted on square/rect).
  //
  // Only the outer ring is rendered (inner bore is not visible from outside).
  // End caps are handled separately by _drawSurfaceEndCaps.
  //
  // @param {number[]} wBend, wBendZ, uExt -- displacements (m)
  // @param {number}   S                   -- beam scale (world units per meter)
  // @param {Array}    outerVerts          -- outer ring vertices [{y,z}, ...]
  // @param {number}   vs                  -- visual scale (visScale * S)
  // ------------------------------------------------------------------
  _drawSurface(wBend, wBendZ, uExt, S, outerVerts, vs) {
    const n  = outerVerts.length;
    const Nx = this.Nx;

    // Lighting: cool ambient + blue-white directional from upper-front-left.
    ambientLight(55, 60, 75);
    directionalLight(190, 200, 220, -0.3, -0.85, -0.4);

    noStroke();
    fill(50, 65, 105);   // dark steel-blue base color

    // One TRIANGLE_STRIP per longitudinal band (vertex j to j+1 around ring).
    // For each band, push one pair of cross-section vertices at every slice,
    // forming a quad strip (two triangles per beam segment).
    for (let j = 0; j < n; j++) {
      const j1  = (j + 1) % n;
      const vj  = outerVerts[j];
      const vj1 = outerVerts[j1];

      beginShape(TRIANGLE_STRIP);
      for (let i = 0; i < Nx; i++) {
        const cx  = this._cx(i, uExt, S);
        const cy  = this._cy(i, wBend);
        const cz  = this._cz(i, wBendZ);
        // Per-slice scale for tapered cross-section rendering.
        const vs_i = vs * (this._sp ? this._sp[i] : 1.0);
        // Push both edge vertices at this slice.
        // TRIANGLE_STRIP alternates: (i,j),(i,j+1),(i+1,j),(i+1,j+1),...
        // forming two triangles per segment quad.
        vertex(cx, cy + vj.y  * vs_i, cz + vj.z  * vs_i);
        vertex(cx, cy + vj1.y * vs_i, cz + vj1.z * vs_i);
      }
      endShape();
    }
  }

  // ------------------------------------------------------------------
  // _drawSurfaceEndCaps -- render filled end faces at slice 0 and Nx-1.
  //
  // Solid sections (square, circle, rectangle):
  //   TRIANGLE_FAN from center to all outer vertices.
  // Tube:
  //   QUAD_STRIP from outer to inner ring -- annular face revealing the bore.
  //
  // Normal direction: -x for left end, +x for right end (along beam axis).
  //
  // @param {number[]} wBend, wBendZ, uExt -- displacements (m)
  // @param {number}   S                   -- beam scale
  // @param {Array}    outerVerts          -- outer ring vertices [{y,z}, ...]
  // @param {Array}    innerVerts          -- inner ring vertices (empty if solid)
  // @param {number}   vs                  -- visual scale
  // ------------------------------------------------------------------
  _drawSurfaceEndCaps(wBend, wBendZ, uExt, S, outerVerts, innerVerts, vs) {
    noStroke();
    fill(45, 58, 95);   // slightly darker than side faces

    const ends = [0, this.Nx - 1];

    for (let e = 0; e < ends.length; e++) {
      const i   = ends[e];
      const cx  = this._cx(i, uExt, S);
      const cy  = this._cy(i, wBend);
      const cz  = this._cz(i, wBendZ);
      // Per-end scale: left end uses scaleProfile[0], right end uses scaleProfile[Nx-1].
      const vs_e = vs * (this._sp ? this._sp[i] : 1.0);

      if (innerVerts.length === 0) {
        // Solid section: TRIANGLE_FAN from center to outer ring.
        beginShape(TRIANGLE_FAN);
        vertex(cx, cy, cz);   // center vertex
        for (let j = 0; j <= outerVerts.length; j++) {
          const v = outerVerts[j % outerVerts.length];
          vertex(cx, cy + v.y * vs_e, cz + v.z * vs_e);
        }
        endShape();
      } else {
        // Tube: QUAD_STRIP between outer and inner rings.
        // Each pair (outer_j, inner_j) followed by (outer_{j+1}, inner_{j+1})
        // forms one annular quad, closing the hollow bore at the end face.
        beginShape(QUAD_STRIP);
        for (let j = 0; j <= outerVerts.length; j++) {
          const vo = outerVerts[j % outerVerts.length];
          const vi = innerVerts[j % innerVerts.length];
          vertex(cx, cy + vo.y * vs_e, cz + vo.z * vs_e);
          vertex(cx, cy + vi.y * vs_e, cz + vi.z * vs_e);
        }
        endShape();
      }
    }
  }

  // ------------------------------------------------------------------
  // _drawEndCaps -- draw the cross-section polygon at slice 0 and Nx-1.
  //
  // End caps are drawn brighter than intermediate rings. In color mode,
  // they take the hue of the bending displacement at that end slice.
  // For tube: also draw radial lines connecting outer to inner polygon,
  // producing the annular ring that reveals the hollow bore.
  // ------------------------------------------------------------------
  // ------------------------------------------------------------------
  // _drawEndFaceHoverSpot -- draw an amber disk on the beam end face at slice idx.
  //
  // Used when the cursor is in the END_ZONE (outer 5% of beam length). The disk
  // lies in the y-z plane (perpendicular to the beam axis), clearly indicating an
  // axial / extensional strike rather than a transverse bending strike.
  //
  // Disk geometry:
  //   Center: centerline of the end slice (cx, cy, cz).
  //   Plane:  world y-z (cos(theta) drives world_y, sin(theta) drives world_z).
  //   Radius: 85% of the outermost vertex radius, in world units (scaled by vs_s).
  //
  // Color: amber / orange -- distinct from the cyan side-face disk.
  //
  // @param {number}      idx          -- end slice index (0 or Nx-1)
  // @param {number[]}    wBend, wBendZ -- bending displacements (m)
  // @param {number[]}    uExt          -- extensional displacements (m)
  // @param {number}      S             -- beam scale (world units per meter)
  // @param {CrossSection} crossSection  -- current cross-section geometry
  // @param {number[]|null} scaleProfile -- optional per-slice scale factors
  // ------------------------------------------------------------------
  _drawEndFaceHoverSpot(idx, wBend, wBendZ, uExt, S, crossSection, scaleProfile) {
    const vs   = this.visScale * S;
    const vs_s = vs * (scaleProfile && scaleProfile[idx] != null ? scaleProfile[idx] : 1.0);

    const verts      = crossSection.getVertices();
    const outerVerts = verts.filter(v => v.ring !== 'inner');

    const cx = this._cx(idx, uExt, S);
    const cy = this._cy(idx, wBend);
    const cz = this._cz(idx, wBendZ);

    // Radius: max distance from center to outer vertex, scaled to world units.
    // 0.85 factor so the disk fits inside the cross-section boundary.
    let maxR = 0;
    for (let j = 0; j < outerVerts.length; j++) {
      const r = Math.sqrt(outerVerts[j].y * outerVerts[j].y + outerVerts[j].z * outerVerts[j].z);
      if (r > maxR) maxR = r;
    }
    const radius = maxR * vs_s * 0.85;

    const DISK_SEGS = 16;

    noLights();
    push();

    // Filled semi-transparent disk in amber: extensional (axial) hit indicator.
    noStroke();
    fill(255, 165, 55, 85);
    beginShape(TRIANGLE_FAN);
    vertex(cx, cy, cz);   // fan center
    for (let j = 0; j <= DISK_SEGS; j++) {
      const theta = (j / DISK_SEGS) * 2 * Math.PI;
      // Disk in the y-z plane: beam axis (world_x) does not vary.
      vertex(cx, cy + Math.cos(theta) * radius, cz + Math.sin(theta) * radius);
    }
    endShape();

    // Outline ring in bright amber.
    noFill();
    stroke(255, 195, 70, 225);
    strokeWeight(1.5);
    beginShape();
    for (let j = 0; j <= DISK_SEGS; j++) {
      const theta = (j / DISK_SEGS) * 2 * Math.PI;
      vertex(cx, cy + Math.cos(theta) * radius, cz + Math.sin(theta) * radius);
    }
    endShape(CLOSE);

    pop();
  }

  // ------------------------------------------------------------------
  // _drawEndCaps -- draw the cross-section polygon at slice 0 and Nx-1.
  //
  // End caps are drawn brighter than intermediate rings. In color mode,
  // they take the hue of the bending displacement at that end slice.
  // For tube: also draw radial lines connecting outer to inner polygon,
  // producing the annular ring that reveals the hollow bore.
  // ------------------------------------------------------------------
  _drawEndCaps(wBend, wBendZ, uExt, S, outerVerts, innerVerts, vs) {
    strokeWeight(1.5);

    const ends = [0, this.Nx - 1];

    for (let e = 0; e < ends.length; e++) {
      const i   = ends[e];
      const cx  = this._cx(i, uExt, S);
      const cy  = this._cy(i, wBend);
      const cz  = this._cz(i, wBendZ);
      // Per-end scale: left end uses scaleProfile[0], right end uses scaleProfile[Nx-1].
      const vs_e = vs * (this._sp ? this._sp[i] : 1.0);

      if (this.showColor) {
        const c = this._segColor(wBend[i]);
        stroke(c[0], c[1], c[2], c[3]);
      } else {
        stroke(180, 185, 200, 200);   // slightly brighter than rings
      }

      this._drawPolyRing(cx, cy, cz, outerVerts, vs_e);

      if (innerVerts.length > 0) {
        this._drawPolyRing(cx, cy, cz, innerVerts, vs_e);
        this._drawRadialLines(cx, cy, cz, outerVerts, innerVerts, vs_e);
      }
    }
  }
}
