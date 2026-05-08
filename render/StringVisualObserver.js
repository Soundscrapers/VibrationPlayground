/**
 * StringVisualObserver.js
 *
 * Responsibility:
 * - Render the string's current physical state as a polyline on the p5 canvas.
 * - Draw endpoint indicators: filled circle = fixed, open ring = free.
 * - Optionally overlay individual mode shape contributions.
 * - Draw cursor feedback when the pointer is over the string.
 *
 * NOT allowed to:
 * - Mutate ModalState or StringDefinition.
 * - Advance time.
 * - Produce sound.
 *
 * -------------------------------------------------------------------
 * Coordinate system
 *
 * Physical x in [0, L] maps to canvas x in [screenGeom.xLeft, screenGeom.xRight].
 * Physical transverse displacement u maps to canvas y:
 *   screenY = yCenter - u * yScale
 * Positive displacement is UP on screen (matches physical convention).
 *
 * Spatial points are interior to the boundary (see StringDefinition):
 *   spatialX[i] = (i+1) * L / (Nx+1),  i = 0, ..., Nx-1
 * Screen x for interior point i:
 *   screenX[i] = xLeft + (i+1) * Lx / (Nx+1)
 * Endpoints at x=0 (xLeft) and x=L (xRight) are drawn separately.
 *
 * Canvas background: background(220) = light gray. All string elements
 * are drawn dark so they read against the light canvas.
 * -------------------------------------------------------------------
 */

class StringVisualObserver {

  /**
   * constructor
   *
   * @param {Object} dims       -- canvas dims: { canvasWidth, canvasHeight, s }
   *                               s = pixel-density scale factor (1 for standard displays).
   * @param {Object} stringDef  -- initial StringDefinition (boundary types etc.)
   * @param {Object} screenGeom -- precomputed screen geometry, computed once in sketch.js:
   *                               { xLeft, xRight, Lx, yCenter, yScale }
   *                               xLeft  = left anchor pixel x
   *                               xRight = right anchor pixel x
   *                               Lx     = xRight - xLeft (pixel length of string)
   *                               yCenter = canvas vertical midpoint (string rest position)
   *                               yScale  = pixels per meter of displacement
   */
  constructor(dims, stringDef, screenGeom) {

    // Canvas pixel dimensions
    this.canvasWidth  = dims.canvasWidth;
    this.canvasHeight = dims.canvasHeight;

    // Pixel-density scale factor.
    // Stroke weights and circle radii multiply by s so they look the same
    // on retina (s=2) and standard (s=1) displays.
    this.s = dims.s || 1;

    // Screen geometry is fixed for the lifetime of this observer (recomputed
    // in sketch.js if the canvas is ever resized, which triggers a new observer).
    this.screenGeom = screenGeom;

    // Fourier series overlay: when true, draw each mode's individual contribution
    // as a colored curve behind the main string. Set from VP_OVERLAYS.fourier
    // each frame by sketch.js. Default false (off until checkbox is ticked).
    this.showFourierSeries = false;

    // Number of modes to draw in the Fourier overlay. Controlled by the
    // modes slider in the Physics panel. Capped at stringDef.N at draw time.
    this.nFourierModes = 16;

    // --- Color palette (white string on light-gray canvas) ---
    // String is always white regardless of vibration energy.
    // restColor and activeColor are both white so the lerp has no effect;
    // keeping the lerp structure intact so future color changes are a one-liner.
    this.restColor   = [255, 255, 255];   // white: string at rest
    this.activeColor = [255, 255, 255];   // white: string moving fast

    // Equilibrium line color: medium gray, slightly darker than background(220)
    this.equilColor = [190, 190, 190];

    // Boundary condition cache -- updated at the top of draw() each frame.
    // Used by drawCursor() to decide whether to show the tension-drag arrow
    // (fixed endpoint only) or a plain cursor (free endpoint).
    this._boundaryLeft  = 'fixed';
    this._boundaryRight = 'fixed';
  }

