/*
 * Water, Listening
 *
 * p5.js owns the fullscreen WebGL canvas. Native Web Audio analyzes microphone
 * input, JavaScript smooths and maps its features, and the fragment shader turns
 * those values into water motion and changing reflected light.
 */

const DEFAULTS = Object.freeze({
  sensitivity: 1.35,
  ambient: 0.58,
  distortion: 0.92,
  shimmer: 0.90,
  bloom: 0.70,
  dispersion: 0.98,
});

let params = { ...DEFAULTS };
let sourceImage = null;
let waterShader = null;
let assetsReady = false;
let previousFrameTime = performance.now();
let simulationTime = 0;
let motionEnvelope = 0;

let audioContext = null;
let analyser = null;
let microphoneStream = null;
let microphoneSource = null;
let frequencyData = null;
let waveformData = null;
let previousSpectrum = null;
let microphoneActive = false;
let trackElement = null;
let trackSource = null;
let trackObjectUrl = null;
let trackActive = false;
let lastOnsetTime = 0;
let fluxAverage = 0.01;
let previousRawBass = 0;
let lastSoundTime = 0;
let lastMeterUpdate = 0;
let soundStatus = "idle";
const LEAF_RESPONSE_DELAY_MS = 175;
const audioHistory = [];

const audioFeatures = {
  volume: 0,
  bass: 0,
  mid: 0,
  high: 0,
  onset: 0,
};

// The leaves do not share the water's instantaneous response. They receive an
// older, softened copy of the audio envelope, which reads as wind and inertia
// instead of a second audio visualizer layered over the water.
const leafResponse = {
  energy: 0,
  impulse: 0,
};

const pointerRipple = {
  active: false,
  position: { x: 0.5, y: 0.5 },
  previousPosition: null,
  previousTime: 0,
  energy: 0,
};

const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");

async function setup() {
  const canvas = createCanvas(windowWidth, windowHeight, WEBGL);
  canvas.parent("artwork");
  pixelDensity(Math.min(window.devicePixelRatio || 1, 2));
  noStroke();
  textureMode(NORMAL);

  bindInterface();
  bindPointerRipple(canvas.elt);

  try {
    [sourceImage, waterShader] = await Promise.all([
      loadImage("assets/water-reflection-full-frame.png"),
      loadShader("shader.vert?v=2.2.0", "shader.frag?v=2.2.0"),
    ]);
    assetsReady = true;
  } catch (error) {
    console.error("Unable to load artwork assets:", error);
    setStatus("Artwork failed to load", "error");
    noLoop();
  }
}

