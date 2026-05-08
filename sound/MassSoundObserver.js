// ============================================================
// MassSoundObserver.js
// ============================================================
//
// Two-layer sonic architecture:
//
// 1. MASS SOUND (percussive, event-driven):
//    - Triggered on equilibrium zero-crossing
//    - Noise burst: impact crack with mass-dependent decay
//    - Pitched ring: resonant bell tone at tonnetz pitch
//    - Between crossings: silence
//    - Uncoupled masses sound like marimba/gamelan
//
// 2. COUPLING SOUND (continuous):
//    - Pink noise through bandpass filter at major third above lower mass
//    - Sounds breathy/organic rather than electronic drone
//    - Gain driven by differential velocity (sqrt mapping)
//    - Filter Q driven by differential velocity: low motion = narrow/whispery, high = wide/rushing
//    - Disorder shifts filter center frequency instead of oscillator detune
//    - Fades in when springs are activated
//
// DESIGN PRINCIPLES:
// - Physics owns truth, observer renders it
// - Zero-crossings ARE the strike events (not arbitrary)
// - Percussive sounds prevent ear fatigue
// - Continuous coupling layer breathes with system state
// - Held masses are muted; kinematic forcing is NOT muted
//
// ============================================================

class MassSoundObserver {
  // opts: optional geometry object from sketch.js dims.
  // Accepts opts.endCircleRadius so SoundObserver stays in sync with VisualObserver.
  // Defaults to 4 if opts is absent (DA sketch does not pass dims).
  constructor(opts) {
    // -------------------------------------------------------
    // Audio context management
    // -------------------------------------------------------
    this.ready = false;
    this.bus = null;

    // -------------------------------------------------------
    // Visual geometry (for zero-crossing threshold calculation)
    // Reads arc radius from window.massLayout each frame.
    // endCircleRadius must match VisualObserver.
    // -------------------------------------------------------
    this.endCircleRadius = (opts && opts.endCircleRadius != null)
      ? opts.endCircleRadius
      : 4;

    // -------------------------------------------------------
    // Per-mass panners (independent objects)
    // Both transient noise and pitched rings connect here
    // -------------------------------------------------------
    this.massPanners = [];  // Tone.Panner[], one per mass

    // -------------------------------------------------------
    // Per-mass transient noise pools
    // NoiseSynth triggered on zero-crossing for impact crack
    // -------------------------------------------------------
    this.transientPools = [];        // array of arrays: [[synth0, synth1, ...], [...], ...]
    this.transientFilters = [];      // array of BiquadFilters, one per mass
    this.transientVoiceIndex = [];   // round-robin counter per mass (shared with rings)
    this.prevDisplacements = [];     // for zero-crossing detection

    this.TRANSIENT_POLYPHONY = 4;   // voices per mass

    // Refractory period: minimum seconds between successive transient triggers
    // on the same mass.  Prevents rapid-fire noise pile-up at high oscillation
    // frequencies (stiff spring or heavy grounding).  At kGround=1000, m=1,
    // omega_n = sqrt(1000) ~= 31.6 rad/s ~= 5 Hz --> 10 zero-crossings/second
    // without gating.  0.12 s caps the trigger rate at ~8 Hz, which is faster
    // than any musically meaningful percussion rate while blocking the pile-up.
    this.lastTriggerTime   = [];    // Tone.now() of last trigger, one entry per mass
    this.minTriggerInterval = 0.12; // seconds

    // -------------------------------------------------------
    // Transient noise synthesis parameters (tunable via SOUND panel)
    // -------------------------------------------------------
    this.maxNoiseGain = 0.2;         // peak amplitude scalar for noise burst
    this.noiseDecay   = 0.2;         // NoiseSynth envelope decay in seconds

    // -------------------------------------------------------
    // Per-mass ring synthesis pools
    // FatOscillator triggered on zero-crossing for pitched resonance
    // Parallel structure to transient pools
    // -------------------------------------------------------
    this.ringPools = [];             // array of arrays: [[osc0, osc1, ...], [...], ...]
    this.ringGains = [];             // array of arrays: [[gain0, gain1, ...], [...], ...]
    this.ringPitches = [];           // Hz per mass (from tonnetz fifths chain)
    this.ringVoiceExpiry = [];       // array of arrays: mirrors ringPools; Tone.now() when voice goes silent
    // NOTE: Uses this.transientVoiceIndex[] for round-robin (shared counter)

    // Reduced from 8: first 4 were the only ones reachable via the shared round-robin
    // counter (which wraps at TRANSIENT_POLYPHONY = 4). Voices 4-7 were allocated
    // but never triggered.
    this.RING_POLYPHONY = 4;        // voices per mass
    this.RING_VOICE_BUDGET = 32;    // max simultaneous ring voices across all masses

    // -------------------------------------------------------
    // Ring synthesis parameters (tunable)
    // -------------------------------------------------------
    this.maxRingGain = 0.15;         // peak amplitude per ring strike (reduced from 0.4)
                                      // higher than old continuous gain (percussive)
    this.ringMinDecay = 0.2;         // seconds (reduced from 0.3 - faster voice recycling)
    this.ringMaxDecay = 0.6;         // seconds (reduced from 2.0 - faster voice recycling)
    this.ringMinVelocity = 0.08;     // velocity gate: crossings below this threshold skip
                                      // the ring entirely, preventing a residual hum when
                                      // the system appears visually still.  velocity units:
                                      // sqrt(impactEnergy) / mass (same scale as normalizedVel).
    this.ringSpread = 40;            // FatOscillator cents of spread between internal voices

    // -------------------------------------------------------
    // Fixed-mass muting
    // Set externally from sketch.js before update() is called.
    // Value is the HoldTool.fixedMasses Map (global index --> {displacement}) or null.
    // Kinematic forcing does NOT mute -- forced masses still sound.
    // -------------------------------------------------------
    this.currentFixedMasses = null;  // Map<globalIndex, {displacement}> or null

    // -------------------------------------------------------
    // Per-spring coupling voices (continuous synthesis)
    // Pink noise through bandpass filter at coupling pitch (major third above lower mass).
    // Replaces sine oscillator -- breathy/organic rather than fatiguing drone.
    // Chain: Tone.Noise('pink') -> BiquadFilter(bandpass) -> Gain -> Panner
    // -------------------------------------------------------
    this.couplingVoices = new Map(); // key: "i,j", value: {noise, filter, gain, panner, baseFreq, disposing}
    this.couplingDetuneDirections = new Map(); // key: "i,j", value: +1 or -1

    this.maxCouplingGain = 0.24;     // ceiling for differential-velocity gain
    this.rampTime = 0.1;             // gain/filter ramp time per frame
    this.couplingFadeTime = 0.15;    // longer fade for coupling on/off to prevent clicks

    // Bandpass Q range.
    // Low diffVel (masses barely moving relative to each other) --> low Q: broadband hush.
    // High diffVel (masses pulling hard on spring) --> high Q: narrow pitched whistle.
    // QMin is the floor at rest; QMax is the ceiling at full differential velocity.
    this.couplingQMin = 1;           // Q at zero differential velocity (broadband hush)
    this.couplingQMax = 40;          // Q at full differential velocity (pitched whistle)

    // -------------------------------------------------------
    // Frame counter for throttled coupling updates
    // Prevents audio stream crash from too many simultaneous parameter ramps
    // -------------------------------------------------------
    this.frameCount = 0;
    this.couplingUpdateInterval = 4;  // Update coupling params every N frames (not every frame)

    // -------------------------------------------------------
    // Synchronous disposal queue
    // Replaces setTimeout for all node disposal.
    // _scheduleDisposal() enqueues with a delay (milliseconds).
    // _drainDisposalQueue() is called each frame to run due callbacks.
    // Uses performance.now() timestamps -- always available, no audio context needed.
    // -------------------------------------------------------
    this.disposalQueue = [];         // [{disposeAt: ms, fn: Function}]

    // -------------------------------------------------------
    // Disorder-based detuning (coupling voices only)
    // -------------------------------------------------------
    this.maxDetuneCents = 15;        // max pitch detune from disorder (increased from 6 for more spread)
    this.detuneRampTime = 0.15;      // detune ramp time
    this.energyFloor = 1e-8;         // minimum energy for disorder calculation

    // -------------------------------------------------------
    // Pitch scheme: tonnetz fifths chain starting at A2
    // -------------------------------------------------------
    this.basePitch = 110;            // A2 in Hz
    this.fifthRatio = 3 / 2;         // just perfect fifth
    this.thirdRatio = 5 / 4;         // just major third
  }

