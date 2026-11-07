// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-10-30.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

/** Frozen FinishChime — plays the synthesized two-note chime once per
 *  finish signal. Like NSSound, a chime already in flight declines a
 *  second play, so several threads finishing together make one chime.
 *  The "in flight" window is the chime's own duration — a stalled media
 *  pipeline must not wedge the counter behind `audio.paused`. */
import {
  finishChimeWav,
  FINISH_CHIME_DURATION,
  FINISH_CHIME_VOLUME,
} from "../shared/toneSynth";

let audio: HTMLAudioElement | null = null;
let lastPlayAt = 0;
let plays = 0;

function chimeAudio(): HTMLAudioElement {
  if (!audio) {
    const wav = finishChimeWav();
    let binary = "";
    for (const b of wav) binary += String.fromCharCode(b);
    audio = new Audio(`data:audio/wav;base64,${btoa(binary)}`);
    audio.volume = FINISH_CHIME_VOLUME;
  }
  return audio;
}

export function playFinishChime(): void {
  const now = Date.now();
  if (now - lastPlayAt < FINISH_CHIME_DURATION * 1000) return; // one chime, never a pile-up
  lastPlayAt = now;
  plays += 1;
  // Deterministic observation seam (e2e): the play count is inspectable
  // without guessing at audio output.
  document.documentElement.dataset.chimeCount = String(plays);
  const el = chimeAudio();
  el.currentTime = 0;
  void el.play().catch(() => {});
}