  // ------------------------------------------------------------------
  // draw -- main render call, called every frame by sketch.js.
  //
  // Reads physical state from modalState and draws the string.
  // Does NOT call background() -- that is sketch.js's responsibility.
  //
  // When drawState.mode === 'split', delegates to _drawSplitState() and returns
  // early; the whole-string path below is not executed.
  //
  // @param {ModalState}       modalState -- current physics state (read-only)
  // @param {StringDefinition} stringDef  -- current string definition
  // @param {Object}           drawState  -- optional; from interaction.getDrawState().
  //                                         { mode: 'whole' } or { mode: 'split', ... }
  //                                         Defaults to { mode: 'whole' } if omitted.
  // ------------------------------------------------------------------
  draw(modalState, stringDef, drawState) {
    // Default to whole-string rendering when no drawState is provided.
    drawState = drawState || { mode: 'whole' };

    // Cache boundary conditions so drawCursor() can check them without
    // needing a reference to stringDef (which is not available there).
    this._boundaryLeft  = stringDef.boundaryLeft;
    this._boundaryRight = stringDef.boundaryRight;

    // Delegate to split renderer when a fixed node is active.
    if (drawState.mode === 'split') {
      this._drawSplitState(drawState, stringDef);
      return;
    }

    const g  = this.screenGeom;    // { xLeft, xRight, Lx, yCenter, yScale }
    const Nx = stringDef.Nx;       // number of interior spatial points
    const s  = this.s;             // pixel scale factor

    // ------------------------------------------------------------------
    // Step 1: read physical state -- TRUNCATED to nFourierModes modes.
    //
    // Instead of summing all N modes (getDisplacements / getVelocities),
    // we sum only the first nFourierModes modes. This makes the rendered
    // string a partial Fourier series: fewer modes = less accurate wave
    // shape, more modes = higher fidelity. The slider always controls both
    // the curve overlay AND the string polyline, even when curves are hidden.
    // ------------------------------------------------------------------
    const disp = this._computeDisplacements(modalState, stringDef, this.nFourierModes);
    const vel  = this._computeVelocities(modalState, stringDef, this.nFourierModes);

    // ------------------------------------------------------------------
    // Step 2: pixel spacing between consecutive interior points.
    //
    // hPx = Lx / (Nx+1)
    // Interior point i sits at screen x = xLeft + (i+1) * hPx.
    // The (i+1) offset leaves one hPx gap on each side for the boundary.
    // ------------------------------------------------------------------
    const hPx = g.Lx / (Nx + 1);

    // ------------------------------------------------------------------
    // Step 3: endpoint screen y-coordinates.
    //
    // Fixed end (displacement = 0): endpoint stays at yCenter.
    // Free end (zero slope, nonzero displacement): extrapolate from the
    // nearest interior point as a first-order estimate.
    //   For a free BC (du/dx = 0), u at x=0 approx u at x=h (first interior).
    //   So the free endpoint y equals the nearest interior point y.
    // ------------------------------------------------------------------
    const yEndLeft  = (stringDef.boundaryLeft  === 'fixed')
                    ? g.yCenter
                    : g.yCenter - disp[0]      * g.yScale;

    const yEndRight = (stringDef.boundaryRight === 'fixed')
                    ? g.yCenter
                    : g.yCenter - disp[Nx - 1] * g.yScale;

    // ------------------------------------------------------------------
    // Step 4: RMS velocity --> string color.
    //
    // rmsV = sqrt( (1/Nx) * sum_i v[i]^2 )
    // t = clamp(rmsV / threshold, 0, 1)
    // color = lerp(restColor, activeColor, t)
    //
    // Threshold 0.3 m/s is tuned for the default physics parameters
    // (c = 2 m/s, typical pluck amplitude ~0.05 m). Adjust if visual
    // feedback feels too sensitive or too sluggish.
    // ------------------------------------------------------------------
    let sumV2 = 0;
    for (let i = 0; i < Nx; i++) sumV2 += vel[i] * vel[i];
    const rmsV = Math.sqrt(sumV2 / Nx);

    const t = Math.min(rmsV / 0.3, 1);   // 0 = at rest, 1 = fast

    // Lerp between rest and active color
    const sc = [
      Math.round(this.restColor[0] + t * (this.activeColor[0] - this.restColor[0])),
      Math.round(this.restColor[1] + t * (this.activeColor[1] - this.restColor[1])),
      Math.round(this.restColor[2] + t * (this.activeColor[2] - this.restColor[2]))
    ];

    // ------------------------------------------------------------------
    // Step 5: Fourier series overlay.
    //
    // Drawn FIRST so all mode curves appear behind the main string line.
    // ------------------------------------------------------------------
    if (this.showFourierSeries) {
      this._drawFourierOverlay(modalState, stringDef, g, Nx, hPx);
    }

    // ------------------------------------------------------------------
    // Step 6: equilibrium line.
    //
    // Faint horizontal line at yCenter -- shows where the string rests.
    // Helps orient the eye especially when mode shapes are displayed.
    // ------------------------------------------------------------------
    stroke(this.equilColor[0], this.equilColor[1], this.equilColor[2]);
    strokeWeight(0.5 * s);
    noFill();
    line(g.xLeft, g.yCenter, g.xRight, g.yCenter);

    // ------------------------------------------------------------------
    // Step 7: string polyline.
    //
    // Path: left endpoint --> Nx interior points --> right endpoint.
    // Total: Nx + 2 vertices.
    //
    // beginShape() / vertex() / endShape() draws a connected polyline
    // (open path, no fill) in p5.js global mode.
    // ------------------------------------------------------------------
    stroke(sc[0], sc[1], sc[2]);
    strokeWeight(2.5 * s);
    noFill();
    beginShape();
    vertex(g.xLeft,  yEndLeft);          // left boundary (x = 0)
    for (let i = 0; i < Nx; i++) {
      const sx = g.xLeft + (i + 1) * hPx;        // screen x for interior point i
      const sy = g.yCenter - disp[i] * g.yScale;  // screen y: up = positive disp
      vertex(sx, sy);
    }
    vertex(g.xRight, yEndRight);         // right boundary (x = L)
    endShape();

    // ------------------------------------------------------------------
    // Step 8: tension drag readout.
    //
    // When the user is dragging an endpoint to adjust tension, draw a
    // text overlay showing the current tension (N) and fundamental (Hz).
    // drawState.dragInfo is null when no drag is active.
    // ------------------------------------------------------------------
    if (drawState.dragInfo) {
      this._drawTensionReadout(drawState.dragInfo);
    }

    // ------------------------------------------------------------------
    // Step 9: boundary condition indicators.
    //
    // Left and right endpoints get a circle:
    //   fixed --> filled circle (pinned end)
    //   free  --> open ring (unconstrained end)
    //
    // Both indicators are drawn at yCenter (the equilibrium position of
    // the boundary), independent of displacement. This makes the fixed/free
    // toggle visually readable even when the string is moving.
    // ------------------------------------------------------------------
    const endR = 6 * s;   // endpoint indicator radius (pixels)
    this._drawEndpoint(g.xLeft,  g.yCenter, stringDef.boundaryLeft,  endR, sc);
    this._drawEndpoint(g.xRight, g.yCenter, stringDef.boundaryRight, endR, sc);
  }

