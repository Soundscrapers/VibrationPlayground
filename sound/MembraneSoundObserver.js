/**
 * MembraneSoundObserver.js
 *
 * Responsibility:
 * - Modal additive synthesis for the vibrating membrane
 * - One sine oscillator per retained mode, energy-driven amplitude
 * - Transient noise burst ("knock") on strike events
 * - All mono -- no panning (camera orbits freely, spatial audio would mislead)
 *
 * NOT allowed to:
 * - Modify membraneDef or modalState
 * - Advance physics time
 * - Do hit-testing or rendering
 *
 * -------------------------------------------------------------------
 * Signal chain per mode n:
 *
 *   Oscillator_n  (sine, f = omega_n / (2*pi) * AUDIO_SCALE)
 *     --> Gain_n  (0..MAX_GAIN, driven by sqrt(energy_n) each frame)
 *     --> Bus     (master Tone.Gain)
 *     --> Tone.Destination
 *
 * Strike transient channel:
 *
 *   NoiseSynth   (white, attack 2ms, decay 30ms, sustain 0)
 *     --> Filter  (lowpass, cutoff ~2000 Hz for "knock" quality)
 *     --> Bus
 *     --> Tone.Destination
 *
 * AUDIO_SCALE = 80. Default square membrane:
 *   f_{1,1} = omega_{1,1} / (2*pi) = 3.11 Hz --> 3.11 * 80 = 249 Hz (B3)
 *
 * This inharmonic spectrum (ratios 1.000, 1.581, 2.000, 2.236, 2.550...) is
 * physically correct for a rectangular membrane and gives a metallic/bell-like
 * timbre distinct from the string world's harmonic series.
 *
 * -------------------------------------------------------------------
 * Frequency tracking:
 *
 * When the aspect ratio slider or a boundary toggle changes membraneDef.omega,
 * update() detects the new array reference (omega !== this._lastOmega) and
 * updates all oscillator frequencies in place. This keeps the audible pitches
 * in sync with the physics without rebuilding the whole audio graph.
 *
 * -------------------------------------------------------------------
 * Gain formula per mode n each frame:
 *
 *   amplitude_n = sqrt(energy_n)                  (modal amplitude proxy)
 *   raw_n       = clamp(amplitude_n / REF_AMP,  0, 1)
 *   target_n    = MAX_GAIN * raw_n^GAIN_EXPONENT   (power-law shaping)
 *
 * Power-law shaping (GAIN_EXPONENT=2) concentrates audible presence in the
 * loudest modes; modes at half the reference amplitude contribute only 1/4 of
 * MAX_GAIN, making the spectrum perceptually clean rather than densely buzzy.
 *
 * REF_AMP is calibrated so a center strike initially drives the loudest
 * modes to near MAX_GAIN. A default center strike with v0=5 m/s produces
 * modal amplitudes of roughly 0.1-0.8 (varies by mode); REF_AMP = 0.4 maps
 * the strongest modes near 1.0 (full gain) immediately after a strike.
 *
 * -------------------------------------------------------------------
 * ensureAudioGraph() must be called from a user gesture (mousePressed or
 * keyPressed) to satisfy the browser autoplay policy. It is safe to call
 * multiple times -- exits immediately if this.ready is already true.
 */

class MembraneSoundObserver {

