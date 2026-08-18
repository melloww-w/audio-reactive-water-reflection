#ifdef GL_ES
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
#endif

uniform sampler2D uTexture;
uniform vec2 uResolution;
uniform vec2 uTexResolution;
uniform float uTime;

uniform float uVolume;
uniform float uBass;
uniform float uMid;
uniform float uHigh;
uniform float uOnset;
uniform float uLeafEnergy;
uniform float uLeafImpulse;

uniform float uAmbient;
uniform float uDistortion;
uniform float uShimmer;
uniform float uBloom;
uniform float uDispersion;
uniform vec2 uPointerPosition;
uniform float uPointerEnergy;
uniform float uMotionScale;

varying vec2 vTexCoord;

float luminance(vec3 color) {
  return dot(color, vec3(0.2126, 0.7152, 0.0722));
}

float hash21(vec2 point) {
  point = fract(point * vec2(123.34, 456.21));
  point += dot(point, point + 45.32);
  return fract(point.x * point.y);
}

vec2 rotateDirection(vec2 direction, float angle) {
  float cosine = cos(angle);
  float sine = sin(angle);
  return mat2(cosine, -sine, sine, cosine) * direction;
}

vec2 coverUv(vec2 uv) {
  float canvasAspect = uResolution.x / max(uResolution.y, 1.0);
  float imageAspect = uTexResolution.x / max(uTexResolution.y, 1.0);

  if (canvasAspect > imageAspect) {
    uv.y = (uv.y - 0.5) * (imageAspect / canvasAspect) + 0.5;
  } else {
    uv.x = (uv.x - 0.5) * (canvasAspect / imageAspect) + 0.5;
  }
  return uv;
}

// Map the complete source frame into the viewport without cropping. Values
// outside 0..1 identify the letterboxed area around the portrait artwork.
vec2 containUv(vec2 uv) {
  float canvasAspect = uResolution.x / max(uResolution.y, 1.0);
  float imageAspect = uTexResolution.x / max(uTexResolution.y, 1.0);

  if (canvasAspect > imageAspect) {
    uv.x = (uv.x - 0.5) * (canvasAspect / imageAspect) + 0.5;
  } else {
    uv.y = (uv.y - 0.5) * (imageAspect / canvasAspect) + 0.5;
  }
  return uv;
}

float fullFrameMask(vec2 uv) {
  vec2 lowerEdge = smoothstep(vec2(-0.004), vec2(0.004), uv);
  vec2 upperEdge = 1.0 - smoothstep(vec2(0.996), vec2(1.004), uv);
  return lowerEdge.x * lowerEdge.y * upperEdge.x * upperEdge.y;
}

// Softly isolate dark olive foreground foliage from the water in the single
// source photograph. Feathering avoids a hard, collage-like cutout.
float leafSignal(vec2 uv) {
  vec3 color = texture2D(uTexture, clamp(uv, 0.001, 0.999)).rgb;
  float lightness = luminance(color);
  float darkness = 1.0 - smoothstep(0.12, 0.48, lightness);
  float olive = color.g - (color.r + color.b) * 0.5;
  float oliveAffinity = smoothstep(-0.055, 0.075, olive);
  float chroma = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
  float organicColor = smoothstep(0.015, 0.22, chroma);
  return darkness * (0.54 + oliveAffinity * 0.34 + organicColor * 0.12);
}

float foregroundLeafMask(vec2 uv, vec2 screenUv) {
  vec2 px = 1.8 / max(uTexResolution, vec2(1.0));
  float signal = leafSignal(uv) * 0.40;
  signal += leafSignal(uv + vec2(px.x, 0.0)) * 0.15;
  signal += leafSignal(uv - vec2(px.x, 0.0)) * 0.15;
  signal += leafSignal(uv + vec2(0.0, px.y)) * 0.15;
  signal += leafSignal(uv - vec2(0.0, px.y)) * 0.15;

  float upperCanopy = 1.0 - smoothstep(0.42, 1.02, screenUv.y);
  float leftCanopy = 1.0 - smoothstep(0.04, 0.52, screenUv.x);
  float spatialConfidence = clamp(0.48 + upperCanopy * 0.42 + leftCanopy * 0.14, 0.0, 1.0);
  return smoothstep(0.27, 0.68, signal * spatialConfidence);
}