  // ------------------------------------------------------------------
  // _drawEndpoint -- draw one boundary condition indicator.
  //
  // Fixed: filled circle. Visually suggests a pinned joint.
  // Free:  open ring.  Visually suggests an unconstrained end.
  //
  // @param {number}   sx   -- screen x of this endpoint
  // @param {number}   sy   -- screen y (always yCenter)
  // @param {string}   bc   -- 'fixed' or 'free'
  // @param {number}   r    -- circle radius (pixels)
  // @param {number[]} col  -- [r,g,b] -- string's current color
  // ------------------------------------------------------------------
  _drawEndpoint(sx, sy, bc, r, col) {
    const s = this.s;

    if (bc === 'fixed') {
      // Filled circle: pinned end. No wall line -- the solid dot is sufficient.
      fill(col[0], col[1], col[2]);
      noStroke();
      circle(sx, sy, r * 2);   // circle(x, y, diameter)

    } else {
      // Open ring: free end.
      noFill();
      stroke(col[0], col[1], col[2]);
      strokeWeight(2 * s);
      circle(sx, sy, r * 2);
    }
  }

  // ------------------------------------------------------------------
  // _computeDisplacements -- partial-sum physical displacements over nModes modes.
  //
  // u[i] = sum_{n=0}^{nModes-1} Phi[i][n] * q[n]
  //
  // Capping nModes at def.N ensures we never read past the end of q[].
  // When nModes == def.N the result equals modalState.getDisplacements().
  //
  // @param {ModalState}       state  -- modal coordinates (q array)
  // @param {StringDefinition} def    -- mode shapes (Phi) and geometry (Nx, N)
  // @param {number}           nModes -- how many modes to include
  // @returns {number[]} length-Nx array of physical displacements (m)
  // ------------------------------------------------------------------
  _computeDisplacements(state, def, nModes) {
    const Nx   = def.Nx;
    const use  = Math.min(nModes, def.N);   // never exceed available modes
    const Phi  = def.Phi;
    const q    = state.q;
    const disp = new Array(Nx).fill(0);
    for (let n = 0; n < use; n++) {
      const qn = q[n];
      for (let i = 0; i < Nx; i++) {
        disp[i] += Phi[i][n] * qn;
      }
    }
    return disp;
  }

  // ------------------------------------------------------------------
  // _computeVelocities -- partial-sum physical velocities over nModes modes.
  //
  // v[i] = sum_{n=0}^{nModes-1} Phi[i][n] * qdot[n]
  //
  // Used for the RMS velocity color ramp so the string color reflects
  // the same truncated energy as the shape.
  //
  // @param {ModalState}       state  -- modal velocities (qdot array)
  // @param {StringDefinition} def    -- mode shapes (Phi) and geometry (Nx, N)
  // @param {number}           nModes -- how many modes to include
  // @returns {number[]} length-Nx array of physical velocities (m/s)
  // ------------------------------------------------------------------
  _computeVelocities(state, def, nModes) {
    const Nx  = def.Nx;
    const use = Math.min(nModes, def.N);
    const Phi = def.Phi;
    const qd  = state.qdot;
    const vel = new Array(Nx).fill(0);
    for (let n = 0; n < use; n++) {
      const qdn = qd[n];
      for (let i = 0; i < Nx; i++) {
        vel[i] += Phi[i][n] * qdn;
      }
    }
    return vel;
  }