  /**
   * @param {MembraneDefinition} membraneDef -- read-only; provides N, omega
   */
  constructor(membraneDef) {
    this.membraneDef = membraneDef;

    // Number of retained modes -- determines how many oscillators to build.
    this.N = membraneDef.N;

    // AUDIO_SCALE: multiply physics frequency (Hz) by this to get audible frequency.
    // Physics runs slow so wave propagation is visible; AUDIO_SCALE recovers real pitch.
    this.AUDIO_SCALE = 80;

    // --- Readiness flag (set true by ensureAudioGraph) ---
    this.ready   = false;
    this.isMuted = false;

    // --- Tone.js nodes (null until ensureAudioGraph runs) ---
    // oscs[n]   : Tone.Oscillator -- sine wave at mode n's audible frequency
    // gains[n]  : Tone.Gain       -- amplitude controlled by modal energy each frame
    // bus       : Tone.Gain       -- master volume, connects to Destination
    // noiseSynth: Tone.NoiseSynth -- transient knock on strike
    // noiseFilter: Tone.Filter    -- lowpass shaping for noise timbre
    this.oscs        = new Array(this.N).fill(null);
    this.gains       = new Array(this.N).fill(null);
    this.bus         = null;
    this.noiseSynth  = null;
    this.noiseFilter = null;

    // --- Gain parameters ---
    // MAX_GAIN: peak amplitude per oscillator voice.
    // At 30 modes, correlated worst-case sum = 30 * MAX_GAIN = 3.6.
    // In practice power-law shaping keeps only 5-10 modes loud simultaneously,
    // so effective peak is < 1.2 -- well clear of the 2.0 WebAudio limit.
    this.MAX_GAIN = 0.12;

    // REF_AMP: sqrt(energy) value that maps to MAX_GAIN (pre-power-law).
    // Calibrated to a default center strike (v0=5 m/s, w=Lx/10).
    // Raising REF_AMP makes the membrane sound quieter overall.
    this.REF_AMP = 0.4;

    // GAIN_EXPONENT: power-law shaping exponent.
    // amp_norm = sqrt(energy) / REF_AMP  (clipped to [0,1])
    // target   = MAX_GAIN * amp_norm^GAIN_EXPONENT
    // At exponent=2: norm=0.5 -> target = MAX_GAIN/4; norm=0.2 -> target = MAX_GAIN/25.
    this.GAIN_EXPONENT = 2;

    // SILENCE_THRESH: energy below this is treated as exactly zero.
    // Prevents the audio scheduler from accumulating tiny gain ramps when the
    // membrane is nominally at rest (numerical residuals from modal integration).
    this.SILENCE_THRESH = 1e-7;

    // RAMP_TIME: duration of each gain ramp (seconds).
    // 50ms smooths the 60fps envelope updates; short enough to track vibration.
    this.RAMP_TIME = 0.05;

    // TOTAL_BUDGET: maximum allowed sum of all oscillator gains at any frame.
    // Prevents clipping when many modes are simultaneously excited (e.g. center strike).
    // Without this cap, 10-15 modes ramping to MAX_GAIN simultaneously can push the
    // instantaneous sum above Tone.Destination's compressor threshold and cause
    // pumping distortion.  TOTAL_BUDGET * bus (0.85) = max signal level at Destination.
    // Keep this well below 0.5 to stay clear of the compressor knee.
    this.TOTAL_BUDGET = 0.40;

    // NOISE_GAIN: amplitude of the transient knock burst per strike.
    this.NOISE_GAIN = 0.35;

    // --- Frequency change detection ---
    // Stores the last omega array reference seen by update().
    // When membraneDef.omega !== this._lastOmega (a new array was assigned
    // by recompute()), the oscillator frequencies are updated to match.
    this._lastOmega = null;
  }