  // ---------------------------------------------------------
  // Audio graph initialization
  // Creates master bus and connects to destination
  // Must be called after user gesture on iOS
  // ---------------------------------------------------------
  async ensureAudioGraph() {
    if (this.ready) return;
    if (Tone.context.state !== 'running') {
      await Tone.start();
    }
    if (!this.bus) {
      this.bus = new Tone.Gain(1.0).toDestination();
      this.ready = true;
    }
  }

  // ---------------------------------------------------------
  // Panner management: one panner per mass
  // Both transient noise and pitched ring connect to these.
  // Must run before syncTransientPools and syncRingPools.
  // ---------------------------------------------------------
  syncMassPanners(N) {
    if (!this.ready) return;

    // Add panners if needed
    while (this.massPanners.length < N) {
      const panner = new Tone.Panner(0);  // position set by loop below
      panner.connect(this.bus);
      this.massPanners.push(panner);
    }

    // Remove excess panners (system shrank).
    // Delay disposal so any in-flight ring/transient voices can finish connecting.
    while (this.massPanners.length > N) {
      const panner = this.massPanners.pop();
      this._scheduleDisposal(200, () => panner.dispose());
    }

    // Redistribute pan positions after any change
    for (let i = 0; i < N; i++) {
      const pan = this.getPanForMass(i, N);
      this.massPanners[i].pan.rampTo(pan, 0.05);
    }
  }