  // ------------------------------------------------------------------
  // _drawFourierOverlay -- draw each mode's contribution as a colored curve.
  //
  // For mode n, the physical displacement contribution at interior point i is:
  //   u_n(x_i) = Phi[i][n] * q[n]
  //
  // where Phi[i][n] is the mass-normalized mode shape and q[n] is the
  // current modal coordinate. The sum over all n gives the total displacement
  // shown by the main string polyline.
  //
  // Color:   getModeColor(n, N) -- yellow (n=0, fundamental) to red (n=N-1).
  //          Color always spans the full N range so the palette is consistent
  //          regardless of how many modes are shown by nFourierModes.
  //
  // Opacity: proportional to |q[n]| relative to the current largest |q[n]|
  //          across shown modes. The dominant mode is fully opaque (alpha 220);
  //          others fade as their energy decays. Modes below 0.1% of the max
  //          are skipped (negligible visual contribution).
  //
  // Weight:  2.0 * s -- slightly thinner than the main string's 2.5 * s.
  //
  // Draw order: all mode curves are drawn before the main string, so the
  // white string polyline sits on top.
  //
  // @param {ModalState}       modalState -- q array (read-only)
  // @param {StringDefinition} stringDef  -- Phi[spatialIdx][modeIdx], N
  // @param {Object}           g          -- screenGeom
  // @param {number}           Nx         -- interior spatial point count
  // @param {number}           hPx        -- pixel spacing between interior points
  // ------------------------------------------------------------------
  _drawFourierOverlay(modalState, stringDef, g, Nx, hPx) {
    const N      = stringDef.N;
    const Phi    = stringDef.Phi;   // Phi[spatialIdx][modeIdx]
    const q      = modalState.q;    // modal coordinates, length N
    const s      = this.s;

    // Number of modes to display: respect nFourierModes slider but never
    // exceed the actual number of modes in the current stringDef.
    const nShow = Math.min(this.nFourierModes, N);

    // ---- Pass 1: find max |q[n]| across shown modes for opacity normalization.
    // Skip the rigid-body mode (omega = 0) -- it drifts rather than oscillates
    // and should not influence the color scaling of the oscillating modes.
    let maxQ = 0;
    for (let n = 0; n < nShow; n++) {
      if (stringDef.omega[n] < 1e-6) continue;   // skip rigid-body (omega = 0)
      const a = Math.abs(q[n]);
      if (a > maxQ) maxQ = a;
    }

    // If all modes are negligible (string at rest or just initialized),
    // skip the overlay entirely to avoid dividing by near-zero.
    if (maxQ < 1e-8) return;

    // ---- Pass 2: draw each mode's contribution polyline.
    noFill();
    for (let n = 0; n < nShow; n++) {

      // Skip the rigid-body mode (omega = 0) -- pure drift, not an oscillation.
      if (stringDef.omega[n] < 1e-6) continue;

      const qAbs = Math.abs(q[n]);

      // Skip modes with less than 0.1% of the dominant mode's amplitude.
      // Avoids drawing invisible or noise-level curves.
      if (qAbs < maxQ * 0.001) continue;

      // Opacity: linearly proportional to relative modal amplitude.
      // Max alpha 220 keeps the overlay slightly translucent so the white
      // string remains clearly visible on top.
      // Minimum alpha 64 (25% of 255) keeps even low-energy modes visible.
      const alpha = Math.max(64, Math.round((qAbs / maxQ) * 220));

      // Color spans yellow (fundamental) to red (highest mode).
      // Uses _modeColor() -- a local method that does not depend on
      // MassVisualObserver.js being loaded (which is not the case in string.html).
      // Always indexed against full N so the palette is stable when
      // nFourierModes < N (the visible set is just a prefix of the range).
      const col = this._modeColor(n, N);

      stroke(col[0], col[1], col[2], alpha);
      strokeWeight(2.0 * s);   // slightly thinner than main string (2.5 * s)

      beginShape();

      // Left boundary: anchor to yCenter only for a fixed end (displacement = 0).
      // A free end has non-zero mode-shape value at x=0; skip the boundary vertex
      // so the curve starts at the first interior point without snapping to zero.
      if (stringDef.boundaryLeft === 'fixed') {
        vertex(g.xLeft, g.yCenter);
      }

      for (let i = 0; i < Nx; i++) {
        const modeDisp = Phi[i][n] * q[n];   // mode n's displacement at point i (m)
        const sx = g.xLeft + (i + 1) * hPx;
        const sy = g.yCenter - modeDisp * g.yScale;
        vertex(sx, sy);
      }

      // Right boundary: same logic as left.
      if (stringDef.boundaryRight === 'fixed') {
        vertex(g.xRight, g.yCenter);
      }

      endShape();
    }
  }