  // -----------------------------------------------------------------------
  // ensureAudioGraph
  //
  // Build the Tone.js signal chain. Called on the first user gesture
  // (mousePressed or keyPressed) to satisfy the browser autoplay policy.
  // Safe to call multiple times -- exits immediately if already ready.
  //
  // Audio context lifecycle:
  //   1. Tone.start() resumes the AudioContext (needed on iOS/Safari).
  //   2. One oscillator + gain per mode. All start silent (gain = 0).
  //      Frequencies set from current membraneDef.omega.
  //   3. One NoiseSynth + Filter for the transient knock on strike.
  //   4. update() drives gains from the first draw() call onward.
  // -----------------------------------------------------------------------
  async ensureAudioGraph() {
    if (this.ready) return;

    // Resume AudioContext if suspended (required on first gesture in most browsers).
    if (Tone.context.state !== 'running') {
      await Tone.start();
    }

    // Master bus: a single gain node for overall volume control and mute.
    // Default gain 0.85 leaves headroom; setMuted() ramps to 0 for mute.
    this.bus = new Tone.Gain(0.85).toDestination();

    // --- Build one oscillator + gain per retained mode ---
    const omega = this.membraneDef.omega;
    for (let n = 0; n < this.N; n++) {
      // Audible frequency: physics frequency * AUDIO_SCALE.
      // omega[n] is in rad/s; divide by 2*pi to get Hz.
      const physHz   = omega[n] / (2 * Math.PI);
      const audioHz  = Math.max(physHz * this.AUDIO_SCALE, 20);   // floor at 20Hz (sub-bass)

      // Sine oscillator: pure tone at this mode's audible frequency.
      const osc = new Tone.Oscillator({ frequency: audioHz, type: 'sine' });

      // Gain node starts at 0 (silent). update() ramps this each frame.
      const gain = new Tone.Gain(0);

      // Wire: osc --> gain --> bus --> Destination (all mono, no panner)
      osc.connect(gain);
      gain.connect(this.bus);
      osc.start();

      this.oscs[n]  = osc;
      this.gains[n] = gain;
    }

    // --- Transient noise channel: one NoiseSynth for the "knock" on strike ---
    // NoiseSynth: white noise with a fast attack/decay envelope.
    this.noiseSynth = new Tone.NoiseSynth({
      noise: { type: 'white' },
      envelope: {
        attack:  0.002,   // 2ms attack = percussive onset
        decay:   0.030,   // 30ms decay = short knock
        sustain: 0,       // no sustain (envelope falls to zero after decay)
        release: 0.05     // short release to avoid click on note-off
      }
    });

    // Lowpass filter shapes the noise burst for a dull-knock "knock" quality.
    // Cutoff ~2000 Hz removes harsh high-frequency hiss; the resulting thud
    // is reminiscent of a drumstick striking a drumhead.
    this.noiseFilter = new Tone.Filter(2000, 'lowpass');

    // Wire: noiseSynth --> filter --> bus
    this.noiseSynth.connect(this.noiseFilter);
    this.noiseFilter.connect(this.bus);
    this.noiseSynth.volume.value = Tone.gainToDb(this.NOISE_GAIN);

    // Cache the initial omega reference for change detection.
    this._lastOmega = omega;

    this.ready = true;
  }

  // -----------------------------------------------------------------------
  // update
  //
  // Called every draw() frame with current modal energies and the definition.
  //
  // Two jobs:
  //   1. Detect frequency changes (omega array replaced by recompute()) and
  //      update oscillator frequencies to match new eigenpairs.
  //   2. Drive each oscillator's gain from the corresponding modal energy.
  //
  // @param {number[]}          modalEnergies -- per-mode energies (length N)
  // @param {MembraneDefinition} membraneDef  -- current definition (read-only)
  // -----------------------------------------------------------------------
  update(modalEnergies, membraneDef) {
    if (!this.ready) return;

    // --- Frequency update on topology change ---
    // membraneDef.omega is replaced (not mutated) by recompute(), so a
    // reference inequality means the eigenpairs have changed.
    if (membraneDef.omega !== this._lastOmega) {
      this._updateFrequencies(membraneDef.omega);
      this._lastOmega = membraneDef.omega;
    }

    // --- Drive oscillator gains from modal energies (two-pass budget normalization) ---
    //
    // Pass 1: compute the raw target gain for each mode.
    // Pass 2: scale all targets down if their sum would exceed TOTAL_BUDGET.
    // This mirrors the LatticeSoundObserver approach and prevents clipping regardless
    // of how many modes happen to be simultaneously loud after a strike.

    // Pass 1: compute targets.
    const targets = new Array(this.N);
    let totalTarget = 0;
    for (let n = 0; n < this.N; n++) {
      const e = modalEnergies[n];

      if (e < this.SILENCE_THRESH) {
        // Energy below floor: treat as exactly zero to avoid accumulating tiny ramps.
        targets[n] = 0;
        continue;
      }

      // amplitude_n = sqrt(energy_n): proportional to the modal coordinate amplitude.
      // energy = 0.5*omega^2*q^2 + 0.5*qdot^2, so sqrt(energy) ~ omega*|q|
      const amp_n = Math.sqrt(e);

      // Normalize by REF_AMP: maps a typical post-strike amplitude to [0,1].
      const norm = Math.min(amp_n / this.REF_AMP, 1.0);

      // Power-law shaping: quiet modes are suppressed disproportionately.
      // GAIN_EXPONENT=2: norm=0.5 -> 1/4 of MAX_GAIN; norm=0.2 -> 1/25 of MAX_GAIN.
      targets[n]    = this.MAX_GAIN * Math.pow(norm, this.GAIN_EXPONENT);
      totalTarget  += targets[n];
    }

    // Budget scale: if the sum of all targets exceeds TOTAL_BUDGET, reduce every
    // voice proportionally so their sum equals exactly TOTAL_BUDGET.
    // budgetScale = 1.0 when the total is safely below the ceiling (common case
    // during quiet ring-down); only activates on loud multi-mode excitation.
    const budgetScale = (totalTarget > this.TOTAL_BUDGET)
      ? this.TOTAL_BUDGET / totalTarget
      : 1.0;

    // Pass 2: apply budget-scaled targets via smooth ramps.
    for (let n = 0; n < this.N; n++) {
      this.gains[n].gain.rampTo(targets[n] * budgetScale, this.RAMP_TIME);
    }
  }