  // ---------------------------------------------------------
  // Transient noise pool management
  // NoiseSynth pools for impact crack on zero-crossing
  // Connects to massPanners (changed from v0.12)
  // ---------------------------------------------------------
  syncTransientPools(N) {
    if (!this.ready) return;

    // Add pools if needed
    while (this.transientPools.length < N) {
      const massIndex = this.transientPools.length;

      // Bandpass filter per mass (noise brightness from mass value)
      // Created BEFORE synths so they can connect through it
      // v0.12 architecture: all synths share one filter per mass
      const filter = new Tone.Filter({
        type: 'bandpass',
        frequency: 2000,  // updated per trigger in triggerTransient
        Q: 3
      });

      filter.connect(this.massPanners[massIndex]);

      const pool = [];
      for (let v = 0; v < this.TRANSIENT_POLYPHONY; v++) {
        const synth = new Tone.NoiseSynth({
          noise: { type: 'white' },
          envelope: {
            attack:  0.003,
            decay:   this.noiseDecay,   // tunable via SOUND panel
            sustain: 0,
            release: 0.05
          }
        });

        // Connect through filter, then to shared mass panner
        synth.connect(filter);
        pool.push(synth);
      }

      this.transientPools.push(pool);
      this.transientFilters.push(filter);
      this.transientVoiceIndex.push(0);
      this.prevDisplacements.push(0);
      this.lastTriggerTime.push(0);   // refractory: not yet triggered
    }

    // Remove excess pools (system shrank).
    // Queue disposal to allow any in-flight triggers to complete.
    while (this.transientPools.length > N) {
      const pool = this.transientPools.pop();
      const filter = this.transientFilters.pop();
      this.transientVoiceIndex.pop();
      this.prevDisplacements.pop();
      this.lastTriggerTime.pop();

      this._scheduleDisposal(150, () => {
        pool.forEach(synth => synth.dispose());
        filter.dispose();
      });
    }
  }

  // ---------------------------------------------------------
  // Ring pool management: pitched resonance triggered on zero-crossing
  //
  // Each mass gets a pool of FatOscillators at the mass's tonnetz pitch.
  // FatOscillator spreads multiple sines around the center frequency,
  // providing warmth through built-in micro-detuning.
  //
  // These are NOT continuous — they sit at gain 0 between triggers.
  // On trigger: gain jumps to amplitude, then decays to 0 over
  // a velocity-dependent decay time.
  //
  // Must run after syncMassPanners (connects to panners).
  // ---------------------------------------------------------
  syncRingPools(N) {
    if (!this.ready) return;

    // Add pools if needed
    while (this.ringPools.length < N) {
      const massIndex = this.ringPools.length;
      const pitch = this.getPitchForMass(massIndex);
      this.ringPitches.push(pitch);

      const pool = [];
      const gains = [];

      for (let v = 0; v < this.RING_POLYPHONY; v++) {
        const osc = new Tone.FatOscillator({
          frequency: pitch,
          type:   'sine',          // FatOsc spreads multiple sines around this
          spread: this.ringSpread, // cents of spread between internal voices (tunable)
          count:  2                // 2 internal oscillators (not live-updatable)
        });

        // Per-voice gain used as amplitude envelope
        // Sits at 0 between triggers
        const gain = new Tone.Gain(0);

        // Chain: osc → gain → massPanner → bus
        osc.connect(gain);
        gain.connect(this.massPanners[massIndex]);
        osc.start();

        pool.push(osc);
        gains.push(gain);
      }

      this.ringPools.push(pool);
      this.ringGains.push(gains);
      // One expiry timestamp per voice, initialized to 0 (not active).
      this.ringVoiceExpiry.push(new Array(this.RING_POLYPHONY).fill(0));
    }

    // Remove excess pools (system shrank).
    // Queue disposal after a short fade to avoid clicks.
    while (this.ringPools.length > N) {
      const pool = this.ringPools.pop();
      const gains = this.ringGains.pop();
      this.ringPitches.pop();
      this.ringVoiceExpiry.pop();   // keep in sync with pool array

      gains.forEach(g => g.gain.rampTo(0, 0.05));
      this._scheduleDisposal(100, () => {
        pool.forEach(osc => { osc.stop(); osc.dispose(); });
        gains.forEach(g => g.dispose());
      });
    }
  }