  // ------------------------------------------------------------------
  // _drawSplitState -- render the two sub-strings when a fixed node is active.
  //
  // Called by draw() when drawState.mode === 'split'.
  // Draws:
  //   1. Full equilibrium line (gray, same as whole-string mode).
  //   2. Left sub-string polyline (from xLeft to nodeScreenX).
  //   3. Right sub-string polyline (from nodeScreenX to xRight).
  //   4. White filled circle at the node position (on top of endpoint indicators).
  //
  // @param {Object}           drawState -- from getDrawState():
  //                                         { mode:'split', nodeKsi, leftState, leftDef,
  //                                           rightState, rightDef }
  // @param {StringDefinition} mainDef   -- the full-string definition (for L and boundaries)
  // ------------------------------------------------------------------
  _drawSplitState(drawState, mainDef) {
    const g = this.screenGeom;
    const s = this.s;

    // Map the node's physical x position to a screen x coordinate.
    // nodeKsi is in [0, L]; linear map to [xLeft, xRight].
    const nodeScreenX = g.xLeft + (drawState.nodeKsi / mainDef.L) * g.Lx;

    // Draw the full equilibrium line first, behind everything else.
    // This is the same faint gray line drawn in the whole-string path.
    stroke(this.equilColor[0], this.equilColor[1], this.equilColor[2]);
    strokeWeight(0.5 * s);
    noFill();
    line(g.xLeft, g.yCenter, g.xRight, g.yCenter);

    // Draw left sub-string: spans from xLeft to nodeScreenX.
    this._drawSubString(drawState.leftState, drawState.leftDef,
                        g.xLeft, nodeScreenX);

    // Draw right sub-string: spans from nodeScreenX to xRight.
    this._drawSubString(drawState.rightState, drawState.rightDef,
                        nodeScreenX, g.xRight);

    // Node indicator: white filled circle drawn AFTER both sub-strings so it
    // appears on top of all endpoint indicators. The node is always fixed
    // (zero displacement), so it stays at yCenter.
    const endR = 6 * s;
    fill(255, 255, 255);
    noStroke();
    circle(nodeScreenX, g.yCenter, endR * 2);

    // Tension drag readout (null when no drag is active).
    if (drawState.dragInfo) {
      this._drawTensionReadout(drawState.dragInfo);
    }
  }

  // ------------------------------------------------------------------
  // _drawSubString -- render one sub-string as a polyline with endpoint indicators.
  //
  // The sub-string spans screen x from xLeft to xRight. Its interior points are
  // placed at the same grid spacing h as the full string, but in local coordinates
  // starting from xLeft.
  //
  // Color is computed from the sub-string's own RMS velocity (same formula as
  // the whole-string path: lerp from restColor to activeColor).
  //
  // @param {ModalState}       state  -- sub-string modal state (read-only)
  // @param {StringDefinition} def    -- sub-string definition (Nx, boundaryLeft/Right)
  // @param {number}           xLeft  -- screen x of the left end of this sub-string
  // @param {number}           xRight -- screen x of the right end of this sub-string
  // ------------------------------------------------------------------
  _drawSubString(state, def, xLeft, xRight) {
    const g   = this.screenGeom;
    const s   = this.s;
    const Nx  = def.Nx;
    const Lx  = xRight - xLeft;    // pixel span of this sub-string

    // Degenerate guard: a sub-string with no interior points has nothing to draw.
    if (Nx === 0) return;

    // Read current physical state -- truncated to nFourierModes modes so the
    // sub-string rendering matches the same mode-count setting as the main string.
    const disp = this._computeDisplacements(state, def, this.nFourierModes);
    const vel  = this._computeVelocities(state, def, this.nFourierModes);

    // Pixel spacing between consecutive sub-string points.
    // (Nx+1) gaps between the two fixed endpoints, same formula as whole-string.
    const hPx = Lx / (Nx + 1);

    // Compute RMS velocity for color interpolation.
    // rmsV = sqrt( (1/Nx) * sum_i vel[i]^2 )
    let sumV2 = 0;
    for (let i = 0; i < Nx; i++) sumV2 += vel[i] * vel[i];
    const rmsV = Math.sqrt(sumV2 / Nx);
    const t = Math.min(rmsV / 0.3, 1);   // 0 = at rest, 1 = fast (threshold 0.3 m/s)

    // Lerp between rest and active color (both white by default, so this is a no-op
    // visually unless the palette changes in the future).
    const sc = [
      Math.round(this.restColor[0] + t * (this.activeColor[0] - this.restColor[0])),
      Math.round(this.restColor[1] + t * (this.activeColor[1] - this.restColor[1])),
      Math.round(this.restColor[2] + t * (this.activeColor[2] - this.restColor[2]))
    ];

    // Draw the sub-string polyline.
    // Path: left endpoint (fixed or free) --> Nx interior points --> right endpoint.
    stroke(sc[0], sc[1], sc[2]);
    strokeWeight(2.5 * s);
    noFill();
    beginShape();
    vertex(xLeft, g.yCenter);              // left endpoint: always fixed (node or end)
    for (let i = 0; i < Nx; i++) {
      const sx = xLeft + (i + 1) * hPx;          // screen x for interior point i
      const sy = g.yCenter - disp[i] * g.yScale;  // screen y: up = positive disp
      vertex(sx, sy);
    }
    vertex(xRight, g.yCenter);             // right endpoint: always fixed (node or end)
    endShape();

    // Draw boundary condition indicators at both ends.
    const endR = 6 * s;
    this._drawEndpoint(xLeft,  g.yCenter, def.boundaryLeft,  endR, sc);
    this._drawEndpoint(xRight, g.yCenter, def.boundaryRight, endR, sc);
  }