  // -----------------------------------------------------------------------
  // triggerStrike
  //
  // Fire a short transient noise burst. Called from membrane-sketch.js
  // when the user performs a strike (not for hold or boundary toggle).
  //
  // The noise burst gives immediate auditory feedback ("the membrane was hit")
  // while the modal oscillators build up over the first few frames.
  // -----------------------------------------------------------------------
  triggerStrike() {
    if (!this.ready) return;

    // DISABLED: transient noise burst temporarily silenced for evaluation.
    // To re-enable, uncomment the line below.
    // this.noiseSynth.triggerAttackRelease('0.03', Tone.now());
  }

  // -----------------------------------------------------------------------
  // setMuted -- silence or unmute the master bus.
  //
  // Ramps bus gain between 0 and 0.85 over 100ms to avoid clicks.
  //
  // @param {boolean} muted -- true to mute, false to unmute
  // -----------------------------------------------------------------------
  setMuted(muted) {
    this.isMuted = muted;
    if (!this.ready) return;

    const targetGain = muted ? 0 : 0.85;
    this.bus.gain.rampTo(targetGain, 0.1);
  }

  // -----------------------------------------------------------------------
  // _updateFrequencies -- update all oscillator frequencies to new omega values.
  //
  // Called when membraneDef.omega has been replaced by a recompute()
  // (aspect ratio change, boundary toggle, tension change).
  //
  // Ramps each oscillator's frequency over 30ms to avoid audible glitches
  // when the aspect ratio slider is dragged continuously.
  //
  // @param {number[]} omega -- new natural frequencies (rad/s), length N
  // -----------------------------------------------------------------------
  _updateFrequencies(omega) {
    if (!this.ready) return;

    const RAMP = 0.03;   // 30ms frequency ramp to reduce slider-drag glitching
    for (let n = 0; n < this.N; n++) {
      const physHz  = omega[n] / (2 * Math.PI);
      const audioHz = Math.max(physHz * this.AUDIO_SCALE, 20);   // floor at 20Hz

      // rampTo: linearly interpolate frequency over RAMP seconds.
      // (Tone.Oscillator.frequency is an AudioParam with rampTo support.)
      this.oscs[n].frequency.rampTo(audioHz, RAMP);
    }
  }

  // -----------------------------------------------------------------------
  // dispose -- stop all audio nodes and free resources.
  //
  // Call when the membrane page is unloaded or the observer is no longer needed.
  // -----------------------------------------------------------------------
  dispose() {
    if (!this.ready) return;

    for (let n = 0; n < this.N; n++) {
      if (this.oscs[n])  { this.oscs[n].stop();  this.oscs[n].dispose(); }
      if (this.gains[n]) { this.gains[n].dispose(); }
    }

    if (this.noiseSynth)  this.noiseSynth.dispose();
    if (this.noiseFilter) this.noiseFilter.dispose();
    if (this.bus)         this.bus.dispose();

    this.ready = false;
  }
}