function draw() {
  if (!assetsReady) return;

  const now = performance.now();
  const dt = Math.min(Math.max((now - previousFrameTime) / 1000, 1 / 240), 0.05);
  previousFrameTime = now;

  updateAudioFeatures(dt, now);
  updateMotionEnvelope(dt, now);
  updateLeafResponse(dt, now);
  updatePointerRipple(dt);

  const accessibilityMotion = reducedMotionQuery.matches ? 0.35 : 1.0;
  const effectiveMotion = motionEnvelope * accessibilityMotion;
  simulationTime += dt * effectiveMotion;

  shader(waterShader);
  waterShader.setUniform("uTexture", sourceImage);
  waterShader.setUniform("uResolution", [width, height]);
  waterShader.setUniform("uTexResolution", [sourceImage.width, sourceImage.height]);
  waterShader.setUniform("uTime", simulationTime);

  waterShader.setUniform("uVolume", audioFeatures.volume);
  waterShader.setUniform("uBass", audioFeatures.bass);
  waterShader.setUniform("uMid", audioFeatures.mid);
  waterShader.setUniform("uHigh", audioFeatures.high);
  waterShader.setUniform("uOnset", audioFeatures.onset);
  waterShader.setUniform("uLeafEnergy", leafResponse.energy);
  waterShader.setUniform("uLeafImpulse", leafResponse.impulse);

  waterShader.setUniform("uAmbient", params.ambient);
  waterShader.setUniform("uDistortion", params.distortion);
  waterShader.setUniform("uShimmer", params.shimmer);
  waterShader.setUniform("uBloom", params.bloom);
  waterShader.setUniform("uDispersion", params.dispersion);
  waterShader.setUniform("uPointerPosition", [pointerRipple.position.x, pointerRipple.position.y]);
  waterShader.setUniform("uPointerEnergy", pointerRipple.energy);
  waterShader.setUniform("uMotionScale", effectiveMotion);

  // The vertex shader expands the unit rectangle to fill the viewport.
  rect(0, 0, width, height);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function bindInterface() {
  document.querySelectorAll("input[data-param]").forEach((input) => {
    const key = input.dataset.param;
    input.value = params[key];
    updateSliderReadout(input);
    input.addEventListener("input", () => {
      params[key] = Number(input.value);
      updateSliderReadout(input);
    });
    bindSliderTouch(input);
  });

  const panel = document.querySelector("#controls");
  const panelToggle = document.querySelector("#panel-toggle");
  const showButton = document.querySelector("#show-controls");

  // On phones the expanded panel covers most of the artwork, so it starts
  // collapsed and opens only when asked.
  if (window.matchMedia("(max-width: 560px)").matches) {
    panel.classList.add("is-collapsed");
    panelToggle.setAttribute("aria-expanded", "false");
  }

  panelToggle.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("is-collapsed");
    panelToggle.setAttribute("aria-expanded", String(!collapsed));
  });

  document.querySelector("#hide-button").addEventListener("click", () => {
    panel.hidden = true;
    showButton.hidden = false;
  });

  showButton.addEventListener("click", () => {
    panel.hidden = false;
    showButton.hidden = true;
  });

  document.querySelector("#microphone-button").addEventListener("click", toggleMicrophone);
  document.querySelector("#track-button").addEventListener("click", toggleTrack);
  document.querySelector("#track-input").addEventListener("change", handleTrackSelection);
  document.querySelector("#reset-button").addEventListener("click", resetArtwork);
  document.querySelector("#fullscreen-button").addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenLabel);
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

// On touch screens the native range input only responds to a precise grab of
// its small thumb. This makes the whole track a touch surface: the thumb jumps
// to the finger on touch and follows it while dragging.
function bindSliderTouch(input) {
  const setFromPointer = (event) => {
    const bounds = input.getBoundingClientRect();
    if (bounds.width <= 0) return;

    const min = Number(input.min);
    const max = Number(input.max);
    const step = Number(input.step) || 0.01;
    const ratio = clamp01((event.clientX - bounds.left) / bounds.width);
    const value = Math.round((min + ratio * (max - min)) / step) * step;

    if (input.value !== String(value)) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  input.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    input.setPointerCapture?.(event.pointerId);
    input.focus({ preventScroll: true });
    setFromPointer(event);
  });

  input.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") return;
    if (input.hasPointerCapture?.(event.pointerId)) setFromPointer(event);
  });
}