  // ------------------------------------------------------------------
  // _drawTensionReadout -- draw tension and frequency values near the endpoint.
  //
  // Called during endpoint tension-drag (drawState.dragInfo is non-null).
  // Draws two text lines:
  //   "T: <tension> N"    -- current string tension in Newtons
  //   "f1: <hz> Hz"       -- fundamental frequency of the adjacent string
  //
  // Text floats to the right of the left endpoint, or left of the right
  // endpoint, so it stays inside the canvas. White fill on dark background.
  //
  // @param {Object} dragInfo -- { side: 'left'|'right', tension, hz }
  // ------------------------------------------------------------------
  _drawTensionReadout(dragInfo) {
    const g = this.screenGeom;
    const s = this.s;

    // Horizontal anchor: just inside the endpoint, away from the canvas edge.
    const isLeft = (dragInfo.side === 'left');
    const sx     = isLeft ? g.xLeft + 14 * s : g.xRight - 14 * s;

    fill(255);
    noStroke();
    textSize(12 * s);
    textAlign(isLeft ? LEFT : RIGHT, CENTER);

    // Two lines, stacked just above the string center line.
    text('T: ' + dragInfo.tension.toFixed(0) + ' N',   sx, g.yCenter - 18 * s);
    text('f1: ' + dragInfo.hz.toFixed(1) + ' Hz',      sx, g.yCenter - 4 * s);
  }

  // ------------------------------------------------------------------
  // drawCursor -- draw pointer feedback at the current mouse position.
  //
  // Called by sketch.js after draw() so the cursor appears on top.
  // Only visible when the pointer is within the string's active region.
  //
  // @param {string} toolName -- current tool identifier: 'pointer' or 'hold'
  // @param {number} mx       -- mouse x (canvas pixels)
  // @param {number} my       -- mouse y (canvas pixels)
  // ------------------------------------------------------------------
  drawCursor(toolName, mx, my) {
    const g = this.screenGeom;
    const s = this.s;

    // Cursor style matches VisualObserver (MDOF world) for visual consistency:
    //   pointer --> plain crosshair (two lines, white)
    //   hold    --> open circle (white)
    // Canvas background is dark (bgColor=30) so white strokes are legible.
    stroke(255);
    strokeWeight(1.5 * s);
    noFill();

    if (toolName === 'hold') {
      // Open circle: suggests a node point will be pinned here.
      circle(mx, my, 24 * s);

    } else if (toolName === 'strum') {
      // Short thick horizontal line centered at mouse position.
      // Suggests a pick moving across the strings.
      strokeWeight(3.5 * s);
      line(mx - 36 * s, my, mx + 36 * s, my);

    } else {
      // Check if pointer is hovering near a FIXED endpoint (left or right).
      // Hit radius mirrors _isNearEndpoint() in StringInteractionController: 20px.
      // Only fixed endpoints support tension drag; free endpoints show no arrow.
      const epY        = g.yCenter;
      const dLeft      = Math.sqrt((mx - g.xLeft)  * (mx - g.xLeft)  + (my - epY) * (my - epY));
      const dRight     = Math.sqrt((mx - g.xRight) * (mx - g.xRight) + (my - epY) * (my - epY));
      const nearFixed  = (dLeft  < 20 && this._boundaryLeft  === 'fixed') ||
                         (dRight < 20 && this._boundaryRight === 'fixed');
      const nearEndpoint = nearFixed;

      if (nearEndpoint) {
        // Vertical double-headed arrow: a vertical shaft with arrowheads at top and bottom.
        // This matches the visual language used in the lattice world for stiffness dragging.
        const half  = 14 * s;   // half the shaft length (px)
        const ahead = 5  * s;   // arrowhead projection (px)
        // Shaft
        line(mx, my - half, mx, my + half);
        // Top arrowhead
        line(mx, my - half, mx - ahead, my - half + ahead);
        line(mx, my - half, mx + ahead, my - half + ahead);
        // Bottom arrowhead
        line(mx, my + half, mx - ahead, my + half - ahead);
        line(mx, my + half, mx + ahead, my + half - ahead);

      } else {
        // Plain crosshair: same as MDOF pointer tool.
        const size = 24 * s;
        line(mx - size / 2, my, mx + size / 2, my);   // horizontal arm
        line(mx, my - size / 2, mx, my + size / 2);   // vertical arm
      }
    }
  }