// A wave term returns height, the two partial derivatives of height, and its
// Laplacian. The derivatives become the 3D normal; curvature helps approximate
// where refracted rays converge into brighter caustic bands.
vec4 waveTerm(
  vec2 point,
  vec2 direction,
  float frequency,
  float speed,
  float amplitude,
  float time
) {
  direction = normalize(direction);
  float phase = dot(point, direction) * frequency + time * speed;
  float sinePhase = sin(phase);
  float cosinePhase = cos(phase);
  float height = sinePhase * amplitude;
  vec2 gradient = direction * cosinePhase * amplitude * frequency;
  float laplacian = -sinePhase * amplitude * frequency * frequency;
  return vec4(height, gradient.x, gradient.y, laplacian);
}

// The water is a real scalar height field rather than a moving 2D texture.
// Several scales travel independently through one prevailing directional flow.
vec4 waterSurface(vec2 point, float time) {
  // The ten sampled source frames show that the dominant trace direction turns
  // by more than 100 degrees over time, while several smaller directions coexist.
  // A slowly meandering flow and independently turning wave families reproduce
  // this without translating the whole photograph like a flat sheet.
  float flowWander = sin(time * 0.17) * 0.18 + sin(time * 0.061 + 1.8) * 0.10;
  vec2 flowDirection = normalize(rotateDirection(vec2(0.92, 0.38), flowWander));
  vec2 domainWarp = vec2(
    sin(point.y * 4.1 + time * 0.23),
    cos(point.x * 3.3 - time * 0.19)
  ) * (0.016 + uMid * 0.010);
  vec2 advected = point + domainWarp - flowDirection * time * (0.030 + uMid * 0.070);

  float broadTurn = sin(time * 0.21 + 0.4) * 0.22;
  float mediumTurn = sin(time * 0.43 - 0.7) * 0.34;
  float fineTurn = sin(time * 0.79 + 2.1) * 0.48;

  // Bright areas in the ten frames expand and contract by roughly sevenfold.
  // These spatial group envelopes make ripple families arrive in patches rather
  // than forcing the whole water plane into one synchronized oscillation.
  float broadGroup = 0.76 + 0.24 * sin(dot(point, vec2(2.2, -1.4)) + time * 0.24);
  float mediumGroup = 0.70 + 0.30 * sin(dot(point, vec2(-3.7, 2.8)) - time * 0.37);
  float fineGroup = 0.64 + 0.36 * sin(dot(point, vec2(6.1, 4.5)) + time * 0.61);

  float broadEnergy = 1.0 + uBass * 1.45 + uVolume * 0.18;
  float mediumEnergy = 1.0 + uMid * 1.35;
  float fineEnergy = 1.0 + uHigh * 1.65;

  vec4 surface = waveTerm(
    advected,
    rotateDirection(vec2(1.0, 0.24), broadTurn),
    8.2,
    0.58 + uBass * 0.88,
    0.0110 * broadEnergy * broadGroup,
    time
  );
  surface += waveTerm(
    advected,
    rotateDirection(vec2(-0.42, 1.0), -broadTurn * 0.72),
    12.7,
    -0.46 - uBass * 0.52,
    0.0062 * broadEnergy * (1.34 - broadGroup * 0.42),
    time
  );
  surface += waveTerm(
    advected,
    rotateDirection(vec2(0.78, -0.62), mediumTurn),
    23.0,
    0.86 + uMid * 1.45,
    0.0038 * mediumEnergy * mediumGroup,
    time
  );
  surface += waveTerm(
    advected,
    rotateDirection(vec2(0.35, 0.94), -mediumTurn * 0.84),
    37.0,
    -1.02 - uMid * 1.18,
    0.0020 * mediumEnergy * (1.28 - mediumGroup * 0.36),
    time
  );
  surface += waveTerm(
    advected,
    rotateDirection(vec2(-0.68, 0.74), fineTurn),
    67.0,
    1.42 + uHigh * 3.4,
    0.00078 * fineEnergy * fineGroup,
    time
  );

  // Musical onsets inject a short traveling packet into the same geometry.
  surface += waveTerm(
    advected,
    flowDirection,
    29.0,
    4.8,
    0.0048 * uOnset,
    time
  );

  // Pointer/touch creates a localized radial height disturbance.
  float imageAspect = uTexResolution.x / max(uTexResolution.y, 1.0);
  vec2 pointerUv = containUv(uPointerPosition);
  vec2 pointerPoint = vec2(
    (pointerUv.x - 0.5) * imageAspect,
    pointerUv.y - 0.5
  );
  float pointerDistance = length(point - pointerPoint);
  float pointerFalloff = exp(-pointerDistance * 8.2) * uPointerEnergy;
  float pointerPhase = pointerDistance * 48.0 - time * 7.2;
  float pointerHeight = sin(pointerPhase) * 0.008 * pointerFalloff;
  vec2 pointerDirection = (point - pointerPoint) / max(pointerDistance, 0.012);
  vec2 pointerGradient = pointerDirection * cos(pointerPhase) * 0.38 * pointerFalloff;
  surface += vec4(pointerHeight, pointerGradient, -pointerHeight * 48.0 * 48.0);

  return surface;
}

