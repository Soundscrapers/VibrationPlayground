/**
 * StringSoundObserver.js
 *
 * Responsibility:
 * - Karplus-Strong plucked-string synthesis for the string world.
 * - One monophonic voice per string (no polyphony in Step 6).
 * - triggerStrike(ksi, v0): maps position to timbre, velocity to
 *   amplitude, fires a noise burst into the KS delay loop.
 * - update(modalState, dt, stringDef): per-frame hook (reserved for
 *   Step 7 energy-driven gain modulation; no-op now).
 * - ensureAudioGraph(): deferred Tone.js node construction.
 *
 * NOT allowed to:
 * - Mutate ModalState or StringDefinition.
 * - Advance time.
 * - Draw anything.
 *
 * -------------------------------------------------------------------
 * Signal chain
 *
 *   NoiseSynth (white, attack 1ms, decay 20ms)
 *     --> FeedbackDelay (delayTime = 1/fundamentalHz, feedback = f(zeta))
 *     --> Filter (post-loop lowpass, cutoff = f(ksi, slope))
 *     --> Panner (stereo position from strike location ksi)
 *     --> Gain (master output level, scaled by 1/sqrt(voiceCount))
 *     --> Destination
 *
 * Panning:
 *   ksi = 0 (left endpoint)  --> pan = -1 (hard left)
 *   ksi = L/2 (center)       --> pan =  0 (center)
 *   ksi = L (right endpoint) --> pan = +1 (hard right)
 *   pan = 2 * (ksi / L) - 1; applied per-strike via a 10ms ramp.
 *
 * Karplus-Strong approximation: a short noise burst seeds the delay
 * loop. The feedback coefficient controls the base ring time (damping
 * slider). The post-loop filter shapes timbre at trigger time.
 *
 * Damping parameters and audio mapping:
 *
 *   Base damping (zeta, uniform):
 *     Controls FeedbackDelay.feedback = clamp(1 - zeta * 0.3, 0, 0.9999).
 *     zeta = 0.0 --> feedback = 0.9999 (very long ring)
 *     zeta = 0.1 --> feedback = 0.97   (default)
 *     zeta = 0.3 --> feedback = 0.91   (shorter ring)
 *
 *   Slope (frequency-dependent damping, per-mode increment):
 *     True in-loop filtering (classical KS with a BiquadFilter inside
 *     the feedback path) causes WebAudio instability: the NoiseSynth
 *     injects signal for ~20ms across several delay cycles, building up
 *     amplitude that pushes in-loop filters into a bad state.
 *     Instead, slope reduces the POST-loop filter's maximum cutoff
 *     ceiling. Higher slope --> lower ceiling --> darker timbre overall.
 *     This is a static timbral approximation (not time-varying harmonic
 *     decay), but it has the same directional response to the slider:
 *     higher slope --> less high-frequency content in the output.
 *     slope = 0.0 --> ceiling = 5000 Hz (bright near endpoints)
 *     slope = 0.3 --> ceiling ~  900 Hz (noticeably darker)
 *     slope = 0.5 --> ceiling ~  370 Hz (dark overall)
 *
 * Pitch relationship to physics:
 * The KS fundamental (fundamentalHz) is the AUDIBLE pitch, independent
 * of the physics omega values. Physics runs in slow motion so the wave
 * propagation is visible; audio runs at the real pitch. These two
 * timescales are intentionally decoupled.
 * AUDIO_SCALE = 100: physics f1 (2.2 Hz) * 100 = 220 Hz KS pitch.
 * -------------------------------------------------------------------
 */

class StringSoundObserver {

