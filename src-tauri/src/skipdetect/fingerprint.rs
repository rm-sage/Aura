// Aura - (c) 2026 rm-sage. AGPL-3.0-or-later. See LICENSE for full notice.
// SPDX-License-Identifier: AGPL-3.0-or-later

// skipdetect/fingerprint.rs
//
// Haitsma-Kalker style 32-bit audio sub-fingerprints, a port of the research
// harness `skipbench/common.py fingerprint` (the reference every threshold in
// the matcher was tuned against):
//
//   * input: mono s16 PCM at 11025 Hz (what ffmpeg's `aresample=11025 -ac 1`
//     hands us on stdout);
//   * frame 2048 samples, hop 512 (21.533 codes/s), Hann window;
//   * 33 log-spaced bands between 300 and 3000 Hz (geomspace, 34 edges),
//     band energy = ln(1 + sum |X|^2) over the FFT bins inside the band;
//   * bit b of code n = sign of ((E[n,b] - E[n,b+1]) - (E[n-1,b] - E[n-1,b+1]));
//   * a code is VALID only when both of its frames are above -50 dBFS RMS, so
//     digital silence never matches another stretch of silence.
//
// Code i comes from frames i and i+1 and is timed at `t0 + i * 512 / 11025`.
//
// The extractor is STREAMING: PCM is pushed in arbitrary chunks as ffmpeg
// produces it, only the last partial frame is buffered, and the output is
// identical to fingerprinting the whole buffer at once. That is what lets a
// pass consume its PCM incrementally and never retain it (the region keeps
// only codes + the valid mask, about 52 KB for 600 s).
//
// Numerics: the reference runs numpy's float32 FFT; this runs f64, with the
// window and the windowed frame rounded to f32 exactly as numpy does, so the
// only disagreements are codes whose energy difference is within float32
// rounding of zero. Parity is measured by the ignored corpus test
// (>= 99.5% of bits).

use std::sync::Arc;

use realfft::{RealFftPlanner, RealToComplex};

/// Analysis sample rate of every PCM stream in skipdetect.
pub const SR: u32 = 11025;
/// FFT frame length in samples.
pub const FRAME: usize = 2048;
/// Hop between frames in samples.
pub const HOP: usize = 512;
/// Number of log-spaced bands (32 band-pair differences = 32 bits).
pub const NBANDS: usize = 33;
/// Codes per second (11025 / 512 = 21.533203125, exactly representable).
pub const FPS: f64 = SR as f64 / HOP as f64;
/// Frames whose RMS is at or below this are "silent" and mask their codes.
pub const FP_MIN_DB: f64 = -50.0;
const BAND_LO_HZ: f64 = 300.0;
const BAND_HI_HZ: f64 = 3000.0;

/// A run of sub-fingerprints. `codes[i]` is timed at `t0 + i / FPS` seconds.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Fingerprint {
    pub codes: Vec<u32>,
    pub valid: Vec<bool>,
    /// Absolute time (s) of code 0.
    pub t0: f64,
}

impl Fingerprint {
    pub fn len(&self) -> usize {
        self.codes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.codes.is_empty()
    }

    /// Covered duration in seconds (`len / FPS`), the reference's `len(codes) / fps`.
    pub fn duration_s(&self) -> f64 {
        self.codes.len() as f64 / FPS
    }
}

/// numpy `np.hanning(M).astype(np.float32)`: `0.5 + 0.5 cos(pi n / (M - 1))` for
/// `n = 1-M, 3-M, ..., M-1` (numpy's own formulation, kept for bit fidelity).
fn hann_f32(m: usize) -> Vec<f32> {
    let denom = (m - 1) as f64;
    (0..m)
        .map(|k| {
            let n = (2 * k) as f64 + 1.0 - m as f64;
            (0.5 + 0.5 * (std::f64::consts::PI * n / denom).cos()) as f32
        })
        .collect()
}

/// `[lo, hi)` FFT-bin ranges of the 33 bands, as numpy selects them:
/// `freqs >= edges[i] & freqs < edges[i+1]` with `freqs = rfftfreq(2048, 1/11025)`
/// and `edges = geomspace(300, 3000, 34)`.
pub fn band_bins() -> [(usize, usize); NBANDS] {
    // geomspace: 10 ** linspace(log10(lo), log10(hi), 34), endpoints pinned.
    let (a, b) = (BAND_LO_HZ.log10(), BAND_HI_HZ.log10());
    let step = (b - a) / NBANDS as f64;
    let mut edges = [0.0f64; NBANDS + 1];
    for (i, e) in edges.iter_mut().enumerate() {
        *e = 10f64.powf(i as f64 * step + a);
    }
    edges[0] = BAND_LO_HZ;
    edges[NBANDS] = BAND_HI_HZ;
    // rfftfreq: k * (1 / (n * d)).
    let val = 1.0 / (FRAME as f64 * (1.0 / SR as f64));
    let nbins = FRAME / 2 + 1;
    let mut out = [(0usize, 0usize); NBANDS];
    for (i, o) in out.iter_mut().enumerate() {
        let mut lo = None;
        let mut hi = 0;
        for k in 0..nbins {
            let f = k as f64 * val;
            if f >= edges[i] && f < edges[i + 1] {
                if lo.is_none() {
                    lo = Some(k);
                }
                hi = k + 1;
            }
        }
        let lo = lo.unwrap_or(0);
        *o = (lo, hi.max(lo));
    }
    out
}