vec3 brightContribution(vec2 uv) {
  vec3 sampleColor = texture2D(uTexture, clamp(uv, 0.001, 0.999)).rgb;
  return max(sampleColor - vec3(0.55), vec3(0.0));
}

vec3 darkerColor(vec3 currentColor, vec3 candidateColor) {
  return luminance(candidateColor) < luminance(currentColor) ? candidateColor : currentColor;
}

// Estimate the water hidden beneath a photographed exposure streak by taking
// the darkest nearby water sample. This is used only on bright pixels in the
// lower trace zone; leaves and the upper field retain the original photograph.
vec3 cleanWaterNeighbor(vec2 uv) {
  vec2 wide = 18.0 / max(uTexResolution, vec2(1.0));
  vec2 diagonal = 13.0 / max(uTexResolution, vec2(1.0));
  vec3 cleanColor = texture2D(uTexture, clamp(uv + vec2(wide.x, 0.0), 0.001, 0.999)).rgb;
  cleanColor = darkerColor(cleanColor, texture2D(uTexture, clamp(uv - vec2(wide.x, 0.0), 0.001, 0.999)).rgb);
  cleanColor = darkerColor(cleanColor, texture2D(uTexture, clamp(uv + vec2(0.0, wide.y), 0.001, 0.999)).rgb);
  cleanColor = darkerColor(cleanColor, texture2D(uTexture, clamp(uv - vec2(0.0, wide.y), 0.001, 0.999)).rgb);
  cleanColor = darkerColor(cleanColor, texture2D(uTexture, clamp(uv + diagonal, 0.001, 0.999)).rgb);
  cleanColor = darkerColor(cleanColor, texture2D(uTexture, clamp(uv - diagonal, 0.001, 0.999)).rgb);
  return cleanColor;
}