  /**
   * @param {Object} dims       -- canvas dims from sketch.js (reserved
   *                              for future layout-driven parameters)
   * @param {Object} stringDef  -- StringDefinition (read-only, L used for
   *                              position-to-cutoff mapping and panning)
   * @param {Object} [opts]     -- optional configuration:
   *   opts.gainMult {number}   -- per-voice gain multiplier (default 1.0).
   *                              Pass 1/sqrt(count) when N voices play simultaneously
   *                              to prevent clipping: e.g. 9 voices -> 0.33.
   */
  constructor(dims, stringDef, opts) {
    opts = opts || {};

    // String length in meters -- maps strike position ksi to panning and cutoff.
    this.L = stringDef.L;

    // Per-voice gain multiplier. For N simultaneous voices, pass 1/sqrt(N)
    // to keep total output level constant regardless of how many voices ring.
    // Default 1.0 (single-string world, no scaling needed).
    this._gainMult = (opts.gainMult !== undefined) ? opts.gainMult : 1.0;

    // Scaling factor from physics (visual) frequency to audible KS frequency.
    // Physics runs 100x slower than real time so the wave motion is visible.
    // Multiplying the physics fundamental by AUDIO_SCALE recovers the real pitch.
    // Example: physics f1 = 2.2 Hz * 100 = 220 Hz (A3) for the KS loop.
    this.AUDIO_SCALE = 100;

    // Fundamental pitch of the KS voice in Hz (after AUDIO_SCALE applied).
    // KS delay time = 1 / fundamentalHz.
    this.fundamentalHz = 220;   // A3 default (2.2 Hz physics * 100)

    // KS feedback coefficient derived from modal damping (base, uniform).
    // Mapping: feedback = clamp(1 - zeta * 0.3, 0, 0.9999)
    // Stored before graph build so ensureAudioGraph() applies it immediately.
    this._feedback = Math.max(0, Math.min(0.9999, 1 - stringDef.zeta[0] * 0.3));

    // Damping slope -- controls post-loop filter ceiling (see header note).
    // Updated by setDampingSlope(); applied at the next triggerStrike() call
    // and also immediately if the graph is already built.
    this._slope = 0;

    // Number of modes mirrored from the visual N slider.
    // The post-loop filter cutoff is capped at _nModes * fundamentalHz so
    // the audible harmonic content matches the visual truncation:
    //   low N  --> low cutoff --> muffled, few harmonics
    //   high N --> high cutoff --> bright, full spectrum
    // Default 30 (slider max) so filter is effectively open on first load.
    // Updated live by setNModes() as the slider moves.
    this._nModes = 30;

    // True once Tone.js nodes have been built in ensureAudioGraph().
    // triggerStrike() and update() are no-ops until this is set.
    this.graphBuilt = false;

    // Tone.js node references (null until ensureAudioGraph() runs)
    this.noise    = null;   // NoiseSynth -- short white-noise exciter
    this.delay    = null;   // FeedbackDelay -- KS resonator / pitch loop
    this.filter   = null;   // Filter -- post-loop lowpass EQ
    this.panNode  = null;   // Panner -- stereo position from strike location
    this.gainNode = null;   // Gain -- master output level (scaled by _gainMult)
  }

  // ------------------------------------------------------------------
  // ensureAudioGraph -- build Tone.js nodes after audio context starts.
  //
  // Called by StringInteractionController.ensureAudioStarted() on the
  // first user gesture. Browsers block audio until then.
  // Safe to call multiple times -- nodes are built only once.
  // ------------------------------------------------------------------
  ensureAudioGraph() {
    if (this.graphBuilt) return;

    // Audio context must be running before creating nodes.
    if (!window.Tone || Tone.context.state !== 'running') return;

    // ---- Exciter ----
    // Short white-noise burst: models brief hammer contact.
    // attack 1ms, decay 20ms, no sustain -- envelope fades before the
    // delay loop has time to build up a pitched resonance.
    this.noise = new Tone.NoiseSynth({
      noise:    { type: 'white' },
      envelope: { attack: 0.001, decay: 0.02, sustain: 0, release: 0.001 }
    });

    // ---- KS resonator ----
    // delayTime = 1 / fundamentalHz (seconds) -- determines perceived pitch.
    // feedback = this._feedback -- derived from modal damping via setDamping().
    //   zeta = 0.1 (default) --> feedback = 0.97
    // wet = 1.0 -- all output comes from the delay line (no dry pass-through).
    this.delay = new Tone.FeedbackDelay({
      delayTime: 1 / this.fundamentalHz,
      feedback:  this._feedback,
      wet:       1.0
    });

    // ---- Post-loop lowpass EQ ----
    // Rolls off high-frequency content. Cutoff is set per-strike by
    // triggerStrike() as a function of both strike position and slope.
    // Q = 0.8 -- gentle, non-resonant slope.
    this.filter = new Tone.Filter({
      frequency: 3000,
      type:      'lowpass',
      Q:         0.8
    });

    // ---- Stereo panner ----
    // Center (pan = 0) by default; updated per-strike from ksi.
    // ksi = 0 (left endpoint) --> pan -1; ksi = L (right) --> pan +1.
    this.panNode = new Tone.Panner(0);

    // ---- Master output gain ----
    // Base level 0.6, scaled by _gainMult (1/sqrt(N) for N simultaneous voices).
    // 9 voices: 0.6 * 0.333 = 0.2 per voice. Total headroom: sqrt(9) * 0.2 = 0.6.
    this.gainNode = new Tone.Gain(0.6 * this._gainMult).toDestination();

    // ---- Connect chain ----
    // noise --> delay --> filter --> panner --> gain --> destination
    this.noise.connect(this.delay);
    this.delay.connect(this.filter);
    this.filter.connect(this.panNode);
    this.panNode.connect(this.gainNode);

    this.graphBuilt = true;
  }

