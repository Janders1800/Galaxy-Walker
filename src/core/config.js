// src/core/config.js
export const QUALITY_PRESETS = {
  Potato: {
    pointShadow: 0,
    spotShadow: 512,
    shadowHz: 20,
    atmoScale: 0.45,
    cloudScale: 0.22,
    godRaySamples: 10,
    atmoSteps: 10,
    cloudSteps: 6,
    cloudLightSteps: 2,
    pixelRatioMax: 1.0,
    antialias: false,
  },
  Laptop: {
    pointShadow: 0,
    spotShadow: 1024,
    shadowHz: 24,
    atmoScale: 0.6,
    cloudScale: 0.35,
    godRaySamples: 14,
    atmoSteps: 14,
    cloudSteps: 10,
    cloudLightSteps: 3,
    pixelRatioMax: 1.25,
    antialias: false,
  },
  Descktop: {
    pointShadow: 0,
    spotShadow: 1536,
    shadowHz: 30,
    atmoScale: 0.75,
    cloudScale: 0.45,
    godRaySamples: 18,
    atmoSteps: 16,
    cloudSteps: 12,
    cloudLightSteps: 4,
    pixelRatioMax: 1.5,
    antialias: false,
  },
  GamingPC: {
    pointShadow: 0,
    spotShadow: 2048,
    shadowHz: 35,
    atmoScale: 0.85,
    cloudScale: 0.5,
    godRaySamples: 22,
    atmoSteps: 18,
    cloudSteps: 14,
    cloudLightSteps: 5,
    pixelRatioMax: 2.0,
    antialias: true,
  },
  NASA: {
    pointShadow: 512,
    spotShadow: 4096,
    shadowHz: 60,
    atmoScale: 1.0,
    cloudScale: 0.6,
    godRaySamples: 30,
    atmoSteps: 22,
    cloudSteps: 16,
    cloudLightSteps: 6,
    pixelRatioMax: 2.0,
    antialias: true,
  },
};

// Alias: accept the correct spelling while keeping the historical misspelling.
QUALITY_PRESETS.Desktop = QUALITY_PRESETS.Descktop;

export function getPreset(name) {
  return QUALITY_PRESETS[name] || QUALITY_PRESETS.Desktop || QUALITY_PRESETS.Descktop;
}