// The photograph contains both compact glints and exposure-length streaks. A
// small high-pass filter keeps the compact cores/endpoints, so the shader can
// rebuild their trails in the current direction of the simulated water instead
// of merely sliding the original horizontal marks around.
float glintSeed(vec2 uv) {
  uv = clamp(uv, vec2(0.001), vec2(0.999));
  vec2 px = 5.2 / max(uTexResolution, vec2(1.0));
  float center = luminance(texture2D(uTexture, uv).rgb);
  float surround = luminance(texture2D(uTexture, clamp(uv + vec2(px.x, 0.0), 0.001, 0.999)).rgb);
  surround += luminance(texture2D(uTexture, clamp(uv - vec2(px.x, 0.0), 0.001, 0.999)).rgb);
  surround += luminance(texture2D(uTexture, clamp(uv + vec2(0.0, px.y), 0.001, 0.999)).rgb);
  surround += luminance(texture2D(uTexture, clamp(uv - vec2(0.0, px.y), 0.001, 0.999)).rgb);
  surround *= 0.25;

  // A wider luminance ramp gives the generated light a soft penumbra. The
  // local-contrast term still reserves the strongest energy for compact points.
  float brightCore = smoothstep(0.46, 0.94, center);
  float compactPeak = smoothstep(-0.006, 0.135, center - surround);
  return brightCore * mix(0.015, 0.92, compactPeak);
}

// Reconstruct a time-varying exposure trace behind a glint. The successive
// samples curve away from a straight line, which mimics one bright reflection
// being carried through several changing micro-facet orientations.
float glintTrace(vec2 uv, vec2 direction, vec2 perpendicular, float lengthAmount, float bend) {
  float trace = glintSeed(uv) * 1.12;
  trace = max(trace, glintSeed(uv + direction * lengthAmount * 0.10 + perpendicular * bend * 0.10) * 0.98);
  trace = max(trace, glintSeed(uv + direction * lengthAmount * 0.22 + perpendicular * bend * 0.32) * 0.85);
  trace = max(trace, glintSeed(uv + direction * lengthAmount * 0.38 + perpendicular * bend * 0.58) * 0.70);
  trace = max(trace, glintSeed(uv + direction * lengthAmount * 0.57 + perpendicular * bend * 0.78) * 0.53);
  trace = max(trace, glintSeed(uv + direction * lengthAmount * 0.78 + perpendicular * bend * 0.64) * 0.36);
  trace = max(trace, glintSeed(uv + direction * lengthAmount + perpendicular * bend * 0.22) * 0.20);
  return clamp(trace, 0.0, 1.0);
}