function updateSliderReadout(input) {
  const output = document.querySelector(`[data-value-for="${input.id}"]`);
  const value = Number(input.value);
  output.value = value.toFixed(2);
  const ratio = ((value - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100;
  input.style.setProperty("--fill", `${ratio}%`);
}

async function toggleMicrophone() {
  if (microphoneActive) {
    await stopMicrophone();
    return;
  }

  const button = document.querySelector("#microphone-button");
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Microphone unavailable in this browser", "error");
    return;
  }

  button.disabled = true;
  button.textContent = "Requesting…";
  setStatus("Waiting for microphone permission");

  try {
    await stopTrack(false);

    const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
    const audioConstraints = {};
    if (supported.echoCancellation) audioConstraints.echoCancellation = false;
    if (supported.noiseSuppression) audioConstraints.noiseSuppression = false;
    if (supported.autoGainControl) audioConstraints.autoGainControl = false;
    if (supported.channelCount) audioConstraints.channelCount = 1;

    microphoneStream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio API is unavailable");

    audioContext = new AudioContextClass({ latencyHint: "interactive" });
    await audioContext.resume();

    setUpAnalysis(audioContext);

    microphoneSource = audioContext.createMediaStreamSource(microphoneStream);
    microphoneSource.connect(analyser);

    microphoneActive = true;
    lastSoundTime = 0;
    soundStatus = "waiting";

    button.textContent = "Disable Microphone";
    setStatus("Listening · play music", "live");
  } catch (error) {
    console.error("Unable to start microphone analysis:", error);
    await stopMicrophone(false);

    const message = error?.name === "NotAllowedError"
      ? "Microphone permission was not granted"
      : "Microphone could not be started";
    setStatus(message, "error");
  } finally {
    button.disabled = false;
    if (!microphoneActive) button.textContent = "Enable Microphone";
  }
}

function setUpAnalysis(context) {
  analyser = context.createAnalyser();
  analyser.fftSize = 2048;
  analyser.minDecibels = -92;
  analyser.maxDecibels = -18;
  analyser.smoothingTimeConstant = 0;

  frequencyData = new Uint8Array(analyser.frequencyBinCount);
  waveformData = new Uint8Array(analyser.fftSize);
  previousSpectrum = new Uint8Array(analyser.frequencyBinCount);
}

// Playing a local audio file through the page is the reliable way to react to
// music on the same phone: sites cannot read other apps' audio, and enabling
// the microphone tends to pause their playback anyway.
function toggleTrack() {
  if (trackActive) {
    stopTrack();
    return;
  }
  document.querySelector("#track-input").click();
}

async function handleTrackSelection(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;

  try {
    if (microphoneActive) await stopMicrophone(false);
    await stopTrack(false);

    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error("Web Audio API is unavailable");

    audioContext = new AudioContextClass({ latencyHint: "interactive" });
    await audioContext.resume();
    setUpAnalysis(audioContext);

    trackObjectUrl = URL.createObjectURL(file);
    trackElement = new Audio(trackObjectUrl);
    trackSource = audioContext.createMediaElementSource(trackElement);
    trackSource.connect(analyser);
    analyser.connect(audioContext.destination);
    trackElement.addEventListener("ended", () => stopTrack());

    await trackElement.play();

    trackActive = true;
    lastSoundTime = 0;
    soundStatus = "waiting";
    document.querySelector("#track-button").textContent = "Stop Track";
    setStatus(`Playing · ${file.name}`, "live");
  } catch (error) {
    console.error("Unable to play the audio file:", error);
    await stopTrack(false);
    setStatus("Audio file could not be played", "error");
  }
}

async function stopTrack(updateStatus = true) {
  const wasActive = trackActive;

  trackElement?.pause();
  trackSource?.disconnect();
  if (trackObjectUrl) URL.revokeObjectURL(trackObjectUrl);
  trackElement = null;
  trackSource = null;
  trackObjectUrl = null;
  trackActive = false;

  if (wasActive) {
    analyser?.disconnect();
    const contextToClose = audioContext;
    audioContext = null;
    analyser = null;
    frequencyData = null;
    waveformData = null;
    previousSpectrum = null;
    soundStatus = "idle";

    if (contextToClose && contextToClose.state !== "closed") {
      try {
        await contextToClose.close();
      } catch (error) {
        console.warn("Audio context did not close cleanly:", error);
      }
    }
  }

  document.querySelector("#track-button").textContent = "Play Audio File";
  if (updateStatus && wasActive) setStatus("Still water");
}

async function stopMicrophone(updateStatus = true) {
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneSource?.disconnect();
  analyser?.disconnect();

  const contextToClose = audioContext;
  microphoneStream = null;
  microphoneSource = null;
  analyser = null;
  audioContext = null;
  frequencyData = null;
  waveformData = null;
  previousSpectrum = null;
  microphoneActive = false;
  soundStatus = "idle";

  if (contextToClose && contextToClose.state !== "closed") {
    try {
      await contextToClose.close();
    } catch (error) {
      console.warn("Audio context did not close cleanly:", error);
    }
  }

  document.querySelector("#microphone-button").textContent = "Enable Microphone";
  if (updateStatus) setStatus("Still water");
}

function updateAudioFeatures(dt, now) {
  let targets = { volume: 0, bass: 0, mid: 0, high: 0 };
  let onsetTarget = 0;

  if ((microphoneActive || trackActive) && analyser && frequencyData && waveformData) {
    analyser.getByteFrequencyData(frequencyData);
    analyser.getByteTimeDomainData(waveformData);

    let sumSquares = 0;
    for (let index = 0; index < waveformData.length; index += 1) {
      const sample = (waveformData[index] - 128) / 128;
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / waveformData.length);
    const gate = smoothStep(0.006, 0.028, rms);
    const sensitivity = params.sensitivity;
    const volume = clamp01((rms - 0.005) * 4.8 * sensitivity) * gate;

    const bassRaw = bandEnergy(35, 180);
    const midRaw = bandEnergy(180, 2200);
    const highRaw = bandEnergy(2200, 10000);

    targets = {
      volume,
      bass: clamp01(Math.pow(bassRaw * sensitivity * 1.75, 1.12) * gate),
      mid: clamp01(Math.pow(midRaw * sensitivity * 1.9, 1.16) * gate),
      high: clamp01(Math.pow(highRaw * sensitivity * 2.45, 1.2) * gate),
    };

    let positiveFlux = 0;
    let comparedBins = 0;
    const maxFrequency = Math.min(10000, audioContext.sampleRate * 0.5);
    const maxBin = Math.min(
      frequencyData.length - 1,
      Math.ceil((maxFrequency / (audioContext.sampleRate * 0.5)) * frequencyData.length)
    );

    for (let index = 2; index <= maxBin; index += 1) {
      const difference = frequencyData[index] - previousSpectrum[index];
      if (difference > 0) positiveFlux += difference / 255;
      previousSpectrum[index] = frequencyData[index];
      comparedBins += 1;
    }

    const flux = comparedBins ? positiveFlux / comparedBins : 0;
    fluxAverage = lerpNumber(fluxAverage, flux, 1 - Math.exp(-dt * 1.6));
    const bassRise = Math.max(targets.bass - previousRawBass, 0);
    const onsetThreshold = Math.max(0.008, fluxAverage * 1.65);

    if (
      now - lastOnsetTime > 115 &&
      targets.volume > 0.035 &&
      (flux > onsetThreshold || bassRise > 0.13)
    ) {
      onsetTarget = clamp01((flux - onsetThreshold) * 14 + bassRise * 2.4 + targets.bass * 0.18);
      lastOnsetTime = now;
    }

    previousRawBass = targets.bass;

    if (targets.volume > 0.028) lastSoundTime = now;
    updateListeningStatus(now);
  }

  audioFeatures.volume = smoothAsymmetric(audioFeatures.volume, targets.volume, 11, 2.6, dt);
  audioFeatures.bass = smoothAsymmetric(audioFeatures.bass, targets.bass, 9, 2.1, dt);
  audioFeatures.mid = smoothAsymmetric(audioFeatures.mid, targets.mid, 12, 3.5, dt);
  audioFeatures.high = smoothAsymmetric(audioFeatures.high, targets.high, 17, 5.2, dt);
  audioFeatures.onset = Math.max(onsetTarget, audioFeatures.onset * Math.exp(-dt * 4.6));

  if (now - lastMeterUpdate > 50) {
    updateSignalMeters();
    lastMeterUpdate = now;
  }
}

function updateMotionEnvelope(dt, now) {
  const recentlyAudible = (microphoneActive || trackActive) && now - lastSoundTime < 220;
  const audioEnergy = clamp01(
    audioFeatures.volume * 0.52 +
    audioFeatures.bass * 0.20 +
    audioFeatures.mid * 0.20 +
    audioFeatures.high * 0.08
  );
  const target = recentlyAudible ? clamp01(0.16 + audioEnergy * 1.42) : 0;

  // Fast response when music arrives; a short physical-looking coast when it
  // stops. Once the envelope is tiny it is snapped to zero so silence is truly
  // motionless rather than an almost-imperceptible perpetual drift.
  motionEnvelope = smoothAsymmetric(motionEnvelope, target, 13.0, 2.8, dt);
  if (motionEnvelope < 0.0015) motionEnvelope = 0;
}

function updateLeafResponse(dt, now) {
  const waterEnergy = clamp01(
    audioFeatures.volume * 0.34 +
    audioFeatures.bass * 0.34 +
    audioFeatures.mid * 0.22 +
    audioFeatures.high * 0.10
  );

  audioHistory.push({
    time: now,
    energy: waterEnergy,
    impulse: audioFeatures.onset,
  });

  while (audioHistory.length > 2 && audioHistory[1].time < now - 1200) {
    audioHistory.shift();
  }

  const delayedTime = now - LEAF_RESPONSE_DELAY_MS;
  let delayed = audioHistory[0] || { energy: 0, impulse: 0 };
  for (let index = audioHistory.length - 1; index >= 0; index -= 1) {
    if (audioHistory[index].time <= delayedTime) {
      delayed = audioHistory[index];
      break;
    }
  }

  // Long attack/release times create visible mass in the branches. A beat can
  // nudge them, but it cannot snap them into the same rhythm as the water.
  leafResponse.energy = smoothAsymmetric(
    leafResponse.energy,
    delayed.energy,
    3.1,
    1.25,
    dt
  );
  leafResponse.impulse = Math.max(
    delayed.impulse * 0.52,
    leafResponse.impulse * Math.exp(-dt * 2.55)
  );
}

function bandEnergy(lowFrequency, highFrequency) {
  if (!audioContext || !frequencyData) return 0;

  const nyquist = audioContext.sampleRate * 0.5;
  const start = Math.max(1, Math.floor((lowFrequency / nyquist) * frequencyData.length));
  const end = Math.min(
    frequencyData.length - 1,
    Math.ceil((Math.min(highFrequency, nyquist) / nyquist) * frequencyData.length)
  );

  let sumSquares = 0;
  let count = 0;
  for (let index = start; index <= end; index += 1) {
    const magnitude = frequencyData[index] / 255;
    sumSquares += magnitude * magnitude;
    count += 1;
  }
  return count ? Math.sqrt(sumSquares / count) : 0;
}

function updateListeningStatus(now) {
  const recentlyDetected = now - lastSoundTime < 850;
  const nextStatus = recentlyDetected ? "detected" : "waiting";
  if (nextStatus === soundStatus) return;

  soundStatus = nextStatus;
  setStatus(
    recentlyDetected ? "Listening · music detected" : "Listening · waiting for music",
    "live"
  );
}

function updateSignalMeters() {
  const values = {
    "bass-meter": audioFeatures.bass,
    "mid-meter": audioFeatures.mid,
    "high-meter": audioFeatures.high,
  };

  Object.entries(values).forEach(([id, value]) => {
    document.querySelector(`#${id}`).style.width = `${Math.round(clamp01(value) * 100)}%`;
  });
}

function bindPointerRipple(canvasElement) {
  const updatePointer = (event, initial = false) => {
    const bounds = canvasElement.getBoundingClientRect();
    const now = performance.now();
    const position = {
      x: clamp01((event.clientX - bounds.left) / bounds.width),
      y: clamp01((event.clientY - bounds.top) / bounds.height),
    };

    if (!initial && pointerRipple.previousPosition) {
      const dt = Math.max((now - pointerRipple.previousTime) / 1000, 1 / 120);
      const speed = Math.hypot(
        position.x - pointerRipple.previousPosition.x,
        position.y - pointerRipple.previousPosition.y
      ) / dt;
      pointerRipple.energy = Math.max(pointerRipple.energy, clamp01(0.28 + speed * 0.18));
    } else {
      pointerRipple.energy = Math.max(pointerRipple.energy, 0.72);
    }

    pointerRipple.position = position;
    pointerRipple.previousPosition = position;
    pointerRipple.previousTime = now;
  };

  canvasElement.addEventListener("pointerdown", (event) => {
    pointerRipple.active = true;
    canvasElement.setPointerCapture?.(event.pointerId);
    updatePointer(event, true);
  });

  canvasElement.addEventListener("pointermove", (event) => {
    if (pointerRipple.active) updatePointer(event);
  });

  const finishPointer = () => {
    pointerRipple.active = false;
    pointerRipple.previousPosition = null;
  };

  canvasElement.addEventListener("pointerup", finishPointer);
  canvasElement.addEventListener("pointercancel", finishPointer);
}

function updatePointerRipple(dt) {
  const decayRate = pointerRipple.active ? 1.1 : 2.25;
  pointerRipple.energy *= Math.exp(-dt * decayRate);
  if (pointerRipple.energy < 0.001) pointerRipple.energy = 0;
}

function resetArtwork() {
  params = { ...DEFAULTS };
  document.querySelectorAll("input[data-param]").forEach((input) => {
    input.value = params[input.dataset.param];
    updateSliderReadout(input);
  });

  Object.keys(audioFeatures).forEach((key) => {
    audioFeatures[key] = 0;
  });
  pointerRipple.energy = 0;
  leafResponse.energy = 0;
  leafResponse.impulse = 0;
  motionEnvelope = 0;
  simulationTime = 0;
  audioHistory.length = 0;
  fluxAverage = 0.01;
  previousRawBass = 0;
  if (previousSpectrum) previousSpectrum.fill(0);
  updateSignalMeters();
  const audioLive = microphoneActive || trackActive;
  setStatus(audioLive ? "Listening · play music" : "Still water", audioLive ? "live" : "");
}

async function toggleFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  } catch (error) {
    console.warn("Fullscreen is unavailable:", error);
  }
}