/// Streaming fingerprint extractor. Push PCM as it arrives; read `fingerprint()`
/// at any time (a prefix of the final answer); `finish()` for the final value.
pub struct Fingerprinter {
    fft: Arc<dyn RealToComplex<f64>>,
    window: Vec<f32>,
    bands: [(usize, usize); NBANDS],
    input: Vec<f64>,
    spectrum: Vec<realfft::num_complex::Complex<f64>>,
    scratch: Vec<realfft::num_complex::Complex<f64>>,
    /// Pending samples; `buf[0]` is absolute sample `buf_start`.
    buf: Vec<i16>,
    buf_start: u64,
    /// Next frame index to compute (frame f starts at sample f * HOP).
    next_frame: u64,
    prev: Option<([f64; NBANDS], bool)>,
    out: Fingerprint,
    samples_in: u64,
}

impl Fingerprinter {
    pub fn new(t0: f64) -> Self {
        let mut planner = RealFftPlanner::<f64>::new();
        let fft = planner.plan_fft_forward(FRAME);
        let input = fft.make_input_vec();
        let spectrum = fft.make_output_vec();
        let scratch = fft.make_scratch_vec();
        Self {
            fft,
            window: hann_f32(FRAME),
            bands: band_bins(),
            input,
            spectrum,
            scratch,
            buf: Vec::with_capacity(FRAME * 4),
            buf_start: 0,
            next_frame: 0,
            prev: None,
            out: Fingerprint { codes: Vec::new(), valid: Vec::new(), t0 },
            samples_in: 0,
        }
    }

    /// Total PCM samples pushed so far.
    pub fn samples(&self) -> u64 {
        self.samples_in
    }

    /// Codes computed so far (a prefix of the final fingerprint).
    pub fn fingerprint(&self) -> &Fingerprint {
        &self.out
    }

    /// Re-time the output (the region origin is read from ffmpeg's first PTS,
    /// which can arrive after the first PCM bytes).
    pub fn set_t0(&mut self, t0: f64) {
        self.out.t0 = t0;
    }

    pub fn push(&mut self, pcm: &[i16]) {
        self.samples_in += pcm.len() as u64;
        self.buf.extend_from_slice(pcm);
        loop {
            let start = self.next_frame * HOP as u64;
            let rel = (start - self.buf_start) as usize;
            if rel + FRAME > self.buf.len() {
                break;
            }
            let (energy, valid) = self.frame(rel);
            if let Some((pe, pv)) = self.prev {
                let mut code = 0u32;
                for b in 0..NBANDS - 1 {
                    let d = (energy[b] - energy[b + 1]) - (pe[b] - pe[b + 1]);
                    if d > 0.0 {
                        code |= 1 << b;
                    }
                }
                self.out.codes.push(code);
                self.out.valid.push(valid && pv);
            }
            self.prev = Some((energy, valid));
            self.next_frame += 1;
        }
        // Drop everything before the next frame's first sample.
        let keep_from = self.next_frame * HOP as u64;
        if keep_from > self.buf_start {
            let drop = ((keep_from - self.buf_start) as usize).min(self.buf.len());
            self.buf.drain(..drop);
            self.buf_start += drop as u64;
        }
    }

    fn frame(&mut self, rel: usize) -> ([f64; NBANDS], bool) {
        let fr = &self.buf[rel..rel + FRAME];
        let mut sq = 0.0f64;
        for (i, (&s, &w)) in fr.iter().zip(self.window.iter()).enumerate() {
            // numpy: float32(pcm) * float32(window), rounded to f32.
            self.input[i] = ((s as f32) * w) as f64;
            let x = s as f64 / 32768.0;
            sq += x * x;
        }
        let rms_db = 20.0 * ((sq / FRAME as f64).sqrt() + 1e-9).log10();
        let valid = rms_db > FP_MIN_DB;
        // A fixed-size transform cannot fail; fall back to an all-zero spectrum
        // (codes 0, masked as silence by the caller's RMS) if it ever does.
        if self
            .fft
            .process_with_scratch(&mut self.input, &mut self.spectrum, &mut self.scratch)
            .is_err()
        {
            return ([0.0; NBANDS], false);
        }
        let mut e = [0.0f64; NBANDS];
        for (b, &(lo, hi)) in self.bands.iter().enumerate() {
            let mut s = 0.0f64;
            for c in &self.spectrum[lo..hi] {
                s += c.re * c.re + c.im * c.im;
            }
            e[b] = s.ln_1p();
        }
        (e, valid)
    }