  // ---------------------------------------------------------
  // setNoiseDecay(seconds)
  //
  // Updates the NoiseSynth envelope decay on all existing synth pools and
  // stores the new value for pools created later.  Only affects future
  // triggers -- currently-playing bursts are unaffected.
  // ---------------------------------------------------------
  setNoiseDecay(seconds) {
    this.noiseDecay = seconds;
    for (const pool of this.transientPools) {
      for (const synth of pool) {
        synth.envelope.decay = seconds;
      }
    }
  }

  // ---------------------------------------------------------
  // setRingSpread(cents)
  //
  // Updates the FatOscillator spread on all existing ring oscillators and
  // stores the new value for pools created later.  If a ring voice happens
  // to be in its attack window the change is audible but subtle (cent-level
  // detuning shift).
  // ---------------------------------------------------------
  setRingSpread(cents) {
    this.ringSpread = cents;
    for (const pool of this.ringPools) {
      for (const osc of pool) {
        osc.spread = cents;
      }
    }
  }

  // ---------------------------------------------------------
  // Coupling voice management: continuous pink noise through bandpass filter
  // One voice per active spring, filter center at major third above lower mass
  // Gain driven by differential velocity (sqrt mapping).
  // Q driven by differential velocity: narrow at low motion, wide at high motion.
  // Disorder shifts filter center frequency (replaces oscillator detune).
  // ---------------------------------------------------------
  syncCouplingVoices(mdof) {
    if (!this.ready) return;

    const N = mdof.size();

    // Step 1: Identify active couplings (check all pairs, not just adjacent)
    const activeCouplings = new Set();
    for (let i = 0; i < N; i++) {
      for (let j = i + 1; j < N; j++) {
        if (mdof.hasCoupling(i, j)) {
          activeCouplings.add(`${i},${j}`);
        }
      }
    }

    // Step 2: Remove voices for couplings that no longer exist
    for (const key of this.couplingVoices.keys()) {
      if (!activeCouplings.has(key)) {
        const voice = this.couplingVoices.get(key);
        voice.gain.gain.rampTo(0, this.couplingFadeTime);
        voice.disposing = true;
        // Queue disposal -- long enough for the gain fade to finish.
        this._scheduleDisposal(250, () => {
          voice.noise.stop();
          voice.noise.dispose();
          voice.filter.dispose();
          voice.gain.dispose();
          voice.panner.dispose();
          this.couplingDetuneDirections.delete(key);
          this.couplingVoices.delete(key);
        });
      }
    }

    // Step 3: Add voices for new couplings
    for (const key of activeCouplings) {
      if (!this.couplingVoices.has(key)) {
        const [i, j] = key.split(',').map(Number);
        // baseFreq: bandpass center frequency = tonnetz major third above lower mass
        const baseFreq = this.getPitchForCoupling(i, j);

        // Pink noise through bandpass replaces sine oscillator.
        // Bandpass isolates a frequency band so pitch identity is still discernible
        // but the texture is breathy rather than a pure electronic tone.
        const noise = new Tone.Noise('pink');
        const filter = new Tone.BiquadFilter({
          type: 'bandpass',
          frequency: baseFreq,   // center at coupling pitch
          Q: this.couplingQMin   // start broadband (new voice starts at rest, no diffVel yet)
        });
        const gain = new Tone.Gain(0);
        const panner = new Tone.Panner(0);

        // Chain: noise -> bandpass filter -> gain -> panner -> bus
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(panner);
        panner.connect(this.bus);
        noise.start();

        this.couplingVoices.set(key, {
          noise,
          filter,
          gain,
          panner,
          baseFreq,    // stored for disorder frequency shift (replaces oscillator detune)
          disposing: false
        });

        // Random direction for disorder frequency shift (+1 shifts up, -1 shifts down)
        this.couplingDetuneDirections.set(key, Math.random() < 0.5 ? -1 : 1);
      }
    }

    // Step 4: Update coupling panning
    this.updateCouplingPanning(N);
  }