function updateFullscreenLabel() {
  document.querySelector("#fullscreen-button").textContent = document.fullscreenElement
    ? "Exit Fullscreen"
    : "Fullscreen";
}

async function handleVisibilityChange() {
  if (document.hidden) {
    noLoop();
    trackElement?.pause();
    if (audioContext?.state === "running") await audioContext.suspend();
    return;
  }

  previousFrameTime = performance.now();
  loop();
  if ((microphoneActive || trackActive) && audioContext?.state === "suspended") {
    try {
      await audioContext.resume();
      if (trackActive) await trackElement?.play();
    } catch (error) {
      console.warn("Audio context is waiting for another user gesture:", error);
    }
  }
}

function setStatus(message, mode = "") {
  document.querySelector("#status-text").textContent = message;
  const status = document.querySelector("#status");
  status.classList.toggle("is-live", mode === "live");
  status.classList.toggle("is-error", mode === "error");
}

function smoothAsymmetric(current, target, attackRate, releaseRate, dt) {
  const rate = target > current ? attackRate : releaseRate;
  return lerpNumber(current, target, 1 - Math.exp(-rate * dt));
}

function smoothStep(edge0, edge1, value) {
  const x = clamp01((value - edge0) / Math.max(edge1 - edge0, 0.00001));
  return x * x * (3 - 2 * x);
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function lerpNumber(a, b, amount) {
  return a + (b - a) * amount;
}

window.addEventListener("beforeunload", () => {
  microphoneStream?.getTracks().forEach((track) => track.stop());
  microphoneSource?.disconnect();
});