void main() {
  vec2 screenUv = vTexCoord;
  vec2 frameUv = containUv(screenUv);
  float frameMask = fullFrameMask(frameUv);
  vec2 localUv = clamp(frameUv, vec2(0.001), vec2(0.999));
  vec2 baseUv = localUv;
  float imageAspect = uTexResolution.x / max(uTexResolution.y, 1.0);

  // Compress wave scale toward the top of the frame and enlarge it toward the
  // viewer. This substitutes a shallow perspective projection for a flat plane.
  float perspectiveScale = mix(1.62, 0.74, smoothstep(0.0, 1.0, localUv.y));
  vec2 metricPoint = vec2((localUv.x - 0.5) * imageAspect, localUv.y - 0.5);
  vec2 planePoint = metricPoint * perspectiveScale;

  float motion = clamp(uMotionScale, 0.0, 1.0);
  float baseLeafMask = foregroundLeafMask(baseUv, localUv);
  float waterPresence = 1.0 - baseLeafMask * 0.90;

  // The current audio frame directly controls water geometry.
  float timeRate = 0.68 + uMid * 0.72 + uHigh * 0.16;
  float waterTime = uTime * timeRate;
  vec4 surface = waterSurface(planePoint, waterTime);
  float height = surface.x;
  vec2 gradient = surface.yz;

  float normalStrength = (1.55 + uDistortion * 0.82) * motion;
  vec3 normal = normalize(vec3(-gradient * normalStrength, 1.0));

  // Pseudo view and sun directions turn the 2D source into a shaded water plane.
  vec3 viewDirection = normalize(vec3(
    (0.5 - localUv.x) * 0.22,
    (0.56 - localUv.y) * 0.30,
    1.0
  ));
  vec3 lightDirection = normalize(vec3(-0.48, -0.30, 0.86));
  vec3 halfDirection = normalize(viewDirection + lightDirection);

  float normalDotView = max(dot(normal, viewDirection), 0.0);
  float normalDotLight = max(dot(normal, lightDirection), 0.0);
  float normalDotHalf = max(dot(normal, halfDirection), 0.0);

  // Schlick Fresnel with water's normal-incidence reflectance (~2%). At shallow
  // viewing angles the reflection strengthens, one of the clearest depth cues.
  float fresnel = 0.0204 + 0.9796 * pow(1.0 - normalDotView, 5.0);
  float artisticFresnel = clamp(0.18 + fresnel * 2.7, 0.18, 0.92);

  // Normal projection provides refraction/reflection lookup. Height adds
  // parallax, so wave crests and troughs do not feel glued to a single plane.
  vec2 normalOffset = normal.xy * (0.0075 + uMid * 0.0045) * uDistortion;
  vec2 heightParallax = height * vec2(-0.11, 0.24) * uDistortion;
  vec2 waterOffset = (normalOffset + heightParallax) * waterPresence * motion;
  waterOffset = clamp(waterOffset, vec2(-0.044), vec2(0.044));
  vec2 reflectionUv = clamp(baseUv + waterOffset, vec2(0.001), vec2(0.999));

  vec3 photographedReflection = texture2D(uTexture, reflectionUv).rgb;
  float sourceLuma = luminance(photographedReflection);
  float lowerTraceZone = smoothstep(0.42, 0.66, localUv.y) * waterPresence;
  float photographedTrace = smoothstep(0.55, 0.91, sourceLuma) * lowerTraceZone;
  vec3 cleanedReflection = cleanWaterNeighbor(reflectionUv);
  vec3 reflected = mix(
    photographedReflection,
    cleanedReflection,
    photographedTrace * 0.78
  );
  vec3 refracted = texture2D(
    uTexture,
    clamp(baseUv - normal.xy * 0.0032 * uDistortion, 0.001, 0.999)
  ).rgb;
  vec3 waterBody = mix(
    vec3(0.108, 0.110, 0.108),
    refracted * vec3(0.745, 0.750, 0.740),
    0.70
  );
  vec3 waterColor = mix(waterBody, reflected, 0.72 + artisticFresnel * 0.25);

  // A neighboring height sample along the light direction gives a cheap crest
  // occlusion term. The moving shadow is therefore tied to wave geometry.
  vec2 lightStep = normalize(lightDirection.xy) * 0.050;
  float upstreamHeight = waterSurface(planePoint + lightStep, waterTime).x;
  float crestOcclusion = smoothstep(0.004, 0.024, upstreamHeight - height);
  float crestShadow = crestOcclusion * (0.08 + uBass * 0.055 + uMid * 0.025);
  float faceShade = mix(0.88, 1.04, normalDotLight);
  waterColor *= faceShade * (1.0 - crestShadow * waterPresence);

  // Curvature approximates convergence of refracted light into caustics.
  float convergence = max(-surface.w, 0.0);
  float caustic = pow(smoothstep(0.45, 5.2, convergence), 1.35);
  caustic *= waterPresence * (0.028 + uMid * 0.052 + uHigh * 0.078);

  // Sharp specular glints and caustics are different consequences of the same
  // normal field, giving the light volume instead of a separate glow animation.
  float roughnessExponent = mix(92.0, 54.0, clamp(uHigh * 0.72, 0.0, 1.0));
  float specular = pow(normalDotHalf, roughnessExponent);
  specular *= (0.075 + uHigh * 0.58 + uOnset * 0.42) * waterPresence;
  vec3 reflectedWhite = vec3(0.965, 0.912, 0.825);
  waterColor += reflectedWhite * (specular + caustic) * uShimmer * motion;

  float sourceHighlight = smoothstep(0.46, 0.91, sourceLuma) * waterPresence;

  // A crest's tangent is perpendicular to the local height gradient. It is the
  // physically meaningful direction in which a point reflection stretches.
  // Re-evaluating it every frame makes the trace turn with the water rather
  // than preserving the direction baked into the source photograph.
  vec2 metricFlow = normalize(vec2(0.92, 0.38));
  vec2 crestTangent = normalize(vec2(-gradient.y, gradient.x) + vec2(0.0001));
  if (dot(crestTangent, metricFlow) < 0.0) crestTangent *= -1.0;
  crestTangent = normalize(mix(crestTangent, metricFlow, 0.11));
  float localTraceTurn = sin(
    waterTime * 0.74 + planePoint.x * 3.2 - planePoint.y * 2.1 + height * 38.0
  );
  crestTangent = rotateDirection(
    crestTangent,
    localTraceTurn * mix(0.12, 0.46, lowerTraceZone)
  );
  vec2 traceDirection = normalize(vec2(crestTangent.x / max(imageAspect, 0.1), crestTangent.y));
  vec2 tracePerpendicular = vec2(-traceDirection.y, traceDirection.x);

  // In the sampled footage, trace length varies by about 12x. A slow local
  // optical cycle supplies the wind-driven baseline; audio energy and onsets
  // then move immediately toward the long-trace states seen in the film.
  float opticalCycle = 0.5 + 0.5 * sin(
    waterTime * 0.54 + dot(planePoint, vec2(3.8, -2.6)) + surface.w * 0.006
  );
  opticalCycle = smoothstep(0.08, 0.92, opticalCycle);
  float traceLength = 0.012 + uAmbient * 0.010;
  traceLength += uVolume * 0.075 + uBass * 0.020 + uMid * 0.045 + uOnset * 0.032;
  traceLength *= mix(0.44, 1.24, opticalCycle);
  traceLength *= mix(1.0, mix(0.34, 1.72, opticalCycle), lowerTraceZone * 0.82);
  traceLength *= mix(0.58, 1.24, clamp(uShimmer * 0.60, 0.0, 1.0));
  float bendPhase = waterTime * 0.82 + dot(planePoint, vec2(5.7, -3.9)) + height * 72.0;
  float traceBend = traceLength * (0.055 + 0.17 * sin(bendPhase));
  vec2 movingGlintUv = clamp(
    reflectionUv + tracePerpendicular * surface.w * 0.000018 * motion,
    vec2(0.001),
    vec2(0.999)
  );
  float dynamicTrace = glintTrace(
    movingGlintUv,
    traceDirection,
    tracePerpendicular,
    traceLength,
    traceBend
  );
  // A highlight exists only while a water facet reflects the light toward the
  // viewer. This normal-alignment window makes points emerge, stretch, soften,
  // and vanish instead of leaving every source highlight continuously visible.
  float facetFocus = pow(max(normalDotHalf, 0.0), 22.0);
  float facetWindow = smoothstep(0.10, 0.72, facetFocus);
  float musicalReveal = clamp(uVolume * 0.62 + uMid * 0.28 + uHigh * 0.22 + uOnset * 0.34, 0.0, 1.0);
  float traceVisibility = mix(0.22 + opticalCycle * 0.26, 1.0, max(facetWindow, musicalReveal));
  traceVisibility *= mix(1.0, smoothstep(0.10, 0.46, opticalCycle), lowerTraceZone * 0.64);
  dynamicTrace *= waterPresence * traceVisibility;

  // Dim a little of the source's baked highlight energy before replacing it
  // with the oriented light layer. The underlying photograph stays legible,
  // while the moving trace becomes the dominant sharp highlight.
  float bakedHighlight = smoothstep(0.66, 0.94, sourceLuma) * waterPresence;
  float sourceRelightState = clamp(facetWindow * 0.72 + opticalCycle * 0.28, 0.0, 1.0);
  float sourceRelight = mix(0.62, 0.98, sourceRelightState);
  waterColor *= mix(1.0, sourceRelight, bakedHighlight * 0.62);
  waterColor *= 1.0 - bakedHighlight * 0.035;
  // The lower exponent expands the low-energy edge without increasing the
  // clipped core. This reads as reflected light in haze rather than a neon bar.
  float softTrace = pow(dynamicTrace, 0.72);
  float traceEnergy = softTrace * uShimmer;
  traceEnergy *= 0.075 + uAmbient * 0.070 + uVolume * 0.29 + uMid * 0.18 + uHigh * 0.11 + uOnset * 0.23;
  traceEnergy *= 1.0 + lowerTraceZone * 0.48;
  waterColor += reflectedWhite * traceEnergy;

  float opticalHighlight = clamp(
    sourceHighlight * 0.42 + specular * 1.72 + caustic * 2.10 + softTrace * 0.72,
    0.0,
    1.0
  );

  // Wavelength-dependent separation is strongest at focused bright edges. The
  // center stays nearly white; only thin opposing warm and cool fringes carry
  // strong color. This avoids the artificial green core caused by leaving the
  // green channel fixed while red and blue moved away from it.
  vec2 dispersionDirection = normal.xy / max(length(normal.xy), 0.055);
  float dispersionDistance = uDispersion * (
    0.00062 + uHigh * 0.00175 + caustic * 0.00125
  );
  dispersionDistance *= opticalHighlight * motion;
  vec2 spectralOffset = dispersionDirection * dispersionDistance;
  vec3 redSample = texture2D(
    uTexture,
    clamp(reflectionUv + spectralOffset, 0.001, 0.999)
  ).rgb;
  vec3 blueSample = texture2D(
    uTexture,
    clamp(reflectionUv - spectralOffset, 0.001, 0.999)
  ).rgb;
  vec3 greenSample = texture2D(
    uTexture,
    clamp(reflectionUv - spectralOffset * 0.08, 0.001, 0.999)
  ).rgb;
  vec3 amberSample = texture2D(
    uTexture,
    clamp(reflectionUv + spectralOffset * 0.46, 0.001, 0.999)
  ).rgb;
  vec3 violetSample = texture2D(
    uTexture,
    clamp(reflectionUv - spectralOffset * 1.58, 0.001, 0.999)
  ).rgb;

  vec3 spectralReflection = vec3(redSample.r, greenSample.g, blueSample.b);
  float spectralLuma = max(luminance(spectralReflection), 0.012);
  spectralReflection *= max(sourceLuma, 0.012) / spectralLuma;
  spectralReflection = mix(vec3(sourceLuma), spectralReflection, 0.58);
  float spectralMix = opticalHighlight * clamp(uDispersion * 0.54, 0.0, 0.74);
  waterColor = mix(waterColor, spectralReflection, spectralMix);

  float warmEdge = max(luminance(redSample) - sourceLuma, 0.0);
  float amberEdge = max(luminance(amberSample) - sourceLuma, 0.0);
  float coolEdge = max(luminance(blueSample) - sourceLuma, 0.0);
  float violetEdge = max(luminance(violetSample) - sourceLuma, 0.0);
  vec3 pairedFringe = warmEdge * vec3(1.0, 0.16, 0.012);
  pairedFringe += amberEdge * vec3(1.0, 0.58, 0.025) * 0.56;
  pairedFringe += coolEdge * vec3(0.025, 0.64, 1.0) * 0.72;
  pairedFringe += violetEdge * vec3(0.34, 0.045, 1.0) * 0.48;
  float fringeStrength = opticalHighlight * uDispersion * (0.42 + uHigh * 0.40);
  waterColor += pairedFringe * fringeStrength;

  // Bloom expands only light already focused by the water geometry.
  vec2 bloomRadius = vec2(4.4 + uHigh * 5.8) / max(uTexResolution, vec2(1.0));
  vec3 bloomLight = brightContribution(reflectionUv + vec2(bloomRadius.x, 0.0));
  bloomLight += brightContribution(reflectionUv - vec2(bloomRadius.x, 0.0));
  bloomLight += brightContribution(reflectionUv + vec2(0.0, bloomRadius.y));
  bloomLight += brightContribution(reflectionUv - vec2(0.0, bloomRadius.y));
  bloomLight *= 0.25;
  float bloomEnergy = uBloom * opticalHighlight * (0.050 + uVolume * 0.16 + uHigh * 0.055);
  waterColor += bloomLight * bloomEnergy;
  waterColor *= vec3(1.006, 1.0, 0.986);
  waterColor *= 0.94 + uVolume * 0.10;

  // Foreground foliage keeps its slower independent wind phase and receives an
  // inertial 175 ms delayed audio envelope from JavaScript.
  float leafTime = uTime;
  float leafWindX = sin(leafTime * 0.61 + localUv.y * 5.4);
  leafWindX += sin(leafTime * 0.29 - localUv.x * 3.7) * 0.42;
  float leafWindY = cos(leafTime * 0.47 + localUv.x * 4.2) * 0.58;
  float leafSwayAmount = 0.00055 + uAmbient * 0.00052;
  leafSwayAmount += uLeafEnergy * 0.00225 + uLeafImpulse * 0.00105;
  vec2 leafOffset = vec2(leafWindX, leafWindY) * leafSwayAmount * motion;
  leafOffset *= 0.62 + baseLeafMask * 0.72;
  vec2 leafUv = clamp(baseUv + leafOffset, vec2(0.001), vec2(0.999));
  vec3 leafColor = texture2D(uTexture, leafUv).rgb;
  float leafMask = foregroundLeafMask(leafUv, localUv);
  float leafBreath = sin(leafTime * 0.83 + localUv.x * 3.1) * uLeafEnergy * 0.018;
  leafColor *= 1.0 + leafBreath;

  vec3 color = mix(waterColor, leafColor, leafMask * 0.94);
  float vignette = 1.0 - smoothstep(0.38, 0.94, length(metricPoint)) * 0.14;
  color *= vignette;

  // A subdued, soft cover image fills the letterboxed area so the complete
  // portrait frame remains visible without leaving harsh empty side bars.
  vec2 backgroundUv = coverUv(screenUv);
  vec2 backgroundBlur = vec2(0.024, 0.016);
  vec3 backdrop = texture2D(uTexture, backgroundUv).rgb * 0.34;
  backdrop += texture2D(uTexture, clamp(backgroundUv + backgroundBlur, 0.001, 0.999)).rgb * 0.165;
  backdrop += texture2D(uTexture, clamp(backgroundUv - backgroundBlur, 0.001, 0.999)).rgb * 0.165;
  backdrop += texture2D(uTexture, clamp(backgroundUv + vec2(-backgroundBlur.x, backgroundBlur.y), 0.001, 0.999)).rgb * 0.165;
  backdrop += texture2D(uTexture, clamp(backgroundUv + vec2(backgroundBlur.x, -backgroundBlur.y), 0.001, 0.999)).rgb * 0.165;
  float backdropLuma = luminance(backdrop);
  backdrop = mix(vec3(backdropLuma), backdrop, 0.28) * 0.31;
  color = mix(backdrop, color, frameMask);

  float grain = hash21(screenUv * uResolution + floor(uTime * 24.0)) - 0.5;
  color += grain * (0.0045 + uHigh * 0.0025) * (1.0 - leafMask * 0.55);
  // A broad highlight shoulder lowers exposure selectively; shadows and leaf
  // depth stay intact while the brightest water reflections roll off gently.
  color = color / (vec3(1.0) + max(color - vec3(0.72), vec3(0.0)) * 0.68);
  gl_FragColor = vec4(max(color, vec3(0.0)), 1.0);
}