  // ---------------------------------------------------------
  // Update coupling voice panning based on system size
  // Called after any coupling voice add/remove
  // ---------------------------------------------------------
  updateCouplingPanning(N) {
    for (const [key, voice] of this.couplingVoices.entries()) {
      const [i, j] = key.split(',').map(Number);
      // Pan based on midpoint between masses
      const pan1 = this.getPanForMass(i, N);
      const pan2 = this.getPanForMass(j, N);
      const avgPan = (pan1 + pan2) / 2;
      voice.panner.pan.rampTo(avgPan, 0.05);
    }
  }

  // ---------------------------------------------------------
  // Trigger transient on equilibrium crossing
  //
  // Fires both:
  //   1. Noise burst — impact crack with mass-dependent decay
  //   2. Pitched ring — resonant bell tone at tonnetz pitch
  //
  // Muted for held masses (user is manually controlling position).
  // Kinematic forcing does NOT mute -- the forced mass still sounds.
  //
  // mass value modulates noise brightness (wooden --> metallic)
  // velocity (derived from energy/mass^2) modulates ring amplitude and decay
  // ---------------------------------------------------------
  triggerTransient(massIndex, energy, mass) {
    if (!this.ready) return;
    if (Tone.context.state !== 'running') return;

    // --- Guard: skip if this mass is fixed (user has pinned it as a boundary condition) ---
    const isFixed = this.currentFixedMasses && this.currentFixedMasses.has(massIndex);
    if (isFixed) return;

    // Get current time once for all scheduling
    const now = Tone.now();

    // === NOISE BURST (with mass-dependent decay) ===

    const noisePool = this.transientPools[massIndex];
    if (!noisePool) return;

    const voiceIdx = this.transientVoiceIndex[massIndex];
    const noiseSynth = noisePool[voiceIdx];

    // Advance round-robin (shared between noise and ring)
    this.transientVoiceIndex[massIndex] =
      (voiceIdx + 1) % this.TRANSIENT_POLYPHONY;

    // Filter frequency from mass index + mass value
    // Higher mass index = higher base frequency
    // Lower mass value = higher filter frequency (lighter = brighter)
    const baseFilterFreq = Math.min(3000, 800 + massIndex * 250);
    const filterFreq = baseFilterFreq / Math.sqrt(mass);
    this.transientFilters[massIndex].frequency.value = filterFreq;

    // Amplitude from impact energy
    const maxEnergy = 256;
    const normalizedEnergy = Math.min(1, energy / maxEnergy);
    const noiseAmplitude = Math.sqrt(normalizedEnergy) * this.maxNoiseGain;

    // Trigger with fixed duration like v0.12
    // TODO: restore mass-dependent decay once clicking is resolved
    noiseSynth.triggerAttackRelease('8n', undefined, noiseAmplitude);

    // === PITCHED RING ===

    const ringPool = this.ringPools[massIndex];
    const ringGainPool = this.ringGains[massIndex];
    if (!ringPool || !ringGainPool) return;

    // Count ring voices still in their decay window across all masses.
    // If budget is full, skip allocation -- system is acoustically saturated.
    // This prevents Web Audio node explosion with 16 masses at high activity.
    let activeRingCount = 0;
    for (let mi = 0; mi < this.ringVoiceExpiry.length; mi++) {
      for (let vi = 0; vi < this.ringVoiceExpiry[mi].length; vi++) {
        if (this.ringVoiceExpiry[mi][vi] > now) activeRingCount++;
      }
    }
    if (activeRingCount >= this.RING_VOICE_BUDGET) return;

    // Use same voice index as noise (shared round-robin)
    const ringOsc = ringPool[voiceIdx];
    const ringGain = ringGainPool[voiceIdx];

    // Recover velocity from impact energy: E = m²v² --> v = sqrt(E)/m
    const velocity = Math.sqrt(energy) / mass;

    // Velocity gate: skip the ring entirely for very slow crossings.
    // Without this gate, residual micro-oscillations that are visually
    // imperceptible still trigger quiet rings that stack into a continuous hum.
    // The noise burst above has already fired; only the sustained ring is gated.
    if (velocity < this.ringMinVelocity) return;

    // Ring amplitude from velocity
    // sqrt for perceptual loudness (Stevens' power law)
    const ringAmplitude = Math.sqrt(Math.min(1, velocity / 2.0)) * this.maxRingGain;

    // Decay time from velocity: fast crossing = long ring, slow = short tap
    // This means a gently oscillating mass produces short taps,
    // while an energetic mass produces long overlapping rings
    // that approach a sustained tone at high frequencies
    const normalizedVel = Math.min(1, velocity / 2.0);
    const decayTime = this.ringMinDecay + 
      normalizedVel * (this.ringMaxDecay - this.ringMinDecay);

    // Trigger with short attack to prevent click.
    // Can't jump from 0 to amplitude instantly - needs ramp.
    // Envelope: 5ms linear attack --> exponential decay to near-zero -->
    // hard cut to exactly 0.  The hard cut is critical: exponentialRampToValueAtTime
    // cannot reach true zero (mathematically undefined), so without it the
    // oscillator keeps running at 0.001 gain indefinitely, producing a faint
    // hum that accumulates across voices and persists after Eq reset.
    const attackEnd  = now + 0.005;
    const decayEnd   = attackEnd + decayTime;
    ringGain.gain.cancelScheduledValues(now);
    ringGain.gain.setValueAtTime(0, now);
    ringGain.gain.linearRampToValueAtTime(ringAmplitude, attackEnd);
    ringGain.gain.exponentialRampToValueAtTime(0.001, decayEnd);
    ringGain.gain.setValueAtTime(0, decayEnd);   // hard cut: silence the oscillator

    // Record when this voice will go silent for ring voice budget tracking.
    if (this.ringVoiceExpiry[massIndex]) {
      this.ringVoiceExpiry[massIndex][voiceIdx] = decayEnd;
    }
  }