  // ------------------------------------------------------------------
  // setFundamental -- update the KS pitch without triggering a new strike.
  //
  // Called during endpoint tension-drag to keep the delay-line pitch in
  // sync with the physics as tension changes live.
  // Uses a 50ms ramp to avoid clicks from abrupt delay-time jumps.
  //
  // @param {number} hz -- physics fundamental frequency (Hz), must be > 0.
  //                       Multiplied by AUDIO_SCALE internally.
  // ------------------------------------------------------------------
  setFundamental(hz) {
    if (!hz || hz <= 0) return;
    // hz is the physics (visual) fundamental. Scale up to audio domain.
    const ksHz = hz * this.AUDIO_SCALE;
    this.fundamentalHz = ksHz;
    if (this.graphBuilt) {
      // Ramp delay time to 1/ksHz. A 50ms ramp smooths continuous drag
      // without audible zipper noise while remaining responsive.
      this.delay.delayTime.rampTo(1 / ksHz, 0.05);
    }
  }

  // ------------------------------------------------------------------
  // setDamping -- update KS feedback to match the base damping slider.
  //
  // Called by sketch.js vpSetDamping() when string world is active.
  // Mapping: feedback = clamp(1 - zeta * 0.3, 0, 0.9999)
  //
  // @param {number} zeta -- modal damping ratio, range [0, 1]
  // ------------------------------------------------------------------
  setDamping(zeta) {
    this._feedback = Math.max(0, Math.min(0.9999, 1 - zeta * 0.3));
    if (this.graphBuilt) {
      this.delay.feedback.rampTo(this._feedback, 0.05);
    }
  }

  // ------------------------------------------------------------------
  // setDampingSlope -- update timbral brightness ceiling for slope slider.
  //
  // Called by sketch.js vpSetDampingSlope() when string world is active.
  //
  // True in-loop KS filtering (a BiquadFilter inside the feedback path)
  // is not reliably achievable with Tone.js's NoiseSynth: the 20ms burst
  // injects signal across several delay cycles, causing amplitude buildup
  // that pushes in-loop filters into an unstable state (Chrome reports
  // "BiquadFilterNode: state is bad"). Instead, slope controls the
  // ceiling of the post-loop filter cutoff: higher slope --> lower ceiling
  // --> darker timbre at all strike positions. This mirrors the physics
  // direction (higher slope = higher modes damp faster = less brightness).
  //
  // Cutoff ceiling: max(400, 5000 * exp(-slope * 4))
  //   slope = 0.0 --> 5000 Hz ceiling (bright near endpoints)
  //   slope = 0.3 -->  670 Hz ceiling (noticeably darker)
  //   slope = 0.5 -->  340 Hz ceiling (dark overall)
  //
  // @param {number} slope -- per-mode damping increment, range [0, 0.5]
  // ------------------------------------------------------------------
  setDampingSlope(slope) {
    this._slope = Math.max(0, slope);
    if (this.graphBuilt) {
      // Apply immediately so the slider gives live feedback while a note rings.
      // Use p=0.5 (mid-string) as reference position for the preview cutoff.
      const maxCutoff = Math.max(400, 5000 * Math.exp(-this._slope * 4));
      const previewCutoff = 1200 + 0.5 * (maxCutoff - 1200);
      this.filter.frequency.rampTo(previewCutoff, 0.1);
    }
  }

  // ------------------------------------------------------------------
  // setNModes -- update the harmonic ceiling to mirror the visual mode count.
  //
  // Called by sketch.js each frame when nFourierModes changes.
  // The post-loop filter cutoff is set to min(N * f1, slope_ceiling):
  //   N * f1 passes the first N harmonics and attenuates the rest, so the
  //   audible spectrum is truncated in the same way as the visual partial sum.
  //   The slope ceiling is retained as a secondary upper bound so the damping-
  //   slope slider still darkens the sound independently.
  //
  // A no-op when N has not changed (avoids spamming AudioParam automation).
  //
  // @param {number} n -- number of modes (from slider), range [3, 30]
  // ------------------------------------------------------------------
  setNModes(n) {
    const clamped = Math.max(1, Math.round(n));
    if (clamped === this._nModes) return;   // unchanged -- skip ramp
    this._nModes = clamped;
    if (this.graphBuilt) {
      // N * f1 gives the cutoff frequency for the Nth harmonic.
      const nCutoff    = this._nModes * this.fundamentalHz;
      // Slope-based ceiling (same formula as in triggerStrike / setDampingSlope).
      const slopeCeil  = Math.max(400, 5000 * Math.exp(-this._slope * 4));
      // Floor at 200 Hz to keep a faint tone even at very low N.
      const target     = Math.max(200, Math.min(nCutoff, slopeCeil));
      this.filter.frequency.rampTo(target, 0.05);
    }
  }