  // ------------------------------------------------------------------
  // drawMulti -- draw all strings in the multi-string world.
  //
  // Each string has its own yCenter (vertical rest position) and color.
  // The existing draw() method is reused per string: we temporarily
  // override this.screenGeom, this.restColor, this.activeColor, and
  // this.equilColor, then restore them after all strings are drawn.
  //
  // Tension drag readout is suppressed in multi-string mode (disabled
  // by the interaction controller -- no per-string tension drag).
  //
  // @param {Array}  strings    -- [{def, state, yCenter, color, ...}]
  //                               index 0 = lowest pitch (bottom)
  // @param {Object} sharedGeom -- { xLeft, xRight, Lx, yScale, velocityGain }
  //                               all strings share the same horizontal span
  // ------------------------------------------------------------------
  drawMulti(strings, sharedGeom, drawStates) {
    // Save all per-instance state that will be overridden for each string.
    const savedGeom   = this.screenGeom;
    const savedRest   = this.restColor;
    const savedActive = this.activeColor;
    const savedEquil  = this.equilColor;

    for (let i = 0; i < strings.length; i++) {
      const s   = strings[i];
      const col = s.color;   // [r, g, b] from the purple-to-green palette

      // Build the per-string screenGeom: same horizontal span as sharedGeom,
      // but with this string's own vertical center (yCenter).
      this.screenGeom = {
        xLeft:        sharedGeom.xLeft,
        xRight:       sharedGeom.xRight,
        Lx:           sharedGeom.Lx,
        yCenter:      s.yCenter,           // this string's rest y (pixels)
        yScale:       sharedGeom.yScale,   // pixels per meter of displacement
        velocityGain: sharedGeom.velocityGain
      };

      // Use the per-string hue for both rest and active states.
      // restColor == activeColor so velocity does not change string color.
      this.restColor   = col;
      this.activeColor = col;

      // Equilibrium line: same hue at ~40% brightness so it reads as a
      // faint guide behind the vibrating string.
      this.equilColor = [
        Math.round(col[0] * 0.40),
        Math.round(col[1] * 0.40),
        Math.round(col[2] * 0.40)
      ];

      // Draw this string using the existing rendering path.
      // drawStates[i] carries hold-tool split info (or whole-string fallback).
      const drawState = (drawStates && drawStates[i]) ? drawStates[i] : { mode: 'whole' };
      this.draw(s.state, s.def, drawState);
    }

    // Restore saved state so future single-string draw() calls still work.
    this.screenGeom  = savedGeom;
    this.restColor   = savedRest;
    this.activeColor = savedActive;
    this.equilColor  = savedEquil;
  }

  // ------------------------------------------------------------------
  // _freqToNoteName -- convert physics fundamental (Hz) to a note name string.
  //
  // The audible pitch is physHz * AUDIO_SCALE (100). This is converted to
  // the nearest MIDI note number and then to a name like "D4" or "Bb1".
  //
  // MIDI: A4 = 69 = 440 Hz. Formula: midi = round(69 + 12*log2(hz/440)).
  // Octave: floor(midi/12) - 1  (C4 = midi 60, octave 4).
  //
  // Accidentals: flats for Eb, Ab, Bb (conventional for D-centered fifths
  // tuning); sharp for C#, F#.
  //
  // @param {number} physHz -- physics fundamental (Hz, before AUDIO_SCALE)
  // @returns {string}      -- e.g. "D4", "Bb1", "F#6"
  // ------------------------------------------------------------------
  _freqToNoteName(physHz) {
    const AUDIO_SCALE = 100;
    const audibleHz   = physHz * AUDIO_SCALE;
    if (audibleHz <= 0) return '';

    // Note names indexed by semitone within octave (C=0 through B=11).
    const NAMES = ['C','C#','D','Eb','E','F','F#','G','Ab','A','Bb','B'];

    // MIDI note number rounded to nearest semitone.
    const midi    = Math.round(69 + 12 * Math.log2(audibleHz / 440));
    const noteIdx = ((midi % 12) + 12) % 12;   // mod with negative guard
    const octave  = Math.floor(midi / 12) - 1;

    return NAMES[noteIdx] + octave;
  }