  // ---------------------------------------------------------
  // Main update: called every frame from sketch.js
  //
  // Per-frame work:
  //   1. Sync all voice pools (panners, transients, rings, couplings)
  //   2. Update coupling voice gains, filters, and detuning (continuous)
  //   3. Detect zero-crossings and trigger transient + ring events
  //
  // Mass sound is entirely event-driven — no continuous gain loop.
  // ---------------------------------------------------------
  update(modalState, dt, mdof) {
    if (dt === 0) return;

    // ensureAudioGraph() is now called once from InteractionController.ensureAudioStarted()
    // on the first user gesture. Calling it every frame is incorrect because it is async
    // and repeatedly invokes Tone.start().
    if (!this.ready) return;

    // Drain any queued node disposals whose delay has elapsed.
    this._drainDisposalQueue();

    const N = modalState.N;

    // --- Sync all voice pools ---
    // Order matters: panners first (transients and rings connect to them)
    this.syncMassPanners(N);
    this.syncTransientPools(N);   // noise bursts — connects to panners
    this.syncRingPools(N);        // pitched rings — connects to panners
    this.syncCouplingVoices(mdof); // continuous coupling tones — own panners

    // --- Get physical state ---
    const displacements = modalState.getDisplacements();
    const velocities = modalState.getVelocities();

    // --- Update coupling voice gains (every frame, not throttled) ---
    for (const [key, voice] of this.couplingVoices.entries()) {
      if (voice.disposing) continue;

      const [i, j] = key.split(',').map(Number);

      // Mute if either endpoint mass is fixed (acts as a silent wall).
      const eitherFixed = this.currentFixedMasses &&
        (this.currentFixedMasses.has(i) || this.currentFixedMasses.has(j));
      if (eitherFixed) {
        voice.gain.gain.rampTo(0, this.rampTime);
        continue;
      }

      const diffVel = Math.abs(velocities[i] - velocities[j]);

      const normalizedDiff = Math.min(1, diffVel / 2.0);
      // Squared curve: drops gain sharply at low differential (quiet hush),
      // rises steeply toward maxCouplingGain at high differential (loud whistle).
      // Peak (normalizedDiff=1) is unchanged; low end is much quieter than sqrt was.
      const targetGain = normalizedDiff * normalizedDiff * this.maxCouplingGain;
      voice.gain.gain.rampTo(targetGain, this.rampTime);
    }

    // --- Update coupling filters and detuning (throttled to every 4 frames) ---
    this.frameCount++;
    const shouldUpdateCoupling = (this.frameCount % this.couplingUpdateInterval === 0);
    
    if (shouldUpdateCoupling) {
      // --- Disorder: shift each filter's center frequency by up to maxDetuneCents ---
      // Replaces oscillator detune. Pink noise has no pitch to detune, so we move
      // the bandpass center instead. Each voice has a random direction (+1/-1).
      // High disorder (energy spread across modes) = larger frequency shift.
      // Low disorder (one dominant mode) = filter stays near baseFreq.
      const disorder = this.computeDisorder(modalState);
      const detuneCents = disorder * this.maxDetuneCents;

      for (const [key, voice] of this.couplingVoices.entries()) {
        if (voice.disposing) continue;

        const [i, j] = key.split(',').map(Number);
        const diffVel = Math.abs(velocities[i] - velocities[j]);

        // Q tracks differential velocity.
        // Low diffVel (masses barely moving relative to each other) --> low Q: broadband hush.
        // High diffVel (masses pulling hard on spring) --> high Q: narrow pitched whistle.
        // normalizedDiff: 0 at rest, 1 at full diffVel (2.0 rad/s reference).
        const normalizedDiff = Math.min(1, diffVel / 2.0);
        const targetQ = this.couplingQMin + normalizedDiff * (this.couplingQMax - this.couplingQMin);
        voice.filter.Q.rampTo(targetQ, this.rampTime);

        // Filter center frequency = baseFreq shifted by disorder.
        // Converts cents offset to frequency ratio: f = baseFreq * 2^(cents/1200).
        const direction = this.couplingDetuneDirections.get(key) || 0;
        const targetFreq = voice.baseFreq * Math.pow(2, detuneCents * direction / 1200);
        voice.filter.frequency.rampTo(targetFreq, this.detuneRampTime);
      }
    }

    // --- Zero-crossing detection → trigger transient + ring ---
    for (let i = 0; i < N; i++) {
      const curr = displacements[i];
      const prev = this.prevDisplacements[i] ?? curr;

      // Compute visual threshold: angle where arc end-circle sits.
      // Reads radius from massLayout; falls back to a small fixed value.
      const _layout = window.massLayout ? window.massLayout.get(i) : null;
      const radius = _layout ? _layout.radius : 1000;
      const angleOffset = this.endCircleRadius / radius;
      const xThreshold = angleOffset / Math.PI;

      // Detect crossing the visual threshold
      const crossingThreshold =
        (prev > xThreshold && curr <= xThreshold) ||
        (prev < -xThreshold && curr >= -xThreshold);

      if (crossingThreshold) {
        const velocity = Math.abs(velocities[i]);
        const mass = mdof.masses[i];

        // Impact energy: m² × v²
        const impactEnergy = mass * mass * velocity * velocity;
        const minEnergy = 0.002;

        // Refractory period check: suppress trigger if previous one was too recent.
        // Prevents clicks and pops from rapid-fire triggering at high oscillation
        // frequencies.  Tone.now() is in seconds (audio clock), same units as
        // minTriggerInterval.
        const tNow = Tone.now();
        const timeSinceLast = tNow - (this.lastTriggerTime[i] || 0);

        if (impactEnergy > minEnergy && timeSinceLast >= this.minTriggerInterval) {
          this.lastTriggerTime[i] = tNow;
          this.triggerTransient(i, impactEnergy, mass);
        }
      }

      this.prevDisplacements[i] = curr;
    }
  }

