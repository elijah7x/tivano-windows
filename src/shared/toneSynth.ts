// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

/** Frozen ToneSynth — a struck tone rendered to 16-bit mono WAV bytes so
 *  the app's chime ships as a few numbers, not a sound file. */

export interface ToneNote {
  /** Fundamental frequency in Hz. */
  frequency: number;
  /** Start offset in seconds. */
  onset: number;
  /** Ring strength relative to the other notes. */
  level: number;
}

export interface TonePartial {
  /** Frequency as a multiple of the fundamental. */
  multiple: number;
  /** Starting loudness of this sine. */
  level: number;
  /** Seconds for the partial to fall by about two thirds. */
  decay: number;
}

const SAMPLE_RATE = 44_100;
/** Raised-cosine onset: quick enough to feel struck, with no click. */
const ATTACK = 0.006;
/** The tail is inaudible by the end; the fade makes sure it stops without a tick. */
const RELEASE = 0.08;

export function toneWave(
  notes: ToneNote[],
  partials: TonePartial[],
  duration: number,
): Uint8Array {
  const count = Math.floor(SAMPLE_RATE * duration);
  const samples = new Float64Array(count);
  for (const note of notes) {
    const start = Math.floor(note.onset * SAMPLE_RATE);
    for (let index = start; index < count; index++) {
      const time = (index - start) / SAMPLE_RATE;
      const onset = time < ATTACK ? 0.5 - 0.5 * Math.cos((Math.PI * time) / ATTACK) : 1;
      let tone = 0;
      for (const partial of partials) {
        tone +=
          partial.level *
          Math.exp(-time / partial.decay) *
          Math.sin(2 * Math.PI * note.frequency * partial.multiple * time);
      }
      samples[index]! += note.level * onset * tone;
    }
  }
  const fade = Math.floor(RELEASE * SAMPLE_RATE);
  for (let index = count - fade; index < count; index++) {
    samples[index]! *= (count - index) / fade;
  }
  let peak = 0;
  for (const s of samples) peak = Math.max(peak, Math.abs(s));
  const scale = peak > 0 ? 0.9 / peak : 0;

  const data = new Uint8Array(44 + count * 2);
  const view = new DataView(data.buffer);
  data.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  view.setUint32(4, 36 + count * 2, true);
  data.set([0x57, 0x41, 0x56, 0x45], 8); // "WAVE"
  data.set([0x66, 0x6d, 0x74, 0x20], 12); // "fmt "
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 2, true);
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  data.set([0x64, 0x61, 0x74, 0x61], 36); // "data"
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    view.setInt16(44 + i * 2, Math.round(samples[i]! * scale * 32767), true);
  }
  return data;
}

/** Frozen FinishChime — the soft two-note chime that marks a turn
 *  finishing: a rising fifth with a celesta-like tone.
 *  D5 up to A5, the second note a beat later and a touch stronger. */
export const FINISH_CHIME_NOTES: ToneNote[] = [
  { frequency: 587.33, onset: 0, level: 0.8 },
  { frequency: 880, onset: 0.14, level: 1 },
];
/** The fundamental carries the tone; the octave and double octave add a
 *  brief glint at the strike and are gone within a tenth of a second. */
export const FINISH_CHIME_PARTIALS: TonePartial[] = [
  { multiple: 1, level: 1, decay: 0.14 },
  { multiple: 2, level: 0.22, decay: 0.06 },
  { multiple: 4, level: 0.08, decay: 0.04 },
];
export const FINISH_CHIME_DURATION = 0.7;
/** How loud the chime plays relative to the system volume — well under a
 *  stock alert: it registers without cutting into whatever else is playing. */
export const FINISH_CHIME_VOLUME = 0.35;

export function finishChimeWav(): Uint8Array {
  return toneWave(
    FINISH_CHIME_NOTES,
    FINISH_CHIME_PARTIALS,
    FINISH_CHIME_DURATION,
  );
}

/** Frozen SettleChime — the small sound of a server settling into
 *  connected: two soft wooden notes stepping down, quieter and shorter
 *  than the finish chime. E5 down to C5, the second note right behind. */
export const SETTLE_CHIME_NOTES: ToneNote[] = [
  { frequency: 659.26, onset: 0, level: 0.7 },
  { frequency: 523.25, onset: 0.075, level: 1 },
];
/** Woody: the fundamental fades fast, a quiet third harmonic knocks at
 *  the strike, the octave only glints. */
export const SETTLE_CHIME_PARTIALS: TonePartial[] = [
  { multiple: 1, level: 1, decay: 0.075 },
  { multiple: 3, level: 0.16, decay: 0.02 },
  { multiple: 2, level: 0.08, decay: 0.03 },
];
export const SETTLE_CHIME_DURATION = 0.32;
/** Barely there — a tick under the row's motion, not a notification. */
export const SETTLE_CHIME_VOLUME = 0.18;

export function settleChimeWav(): Uint8Array {
  return toneWave(
    SETTLE_CHIME_NOTES,
    SETTLE_CHIME_PARTIALS,
    SETTLE_CHIME_DURATION,
  );
}