    /// The final fingerprint. Like the reference, fewer than three frames
    /// (fewer than two codes) yields an empty fingerprint.
    pub fn finish(mut self) -> Fingerprint {
        if self.next_frame <= 2 {
            self.out.codes.clear();
            self.out.valid.clear();
        }
        self.out
    }
}

/// Fingerprint a whole PCM buffer whose first sample is at `t0` seconds.
pub fn fingerprint(pcm: &[i16], t0: f64) -> Fingerprint {
    let mut f = Fingerprinter::new(t0);
    f.push(pcm);
    f.finish()
}

/// First / last time (s) a theme file is above -45 dBFS in 0.05 s RMS windows:
/// where the song is actually audible (`common.py theme_audible`). Values are
/// rounded to the millisecond like the reference. An all-quiet file returns
/// `(0, len / SR)`.
pub fn theme_audible(pcm: &[i16]) -> (f64, f64) {
    const WIN_S: f64 = 0.05;
    const THR_DB: f64 = -45.0;
    let h = (WIN_S * SR as f64).round() as usize; // 551
    let n = pcm.len() / h;
    let mut first = None;
    let mut last = None;
    for w in 0..n {
        let mut sq = 0.0f64;
        for &s in &pcm[w * h..(w + 1) * h] {
            let x = s as f64 / 32768.0;
            sq += x * x;
        }
        let db = 20.0 * ((sq / h as f64).sqrt() + 1e-9).log10();
        if db > THR_DB {
            if first.is_none() {
                first = Some(w);
            }
            last = Some(w);
        }
    }
    match (first, last) {
        (Some(a), Some(b)) => (round_to(a as f64 * WIN_S, 3), round_to((b + 1) as f64 * WIN_S, 3)),
        _ => (0.0, pcm.len() as f64 / SR as f64),
    }
}

/// Python's `round(x, nd)` (correctly rounded on the exact binary value).
pub fn round_to(x: f64, nd: usize) -> f64 {
    if !x.is_finite() {
        return x;
    }
    format!("{:.*}", nd, x).parse::<f64>().unwrap_or(x)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn band_bins_match_numpy() {
        // np.where((rfftfreq(2048, 1/11025) >= e[i]) & (... < e[i+1])) for
        // e = geomspace(300, 3000, 34), measured with numpy 2.5.3.
        const NP: [(usize, usize); NBANDS] = [
            (56, 60), (60, 65), (65, 69), (69, 74), (74, 79), (79, 85), (85, 91), (91, 98),
            (98, 105), (105, 112), (112, 121), (121, 129), (129, 139), (139, 149), (149, 159),
            (159, 171), (171, 183), (183, 196), (196, 210), (210, 225), (225, 242), (242, 259),
            (259, 278), (278, 298), (298, 319), (319, 342), (342, 367), (367, 394), (394, 422),
            (422, 453), (453, 485), (485, 520), (520, 558),
        ];
        assert_eq!(band_bins(), NP);
    }

    fn noise(n: usize, seed: u64, amp: f64) -> Vec<i16> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                let u = ((s >> 33) as f64 / (1u64 << 31) as f64) * 2.0 - 1.0;
                (u * amp) as i16
            })
            .collect()
    }

    #[test]
    fn streaming_equals_batch() {
        let pcm = noise(SR as usize * 7 + 333, 7, 8000.0);
        let whole = fingerprint(&pcm, 1.5);
        let mut f = Fingerprinter::new(1.5);
        let mut i = 0;
        let mut step = 1;
        while i < pcm.len() {
            let j = (i + step).min(pcm.len());
            f.push(&pcm[i..j]);
            i = j;
            step = step * 3 % 4099 + 1;
        }
        let streamed = f.finish();
        assert_eq!(whole, streamed);
        // n = 1 + (len - 2048) // 512 frames, n - 1 codes.
        assert_eq!(whole.len(), (pcm.len() - FRAME) / HOP);
    }

    #[test]
    fn silence_is_masked_and_short_input_is_empty() {
        let fp = fingerprint(&vec![0i16; SR as usize * 2], 0.0);
        assert!(!fp.is_empty());
        assert!(fp.valid.iter().all(|v| !v));
        assert!(fingerprint(&vec![100i16; FRAME + 2 * HOP - 1], 0.0).is_empty());
    }

    #[test]
    fn audible_span() {
        let mut pcm = vec![0i16; SR as usize];
        pcm.extend(noise(SR as usize * 2, 3, 6000.0));
        pcm.extend(vec![0i16; SR as usize]);
        let (lead, trail) = theme_audible(&pcm);
        assert!((lead - 1.0).abs() <= 0.051, "lead {lead}");
        assert!((trail - 3.0).abs() <= 0.051, "trail {trail}");
        assert_eq!(theme_audible(&vec![0i16; 1000]), (0.0, 1000.0 / SR as f64));
    }

    #[test]
    fn python_round() {
        assert_eq!(round_to(1.23456, 3), 1.235);
        assert_eq!(round_to(-0.0904, 2), -0.09);
        assert_eq!(round_to(2.675, 2), 2.67); // binary 2.67499999...
    }
}