  // ---------------------------------------------------------
  // _scheduleDisposal(delayMs, fn)
  //
  // Queues a disposal callback to run after delayMs milliseconds.
  // Uses performance.now() for timing -- always available, no audio context needed.
  // Replaces setTimeout throughout SoundObserver to avoid disposal backlog.
  // ---------------------------------------------------------
  _scheduleDisposal(delayMs, fn) {
    this.disposalQueue.push({ disposeAt: performance.now() + delayMs, fn });
  }

  // ---------------------------------------------------------
  // _drainDisposalQueue()
  //
  // Called each frame from update(). Runs any queued disposal functions
  // whose delay has elapsed. Items not yet due remain in the queue.
  // Avoids setTimeout backlog during rapid topology changes.
  // ---------------------------------------------------------
  _drainDisposalQueue() {
    if (this.disposalQueue.length === 0) return;
    const now = performance.now();
    const remaining = [];
    for (const item of this.disposalQueue) {
      if (now >= item.disposeAt) {
        item.fn();
      } else {
        remaining.push(item);
      }
    }
    this.disposalQueue = remaining;
  }

  // ---------------------------------------------------------
  // Compute disorder: variance of modal energies
  // High disorder = energy spread across many modes
  // Low disorder = energy concentrated in few modes
  // Used to detune coupling voices (not mass voices in v0.13)
  // ---------------------------------------------------------
  computeDisorder(modalState) {
    const energies = modalState.getModalEnergies();
    const totalEnergy = energies.reduce((sum, e) => sum + e, 0);
    
    if (totalEnergy < this.energyFloor) return 0;

    const mean = totalEnergy / energies.length;
    const variance = energies.reduce((sum, e) => sum + (e - mean) ** 2, 0) / energies.length;
    
    return Math.sqrt(variance) / totalEnergy;
  }