  // ------------------------------------------------------------------
  // screenToPhysical -- convert canvas x to physical string position.
  //
  // Used by interaction controllers to find where on the string
  // (in meters) the user clicked or dragged.
  //
  // @param {number} sx -- screen x (canvas pixels)
  // @param {number} L  -- string length (m), from stringDef.L
  // @returns {number}  -- physical x in [0, L] (clamped)
  // ------------------------------------------------------------------
  screenToPhysical(sx, L) {
    const g = this.screenGeom;
    const ksi = (sx - g.xLeft) / g.Lx * L;   // linear map from pixel to meter
    return Math.max(0, Math.min(L, ksi));
  }

  // ------------------------------------------------------------------
  // drawModalEnergyOverlay(modalState, stringDef, maxModes)
  //
  // Right-side horizontal bar chart of modal energies, identical layout
  // to MassVisualObserver.drawModalEnergyOverlay.
  // Capped at maxModes (default 16) so the chart stays compact.
  //
  // Layout per row (right to left):
  //   [freq label]  |  [===bar===]  |  [mode #]  |  [padR]
  //
  // Only call this for single-string mode (strings.length === 1).
  // The sketch guards this before calling.
  // ------------------------------------------------------------------
  drawModalEnergyOverlay(modalState, stringDef, maxModes) {
    const allEnergies = modalState.getModalEnergies();
    const nTotal      = allEnergies.length;
    if (nTotal === 0) return;

    // Cap to maxModes (typically 16) -- show only the first N modes.
    const N        = Math.min(nTotal, maxModes || 16);
    const energies = allEnergies.slice(0, N);

    const maxEnergy = Math.max(...energies);
    // hasEnergy: false when all modes are at rest -- bars are zero-width but
    // skeleton (mode numbers + frequencies) stays visible.
    const hasEnergy = (maxEnergy >= 1e-12);

    // ---- Dimensions (match MassVisualObserver layout) ----
    const s       = this.s;
    const textSz  = 11 * s;
    const hdrSz   =  9 * s;
    const barH    = 12 * s;
    const maxBarW = 45 * s;
    const gap     =  3 * s;
    const padR    =  8 * s;
    const labelW  = 20 * s;
    const barGap  =  4 * s;
    const freqGap =  5 * s;

    // ---- X positions (anchored to right edge) ----
    const modeRightX = this.canvasWidth - padR;
    const barRightX  = modeRightX - labelW - barGap;
    const freqEndX   = barRightX - maxBarW - freqGap;

    // ---- Vertical centering ----
    const totalChartH = N * barH + Math.max(0, N - 1) * gap;
    const startY      = (this.canvasHeight - totalChartH) / 2;

    noStroke();
    textFont('monospace');

    // ---- Column headers ----
    const hdrY = startY - 3 * s;
    fill(200, 200, 200, 120);
    textSize(hdrSz);
    textAlign(RIGHT, BOTTOM);
    text('Mode #',    modeRightX, hdrY);
    text('Frequency', freqEndX,   hdrY);

    // ---- Mode rows ----
    for (let n = 0; n < N; n++) {
      // getModeColor may be defined by MassVisualObserver (loaded on mass.html)
      // or by the fallback below.  Always available via _modeColor().
      const mc       = this._modeColor(n, N);
      const fraction = hasEnergy ? energies[n] / maxEnergy : 0;
      const barW     = fraction * maxBarW;
      const rowY     = startY + n * (barH + gap);
      const rowMidY  = rowY + barH / 2;

      // Bar rectangle: grows leftward from barRightX.
      fill(mc[0], mc[1], mc[2], 180);
      rect(barRightX - barW, rowY, barW, barH);

      // Mode number: right-aligned in mode# column.
      fill(mc[0], mc[1], mc[2], 200);
      textSize(textSz);
      textAlign(RIGHT, CENTER);
      text(n + 1, modeRightX, rowMidY);

      // Frequency: right-aligned in freq column.
      if (stringDef && stringDef.omega && stringDef.omega[n] !== undefined) {
        const freqHz = stringDef.omega[n] / (2 * Math.PI);
        fill(mc[0], mc[1], mc[2], 140);
        textAlign(RIGHT, CENTER);
        text(freqHz.toFixed(2) + ' Hz', freqEndX, rowMidY);
      }
    }

    textAlign(LEFT, BASELINE);
  }

  // _modeColor(n, N) -- yellow-to-red lerp per mode index.
  // Mirrors getModeColor() from MassVisualObserver but kept local so
  // StringVisualObserver works on pages that do not load MassVisualObserver.
  _modeColor(n, N) {
    const a = [255, 245, 100];   // mode 1: yellow
    const b = [255, 100, 100];   // highest mode: red
    const t = N > 1 ? n / (N - 1) : 0;
    return [
      Math.round(a[0] + t * (b[0] - a[0])),
      Math.round(a[1] + t * (b[1] - a[1])),
      Math.round(a[2] + t * (b[2] - a[2]))
    ];
  }
}
