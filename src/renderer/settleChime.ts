// Tivano Windows — derived from Tivano (AGPL-3.0), modified 2026-11-02.
// Droppy Code by Jordy Spruit (Droppy), https://getdroppycode.app

/** Frozen SettleChime — the quiet two-note tick when an MCP server lands
 *  in connected. Unlike the finish chime a replay restarts from the top:
 *  two servers settling in a row tick twice. */
import {
  settleChimeWav,
  SETTLE_CHIME_VOLUME,
} from "../shared/toneSynth";

let audio: HTMLAudioElement | null = null;
let plays = 0;

function chimeAudio(): HTMLAudioElement {
  if (!audio) {
    const wav = settleChimeWav();
    let binary = "";
    for (const b of wav) binary += String.fromCharCode(b);
    audio = new Audio(`data:audio/wav;base64,${btoa(binary)}`);
    audio.volume = SETTLE_CHIME_VOLUME;
  }
  return audio;
}

export function playSettleChime(): void {
  plays += 1;
  // Deterministic observation seam (e2e): the play count is inspectable
  // without guessing at audio output.
  document.documentElement.dataset.settleChimeCount = String(plays);
  const el = chimeAudio();
  el.currentTime = 0;
  void el.play().catch(() => {});
}