  // ------------------------------------------------------------------
  // triggerStrike -- excite the KS loop when a hammer strike or pluck occurs.
  //
  // @param {number} ksi -- physical strike/pluck position (m), range [0, L]
  // @param {number} v0  -- impulse velocity (m/s); positive = upward.
  //                        Typical interactive values are 1 to 15 m/s.
  // @param {number} [hz] -- optional physics fundamental (Hz) to update
  //                         the KS pitch before triggering. Pass the active
  //                         StringDefinition's omega[0]/(2*pi) so sub-strings
  //                         play at their own pitch.
  // ------------------------------------------------------------------
  triggerStrike(ksi, v0, hz) {
    if (!this.graphBuilt) return;

    // ---- Optional pitch update ----
    // hz is the physics (visual) fundamental. Scale up to audio domain.
    if (hz !== undefined && hz > 0) {
      const ksHz = hz * this.AUDIO_SCALE;
      this.fundamentalHz = ksHz;
      this.delay.delayTime.rampTo(1 / ksHz, 0.01);
    }

    // ---- Strike position --> stereo pan ----
    //
    // Linear map: ksi = 0 (left end) --> pan = -1; ksi = L (right) --> pan = +1.
    // formula: pan = 2 * (ksi / L) - 1, clamped to [-1, 1].
    // 10ms ramp avoids clicks when panning changes between rapid strikes.
    if (this.panNode) {
      const pan = Math.max(-1, Math.min(1, 2 * (ksi / this.L) - 1));
      this.panNode.pan.rampTo(pan, 0.01);
    }

    // ---- Position + slope --> post-loop filter cutoff ----
    //
    // Strike near the CENTER: warm, fundamental-dominant sound (low cutoff).
    // Strike near the ENDS: bright, broad harmonic content (high cutoff).
    // Slope reduces the maximum cutoff ceiling so overall timbre darkens
    // with higher slope, parallel to the physics where higher modes damp faster.
    //
    // p = normalized distance from center: 0 = center, 1 = either endpoint.
    // maxCutoff = 5000 Hz at slope=0, lower at higher slope.
    // cutoff ramps between 1200 Hz (center) and maxCutoff (endpoint).
    // nCutoff caps the result at _nModes * f1 so the audible harmonic count
    // matches the visual mode-count slider: N modes visible = N harmonics heard.
    const p         = Math.abs(ksi - this.L / 2) / (this.L / 2);
    const maxCutoff = Math.max(400, 5000 * Math.exp(-this._slope * 4));
    const posCutoff = 1200 + p * (maxCutoff - 1200);
    const nCutoff   = this._nModes * this.fundamentalHz;
    const cutoff    = Math.max(200, Math.min(posCutoff, nCutoff));
    this.filter.frequency.rampTo(cutoff, 0.05);   // 50ms -- avoid BiquadFilter instability

    // ---- Velocity --> exciter amplitude ----
    //
    // |v0| in m/s divided by 15 (approx max) gives 0..1 Tone.js velocity.
    // Clamped: minimum 0.05 so a gentle click is still audible.
    const amp = Math.min(1.0, Math.max(0.05, Math.abs(v0) / 15));

    // Trigger: '64n' at default tempo is ~31ms, but the 20ms envelope decay
    // is shorter -- the envelope controls the actual burst length.
    this.noise.triggerAttackRelease('64n', Tone.now(), amp);
  }

  // ------------------------------------------------------------------
  // update -- per-frame observer hook from sketch.js draw().
  //
  // Placeholder for Step 7: will modulate gainNode.gain proportionally
  // to modalState.getTotalEnergy() so audio decay tracks physics damping.
  //
  // @param {ModalState}       modalState -- current physics state (read-only)
  // @param {number}           dt         -- physics time step (s)
  // @param {StringDefinition} stringDef  -- current string definition (read-only)
  // ------------------------------------------------------------------
  update(modalState, dt, stringDef) {
    // Step 7 will add: read modalState.getTotalEnergy(), ramp gainNode.gain.
  }

  // ------------------------------------------------------------------
  // dispose -- release Tone.js nodes when leaving string world.
  //
  // Called from resetToPreset() before the StringSoundObserver is
  // replaced by a new one, so orphaned audio nodes don't accumulate.
  // ------------------------------------------------------------------
  dispose() {
    if (!this.graphBuilt) return;

    // Disconnect in reverse chain order before disposing.
    this.noise.disconnect();
    this.delay.disconnect();
    this.filter.disconnect();
    this.panNode.disconnect();
    this.gainNode.disconnect();

    this.noise.dispose();
    this.delay.dispose();
    this.filter.dispose();
    this.panNode.dispose();
    this.gainNode.dispose();

    this.graphBuilt = false;
  }
}