  // ---------------------------------------------------------
  // Pitch for mass physicsIndex: center-out fifths chain.
  //
  // Reads visual position from window.massLayout.
  // Right side masses descend by fifths from centerPitch.
  // Left  side masses ascend  by fifths from centerPitch.
  // Octave-folded into [80, 1200] Hz.
  //
  // stepsFromCenter:
  //   innerRight = +1, next right = +2, ...
  //   innerLeft  = -1, next left  = -2, ...
  // ---------------------------------------------------------
  getPitchForMass(physicsIndex) {
    const ml = window.massLayout;
    if (!ml) return this.basePitch;

    const layout = ml.get(physicsIndex);
    if (!layout) return this.basePitch;

    // Count left masses (they occupy the front of visualOrder)
    let nLeft = 0;
    for (const vi of ml.visualOrder) {
      if (ml.get(vi).side === 'right') break;
      nLeft++;
    }

    // Steps from center: positive = right, negative = left
    const stepsFromCenter = layout.side === 'right'
      ? layout.visualIndex - nLeft + 1
      : layout.visualIndex - nLeft;   // evaluates to -1, -2, ...

    let pitch;
    if (stepsFromCenter > 0) {
      // Right side: descending fifths  (centerPitch * (2/3)^n)
      pitch = this.basePitch * Math.pow(2 / 3, stepsFromCenter);
    } else if (stepsFromCenter < 0) {
      // Left side: ascending fifths  (centerPitch * (3/2)^n)
      pitch = this.basePitch * Math.pow(this.fifthRatio, -stepsFromCenter);
    } else {
      pitch = this.basePitch;
    }

    // Octave-fold into audible range
    while (pitch < 80)   pitch *= 2;
    while (pitch > 1200) pitch /= 2;

    return pitch;
  }

  // ---------------------------------------------------------
  // Pitch for coupling spring between masses i and j
  // Major third above the lower pitch
  // ---------------------------------------------------------
  getPitchForCoupling(i, j) {
    const pitch1 = this.getPitchForMass(i);
    const pitch2 = this.getPitchForMass(j);
    const lowerPitch = Math.min(pitch1, pitch2);
    return lowerPitch * this.thirdRatio;
  }

  // ---------------------------------------------------------
  // setBasePitch(hz)
  //
  // Changes the root pitch of the tonnetz fifths chain and immediately
  // ramps all existing ring oscillator frequencies to match.
  //
  // Without this method, changing this.basePitch has no effect on
  // already-running oscillators because syncRingPools() only creates
  // new pools -- it does not touch existing ones.
  //
  // Called by window.vpSetBasePitch() from the SOUND panel.
  // ---------------------------------------------------------
  setBasePitch(hz) {
    this.basePitch = hz;

    // Re-pitch every ring oscillator in every existing pool.
    // rampTo(0.1) avoids audible clicks on pitch changes.
    for (let i = 0; i < this.ringPools.length; i++) {
      const newPitch = this.getPitchForMass(i);
      this.ringPitches[i] = newPitch;
      for (let v = 0; v < this.ringPools[i].length; v++) {
        this.ringPools[i][v].frequency.rampTo(newPitch, 0.1);
      }
    }
  }

  // ---------------------------------------------------------
  // Pan position for mass physicsIndex: reads visual position
  // from window.massLayout so pan matches on-screen left/right order.
  //
  // visualIndex 0 (leftmost)  --> pan = -maxPan
  // visualIndex N-1 (rightmost) --> pan = +maxPan
  //
  // maxPan grows with N so that a larger system spreads wider.
  // ---------------------------------------------------------
  getPanForMass(physicsIndex, N) {
    if (N === 1) return 0;

    const ml = window.massLayout;
    if (!ml) {
      // Fallback: uniform spread by physics index (old behavior)
      const maxPan = Math.min(0.9, 0.3 + (N - 1) * 0.1);
      const normalizedPos = physicsIndex / (N - 1);
      return maxPan - 2 * maxPan * normalizedPos;
    }

    const layout = ml.get(physicsIndex);
    if (!layout) return 0;

    const maxVisual = ml.visualOrder.length - 1;
    if (maxVisual === 0) return 0;

    const maxPan = Math.min(0.9, 0.3 + (N - 1) * 0.1);
    // visualIndex 0 = leftmost = -maxPan; maxVisual = rightmost = +maxPan
    return -maxPan + (2 * maxPan * layout.visualIndex / maxVisual);
  }
}